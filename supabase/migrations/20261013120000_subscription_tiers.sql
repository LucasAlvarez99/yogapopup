-- =============================================================================
-- YogaPop Up · Suscripción en 3 niveles
--
--   Nivel 1, 2 y 3: cada uno con nombre, descripción de beneficios y precio mensual (hoy 10 / 20 / 30 €), que la gestión
--   edita desde el panel (Pagos > Planes). PayPal fija el precio en el PLAN, y un plan no cambia de precio para quien ya
--   está suscripto: al cambiar el precio se crea un plan NUEVO en PayPal; las personas que ya pagan siguen con el suyo
--   hasta que cancelen, y las nuevas contratan el plan vigente. Por eso hay dos tablas:
--     subscription_tiers   el nivel y su plan VIGENTE (lo que se muestra y se vende hoy)
--     subscription_plans   historial de planes de PayPal y a qué nivel pertenece cada uno
--
--   Acceso: cada clase restringida dice en QUÉ niveles se puede ver (classes.access_tiers, uno o varios). La suscripción
--   concede el acceso 'all' con su nivel (entitlements.tier); un acceso manual sin nivel (tier null) vale para todos.
--   Las compras de una clase suelta no dependen del nivel.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Niveles y planes
-- -----------------------------------------------------------------------------
create table public.subscription_tiers (
  tier             smallint primary key check (tier between 1 and 3),
  name             text        not null check (char_length(btrim(name)) between 1 and 40),
  benefits         text        not null default '' check (char_length(benefits) <= 400),
  price_cents      integer     not null check (price_cents between 100 and 50000),   -- 1 a 500 €, IVA incluido
  current_plan_id  text        check (current_plan_id is null or char_length(current_plan_id) between 3 and 64),
  -- ¿Se puede contratar? (false hasta que la gestión guarda el nivel y se crea su plan en PayPal)
  plan_ready       boolean     generated always as (current_plan_id is not null) stored,
  updated_at       timestamptz not null default now()
);

create table public.subscription_plans (
  paypal_plan_id  text        primary key check (char_length(paypal_plan_id) between 3 and 64),
  tier            smallint    not null references public.subscription_tiers (tier),
  price_cents     integer     not null check (price_cents between 100 and 50000),
  created_at      timestamptz not null default now()
);

insert into public.subscription_tiers (tier, name, benefits, price_cents) values
  (1, 'Esencial', '', 1000),
  (2, 'Plus',     '', 2000),
  (3, 'Premium',  '', 3000);

alter table public.subscription_tiers enable row level security;
alter table public.subscription_plans enable row level security;

-- Lo que se ofrece es público (se muestra antes de iniciar sesión). El id del plan de PayPal no.
create policy subscription_tiers_select on public.subscription_tiers
  for select to anon, authenticated using (true);
create policy subscription_plans_select_staff on public.subscription_plans
  for select to authenticated using (public.is_staff());

revoke all on public.subscription_tiers, public.subscription_plans from anon, authenticated;
grant select (tier, name, benefits, price_cents, plan_ready) on public.subscription_tiers to anon, authenticated;
grant select on public.subscription_plans to authenticated;
-- Sin INSERT/UPDATE/DELETE para nadie desde el navegador: el precio solo se cambia por la Edge Function paypal-save-tier.

-- -----------------------------------------------------------------------------
-- 2. Nivel en suscripciones, accesos y clases
-- -----------------------------------------------------------------------------
alter table public.subscriptions add column tier smallint references public.subscription_tiers (tier);
alter table public.entitlements  add column tier smallint check (tier is null or tier between 1 and 3);

comment on column public.entitlements.tier is
  'Nivel de la suscripción que concede este acceso. NULL = vale para todos los niveles (accesos manuales).';

alter table public.classes
  add column access_tiers smallint[] not null default '{1,2,3}'
    constraint classes_access_tiers_chk check (access_tiers <@ array[1, 2, 3]::smallint[] and cardinality(access_tiers) >= 1);

comment on column public.classes.access_tiers is
  'Niveles de suscripción que ven esta clase (solo importa si access_level = restricted). Por defecto, los tres.';

grant select (access_tiers) on public.classes to authenticated;
grant insert (access_tiers) on public.classes to authenticated;
grant update (access_tiers) on public.classes to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Regla de acceso (sigue siendo UNA sola: can_access_class + payments_has_class_access la repiten para el backend)
-- -----------------------------------------------------------------------------
create or replace function public.can_access_class(p_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.is_admin()
    or exists (
      select 1
      from public.classes c
      where c.id = p_class_id
        and c.is_published
        and c.video_status = 'ready'
        and auth.uid() is not null
        and (
          c.access_level = 'free'
          or exists (
            select 1 from public.entitlements e
            where e.user_id = auth.uid()
              and (e.expires_at is null or e.expires_at > now())
              and (
                (e.scope = 'all' and (e.tier is null or e.tier = any (c.access_tiers)))
                or (e.scope = 'class' and e.class_id = c.id)
              )
          )
        )
    );
$$;

create or replace function public.payments_has_class_access(p_user uuid, p_class uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.entitlements e
    where e.user_id = p_user
      and (e.expires_at is null or e.expires_at > now())
      and (
        (e.scope = 'all' and (e.tier is null or exists (
           select 1 from public.classes c where c.id = p_class and e.tier = any (c.access_tiers))))
        or (e.scope = 'class' and e.class_id = p_class)
      )
  );
$$;

-- -----------------------------------------------------------------------------
-- 4. Alta y sincronización de suscripciones: ahora guardan el nivel (el del plan; plan desconocido = sin nivel)
-- -----------------------------------------------------------------------------
create or replace function public.payments_start_subscription(p_user uuid, p_paypal_subscription_id text, p_plan_id text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_user is null or not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.subscriptions where user_id = p_user and status in ('active', 'suspended')) then
    raise exception 'already_subscribed' using errcode = '23505';
  end if;
  -- Intentos anteriores que nunca se aprobaron: se descartan para no acumular filas colgadas.
  update public.subscriptions set status = 'cancelled', cancelled_at = now()
   where user_id = p_user and status = 'approval_pending';

  insert into public.subscriptions (user_id, paypal_subscription_id, plan_id, tier)
  values (p_user, p_paypal_subscription_id, p_plan_id,
          (select sp.tier from public.subscription_plans sp where sp.paypal_plan_id = p_plan_id))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.payments_sync_subscription(
  p_paypal_subscription_id text,
  p_user                   uuid,
  p_plan_id                text,
  p_status                 text,
  p_next_billing           timestamptz,
  p_last_payment           timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s     public.subscriptions;
  v_until timestamptz;
  v_tier  smallint := (select sp.tier from public.subscription_plans sp where sp.paypal_plan_id = p_plan_id);
begin
  if p_status not in ('approval_pending', 'active', 'suspended', 'cancelled', 'expired') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  select * into v_s from public.subscriptions where paypal_subscription_id = p_paypal_subscription_id for update;
  if not found then
    if p_user is null or not exists (select 1 from public.profiles where id = p_user) then
      return 'unknown_subscription';
    end if;
    insert into public.subscriptions (user_id, paypal_subscription_id, plan_id, tier)
    values (p_user, p_paypal_subscription_id, p_plan_id, v_tier)
    returning * into v_s;
  end if;

  update public.subscriptions
     set plan_id = p_plan_id,
         tier = coalesce(v_tier, tier),
         status = p_status,
         current_period_end = case when p_status = 'active' and p_next_billing is not null then p_next_billing
                                   else current_period_end end,
         last_payment_at = coalesce(p_last_payment, last_payment_at),
         cancelled_at = case when p_status in ('cancelled', 'expired') then coalesce(cancelled_at, now()) else cancelled_at end
   where id = v_s.id
  returning * into v_s;

  if v_s.user_id is not null then
    if p_status = 'active' then
      v_until := coalesce(p_next_billing, v_s.current_period_end, now()) + interval '2 days';
      insert into public.entitlements (user_id, scope, plan, tier, source, external_ref, expires_at)
      values (v_s.user_id, 'all', p_plan_id, v_s.tier, 'paypal', p_paypal_subscription_id, v_until)
      on conflict (source, external_ref) where source = 'paypal' and external_ref is not null
      do update set expires_at = excluded.expires_at, plan = excluded.plan, tier = excluded.tier;
    elsif p_status in ('cancelled', 'expired') then
      update public.entitlements
         set expires_at = least(coalesce(expires_at, 'infinity'::timestamptz), coalesce(v_s.current_period_end, now()))
       where source = 'paypal' and external_ref = p_paypal_subscription_id;
    end if;
  end if;
  return 'ok';
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Guardar un nivel (solo la Edge Function paypal-save-tier, con la service role)
--    p_plan_id: el plan NUEVO que se acaba de crear en PayPal con este precio, o null si solo cambian nombre/beneficios.
--    Devuelve ok · unknown_tier.
-- -----------------------------------------------------------------------------
create or replace function public.payments_save_tier(
  p_tier        smallint,
  p_name        text,
  p_benefits    text,
  p_price_cents integer,
  p_plan_id     text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.subscription_tiers where tier = p_tier) then
    return 'unknown_tier';
  end if;
  if p_plan_id is not null then
    insert into public.subscription_plans (paypal_plan_id, tier, price_cents)
    values (p_plan_id, p_tier, p_price_cents)
    on conflict (paypal_plan_id) do nothing;
  end if;
  update public.subscription_tiers
     set name = btrim(p_name),
         benefits = btrim(coalesce(p_benefits, '')),
         price_cents = p_price_cents,
         current_plan_id = coalesce(p_plan_id, current_plan_id),
         updated_at = now()
   where tier = p_tier;
  return 'ok';
end;
$$;

revoke execute on function public.payments_save_tier(smallint, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.payments_save_tier(smallint, text, text, integer, text) to service_role;
