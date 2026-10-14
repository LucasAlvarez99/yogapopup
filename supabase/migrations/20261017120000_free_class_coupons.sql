-- =============================================================================
-- YogaPop Up · Cupón mensual de clase virtual gratis (nivel 3)
--
--   Los niveles que dan clases gratis por mes (subscription_tiers.monthly_free_classes: hoy el nivel 3, una al mes) reciben
--   un cupón por mes. Reglas del negocio:
--     * El cupón vale para UNA clase virtual (modo 'virtual' de la agenda) y vence a fin de mes (UTC): lo que no se usa se pierde, no se acumula.
--     * Se emite solo, la primera vez que la persona entra a su cuenta en el mes (claim_my_free_class_coupons, idempotente).
--       Si la gestión sube las clases gratis del nivel a mitad de mes, aparece el cupón que falta; nunca se duplican.
--     * Se canjea al reservar una clase en vivo (redeem_free_class_coupon): la reserva y el canje ocurren juntos o ninguno.
--     * Si la persona cancela esa reserva a tiempo (antes de que empiece), el cupón se devuelve mientras no haya vencido.
--   Hoy reservar una clase en vivo es gratis para todos; el cupón queda registrado en la reserva (live_bookings.coupon_id)
--   para que, cuando las reservas pasen a ser de pago, las que traen cupón no se cobren.
--   Solo las funciones escriben: ninguna persona inserta ni modifica cupones directamente.
-- =============================================================================

create table public.free_class_coupons (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references public.profiles (id) on delete cascade,
  -- Primer día del mes al que pertenece (UTC). Un cupón por persona, mes y lugar (nivel con 2 clases gratis = 2 lugares).
  period       date        not null check (period = date_trunc('month', period)::date),
  slot         smallint    not null default 1 check (slot between 1 and 5),
  expires_at   timestamptz not null,
  redeemed_at  timestamptz,
  session_id   uuid        references public.live_sessions (id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (user_id, period, slot),
  constraint free_class_coupons_redeemed_chk check (redeemed_at is not null or session_id is null)
);
create index free_class_coupons_user_idx on public.free_class_coupons (user_id, period desc);

alter table public.free_class_coupons enable row level security;

create policy free_class_coupons_select on public.free_class_coupons
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_staff());

revoke all on public.free_class_coupons from anon, authenticated;
grant select on public.free_class_coupons to authenticated;

alter table public.live_bookings
  add column coupon_id uuid references public.free_class_coupons (id) on delete set null;

comment on column public.live_bookings.coupon_id is
  'Cupón de clase gratis con el que se hizo la reserva (NULL = reserva común).';

-- -----------------------------------------------------------------------------
-- Emisión: los cupones del mes de quien llama, según su suscripción vigente. Devuelve cuántos creó (0 si ya estaban).
-- -----------------------------------------------------------------------------
create or replace function public.claim_my_free_class_coupons()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n       integer;
  v_period  date := date_trunc('month', now() at time zone 'utc')::date;
  v_expires timestamptz := (date_trunc('month', now() at time zone 'utc') + interval '1 month') at time zone 'utc';
  v_slot    integer;
  v_created integer := 0;
begin
  if auth.uid() is null then
    raise exception 'login required' using errcode = '42501';
  end if;

  -- El nivel más generoso de sus suscripciones con acceso vigente (la gracia y el período pagado cuentan igual que el acceso).
  select coalesce(max(t.monthly_free_classes), 0) into v_n
    from public.entitlements e
    join public.subscription_tiers t on t.tier = e.tier
   where e.user_id = auth.uid()
     and e.scope = 'all'
     and e.tier is not null
     and (e.expires_at is null or e.expires_at > now());

  for v_slot in 1..v_n loop
    insert into public.free_class_coupons (user_id, period, slot, expires_at)
    values (auth.uid(), v_period, v_slot, v_expires)
    on conflict (user_id, period, slot) do nothing;
    if found then
      v_created := v_created + 1;
    end if;
  end loop;
  return v_created;
end;
$$;

-- -----------------------------------------------------------------------------
-- Canje: reserva la clase en vivo y gasta el cupón en la misma transacción.
--   Errores: login required 42501 · coupon unavailable P0002 (no es tuyo, ya usado o vencido) · session not virtual 22023 ·
--            already booked 23505 · y los de book_live_session (session not found, session already started, session full).
-- -----------------------------------------------------------------------------
create or replace function public.redeem_free_class_coupon(p_coupon uuid, p_session uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.free_class_coupons;
begin
  if auth.uid() is null then
    raise exception 'login required' using errcode = '42501';
  end if;

  select * into c from public.free_class_coupons where id = p_coupon and user_id = auth.uid() for update;
  if not found or c.redeemed_at is not null or c.expires_at <= now() then
    raise exception 'coupon unavailable' using errcode = 'P0002';
  end if;

  -- El cupón es de clase VIRTUAL: una clase en vivo presencial no se puede pagar con él.
  if not exists (select 1 from public.live_sessions where id = p_session and mode = 'virtual') then
    if exists (select 1 from public.live_sessions where id = p_session) then
      raise exception 'session not virtual' using errcode = '22023';
    end if;
    raise exception 'session not found' using errcode = 'P0002';
  end if;

  -- Si ya estaba anotada en esa clase, no se gasta el cupón.
  if public.book_live_session(p_session) = 'already_booked' then
    raise exception 'already booked' using errcode = '23505';
  end if;

  update public.live_bookings set coupon_id = c.id where session_id = p_session and user_id = auth.uid();
  update public.free_class_coupons set redeemed_at = now(), session_id = p_session where id = c.id;
  return 'booked';
end;
$$;

-- -----------------------------------------------------------------------------
-- Cancelar una reserva (solo antes de que empiece): si se hizo con cupón, el cupón se devuelve (si no venció).
-- -----------------------------------------------------------------------------
create or replace function public.cancel_live_booking(p_session uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_coupon uuid;
begin
  if auth.uid() is null then
    raise exception 'login required' using errcode = '42501';
  end if;
  delete from public.live_bookings b
  using public.live_sessions s
  where b.session_id = p_session and b.user_id = auth.uid()
    and s.id = b.session_id and s.starts_at > now()
  returning b.coupon_id into v_coupon;

  if v_coupon is not null then
    update public.free_class_coupons set redeemed_at = null, session_id = null
     where id = v_coupon and user_id = auth.uid();
  end if;
end;
$$;

revoke execute on function public.claim_my_free_class_coupons(), public.redeem_free_class_coupon(uuid, uuid) from public, anon;
grant execute on function public.claim_my_free_class_coupons(), public.redeem_free_class_coupon(uuid, uuid) to authenticated;
