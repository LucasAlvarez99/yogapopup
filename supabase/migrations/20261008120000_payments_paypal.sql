-- =============================================================================
-- YogaPop Up · Fases 17-22 · Pagos con PayPal: modelo de datos y reglas atómicas
--
--   orders / order_items   compras puntuales: tienda (productos físicos) o una clase suelta (digital).
--                          Un pedido es de UN solo tipo: nunca se mezcla un producto físico con una clase.
--   subscriptions          suscripciones de PayPal (una fila por suscripción de PayPal).
--   entitlements           (ya existía) la compra de una clase crea scope='class'; la suscripción, scope='all',
--                          ambos con source='paypal'. Es lo único que abre el contenido restringido.
--   payment_events         registro de eventos del webhook de PayPal (idempotencia: un evento = una fila).
--
-- Principios (los mismos de todo el proyecto):
--   * Solo el BACKEND escribe. Los clientes solo LEEN lo suyo (RLS); ningún INSERT/UPDATE/DELETE desde el navegador.
--   * Todas las reglas que mueven dinero, stock o accesos viven acá, en funciones atómicas ejecutables SOLO por la
--     service role. Las Edge Functions (a) verifican contra la API de PayPal y (b) llaman a estas funciones.
--   * Todo es idempotente: reintentar una llamada (o recibir dos veces el mismo webhook) no duplica pedidos, stock
--     descontado, accesos ni reembolsos.
--   * El precio SIEMPRE sale de la base, nunca del navegador. Los precios incluyen IVA (products.tax_rate_bps).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Precio de una clase suelta
--    price_cents NULL = la clase no se vende suelta (solo por suscripción o gratis). Solo se puede comprar una clase
--    con access_level = 'restricted': una clase gratuita no se cobra.
-- -----------------------------------------------------------------------------
alter table public.classes
  add column price_cents integer
    constraint classes_price_cents_chk check (price_cents is null or price_cents between 1 and 10000000),
  add column tax_rate_bps integer not null default 2100
    constraint classes_tax_rate_bps_chk check (tax_rate_bps between 0 and 2500);

comment on column public.classes.price_cents is
  'Precio de la clase suelta en céntimos de euro, IVA incluido. NULL = no se vende suelta.';
comment on column public.classes.tax_rate_bps is
  'IVA incluido en price_cents, en puntos básicos (2100 = 21 %). Confirmar con la gestoría (servicios digitales).';

-- Lectura pública (el catálogo muestra "Comprar por X €") y edición por el personal de gestión (la RLS de
-- classes ya limita el UPDATE a is_staff()).
grant select (price_cents, tax_rate_bps) on public.classes to anon, authenticated;
grant update (price_cents, tax_rate_bps) on public.classes to authenticated;

create or replace function public.classes_audit_price_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.price_cents is distinct from new.price_cents or old.tax_rate_bps is distinct from new.tax_rate_bps then
    insert into public.audit_log (actor_id, actor_role, action, entity_type, entity_id, details)
    values (
      auth.uid(),
      (select p.role from public.profiles p where p.id = auth.uid()),
      'class.price_change', 'class', new.id::text,
      jsonb_build_object('title', new.title, 'price_from', old.price_cents, 'price_to', new.price_cents,
                         'tax_from', old.tax_rate_bps, 'tax_to', new.tax_rate_bps)
    );
  end if;
  return new;
end;
$$;

create trigger classes_audit_price_change
  after update of price_cents, tax_rate_bps on public.classes
  for each row execute function public.classes_audit_price_change();

revoke execute on function public.classes_audit_price_change() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. Un acceso de PayPal es único por su referencia externa (pedido o suscripción): reintentar no lo duplica.
-- -----------------------------------------------------------------------------
create unique index entitlements_paypal_ref_key
  on public.entitlements (source, external_ref)
  where source = 'paypal' and external_ref is not null;

-- -----------------------------------------------------------------------------
-- 3. Pedidos
--    created    el pedido existe y (si es de tienda) el stock está RESERVADO; todavía no se pagó.
--    pending    PayPal tomó el pedido pero el cobro aún no está liquidado (PENDING): esperando confirmación.
--    paid       cobrado y verificado contra PayPal.
--    failed     el cobro falló o fue rechazado. cancelled: se abandonó o venció.  (ambos liberan el stock)
--    refunded   reembolsado por completo (un reembolso parcial deja el pedido en 'paid' y suma refunded_cents).
--    needs_review: algo no cuadra (monto distinto, pago tardío sin stock...) y una persona tiene que mirarlo.
-- -----------------------------------------------------------------------------
create table public.orders (
  id                 uuid        primary key default gen_random_uuid(),
  -- Referencia al perfil (1 a 1 con auth.users) para que el panel pueda mostrar el nombre. Si la cuenta se borra,
  -- el pedido se conserva (contabilidad) sin usuario.
  user_id            uuid        references public.profiles (id) on delete set null,
  kind               text        not null check (kind in ('shop', 'class')),
  status             text        not null default 'created'
                                 check (status in ('created', 'pending', 'paid', 'failed', 'cancelled', 'refunded')),
  currency           text        not null default 'EUR' check (currency = 'EUR'),
  total_cents        integer     not null check (total_cents > 0 and total_cents <= 10000000),
  tax_cents          integer     not null default 0 check (tax_cents >= 0),
  refunded_cents     integer     not null default 0 check (refunded_cents >= 0 and refunded_cents <= total_cents),
  refund_ids         text[]      not null default '{}',
  stock_reserved     boolean     not null default false,
  needs_review       boolean     not null default false,
  review_note        text        check (review_note is null or char_length(review_note) <= 300),
  failure_reason     text        check (failure_reason is null or char_length(failure_reason) <= 300),
  paypal_order_id    text        unique check (paypal_order_id is null or char_length(paypal_order_id) between 5 and 64),
  paypal_capture_id  text        unique check (paypal_capture_id is null or char_length(paypal_capture_id) between 5 and 64),
  paypal_payer_id    text        check (paypal_payer_id is null or char_length(paypal_payer_id) <= 64),
  paypal_status      text        check (paypal_status is null or char_length(paypal_status) <= 40),
  -- Dirección de envío que PayPal devuelve al cobrar (solo pedidos físicos). Dato personal: ver la política de privacidad.
  shipping           jsonb       check (shipping is null or pg_column_size(shipping) < 4096),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  paid_at            timestamptz,
  cancelled_at       timestamptz,
  refunded_at        timestamptz
);

create index orders_user_idx    on public.orders (user_id, created_at desc);
create index orders_status_idx  on public.orders (status, created_at);
create index orders_review_idx  on public.orders (created_at desc) where needs_review;

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

-- Líneas del pedido: guardan una COPIA del título, talle y precio del momento (el catálogo puede cambiar después).
create table public.order_items (
  id            uuid    primary key default gen_random_uuid(),
  order_id      uuid    not null references public.orders (id) on delete cascade,
  item_type     text    not null check (item_type in ('product', 'class')),
  product_id    uuid    references public.products (id) on delete set null,
  variant_id    uuid    references public.product_variants (id) on delete set null,
  class_id      uuid    references public.classes (id) on delete set null,
  title         text    not null check (char_length(title) between 1 and 150),
  size          text    check (size is null or char_length(size) <= 20),
  unit_cents    integer not null check (unit_cents > 0),
  tax_rate_bps  integer not null check (tax_rate_bps between 0 and 2500),
  qty           integer not null check (qty between 1 and 10)
);

create index order_items_order_idx on public.order_items (order_id);

-- -----------------------------------------------------------------------------
-- 4. Suscripciones
--    current_period_end = hasta cuándo está PAGADA (la próxima fecha de cobro que informa PayPal). Es lo que decide
--    cuándo se corta el acceso al cancelar: no se corta al cancelar, sino cuando vence lo ya pagado.
-- -----------------------------------------------------------------------------
create table public.subscriptions (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        references public.profiles (id) on delete set null,
  paypal_subscription_id   text        not null unique check (char_length(paypal_subscription_id) between 5 and 64),
  plan_id                  text        not null check (char_length(plan_id) between 3 and 64),
  status                   text        not null default 'approval_pending'
                                       check (status in ('approval_pending', 'active', 'suspended', 'cancelled', 'expired')),
  current_period_end       timestamptz,
  last_payment_at          timestamptz,
  cancelled_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- Una persona no puede tener dos suscripciones vivas a la vez.
create unique index subscriptions_one_live_per_user
  on public.subscriptions (user_id) where status in ('active', 'suspended');
create index subscriptions_user_idx   on public.subscriptions (user_id, created_at desc);
create index subscriptions_status_idx on public.subscriptions (status, created_at);

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 5. Eventos del webhook (idempotencia y rastro). Se guarda un RESUMEN (ids, estado, monto), no el cuerpo completo:
--    el cuerpo de PayPal trae datos personales (correo, dirección) que acá no hacen falta.
-- -----------------------------------------------------------------------------
create table public.payment_events (
  id             bigint      generated always as identity primary key,
  event_id       text        not null unique check (char_length(event_id) between 3 and 100),
  event_type     text        not null check (char_length(event_type) between 3 and 100),
  resource_type  text        check (resource_type is null or char_length(resource_type) <= 60),
  resource_id    text        check (resource_id is null or char_length(resource_id) <= 100),
  summary        jsonb       not null default '{}'::jsonb check (pg_column_size(summary) < 8192),
  status         text        not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed')),
  attempts       integer     not null default 1,
  error          text        check (error is null or char_length(error) <= 500),
  received_at    timestamptz not null default now(),
  processed_at   timestamptz
);

create index payment_events_received_idx on public.payment_events (received_at desc);
create index payment_events_failed_idx   on public.payment_events (received_at desc) where status = 'failed';

-- -----------------------------------------------------------------------------
-- 6. RLS y privilegios (deny by default; solo lectura de lo propio)
-- -----------------------------------------------------------------------------
alter table public.orders          enable row level security;
alter table public.order_items     enable row level security;
alter table public.subscriptions   enable row level security;
alter table public.payment_events  enable row level security;

create policy orders_select_own on public.orders
  for select to authenticated using (user_id = (select auth.uid()));
create policy orders_select_staff on public.orders
  for select to authenticated using (public.is_staff());

create policy order_items_select_own on public.order_items
  for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and o.user_id = (select auth.uid())));
create policy order_items_select_staff on public.order_items
  for select to authenticated using (public.is_staff());

create policy subscriptions_select_own on public.subscriptions
  for select to authenticated using (user_id = (select auth.uid()));
create policy subscriptions_select_staff on public.subscriptions
  for select to authenticated using (public.is_staff());

-- El registro técnico de eventos lo ve solo el desarrollador.
create policy payment_events_select_developer on public.payment_events
  for select to authenticated using (public.is_developer());

revoke all on public.orders, public.order_items, public.subscriptions, public.payment_events from anon, authenticated;
grant select on public.orders, public.order_items, public.subscriptions, public.payment_events to authenticated;

-- -----------------------------------------------------------------------------
-- 7. Reglas atómicas (solo service_role). Todas bloquean la fila del pedido (FOR UPDATE) para que dos llamadas
--    simultáneas (el navegador y el webhook, por ejemplo) no se pisen.
-- -----------------------------------------------------------------------------

-- 7.1 ¿Tiene la persona acceso vigente a esta clase por un entitlement?
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
      and (e.scope = 'all' or (e.scope = 'class' and e.class_id = p_class))
  );
$$;

-- 7.2 Libera el stock reservado de un pedido y lo cierra como 'failed' o 'cancelled'. Idempotente: solo actúa si
--     el pedido sigue sin pagar. Devuelve true si cambió algo.
create or replace function public.payments_release_order(p_order uuid, p_new_status text, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_o public.orders;
  v_i record;
begin
  if p_new_status not in ('failed', 'cancelled') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  select * into v_o from public.orders where id = p_order for update;
  if not found or v_o.status not in ('created', 'pending') then
    return false;
  end if;

  if v_o.stock_reserved then
    for v_i in select * from public.order_items where order_id = p_order and item_type = 'product' loop
      if v_i.variant_id is not null then
        update public.product_variants set stock = stock + v_i.qty where id = v_i.variant_id and stock is not null;
      elsif v_i.product_id is not null and v_i.size is null then
        update public.products set stock = stock + v_i.qty where id = v_i.product_id and stock is not null;
      end if;
    end loop;
  end if;

  update public.orders
     set status = p_new_status,
         stock_reserved = false,
         failure_reason = left(p_reason, 300),
         cancelled_at = case when p_new_status = 'cancelled' then now() else cancelled_at end
   where id = p_order;
  return true;
end;
$$;

-- 7.3 Vuelve a reservar el stock de un pedido que ya se había liberado (pago tardío). true = había stock para todo.
create or replace function public.payments_reserve_stock(p_order uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_i record;
  v_stock integer;
begin
  -- 1) comprobar TODO antes de descontar nada
  for v_i in select * from public.order_items where order_id = p_order and item_type = 'product' loop
    if v_i.variant_id is not null then
      select stock into v_stock from public.product_variants where id = v_i.variant_id for update;
    elsif v_i.product_id is not null and v_i.size is null then
      select stock into v_stock from public.products where id = v_i.product_id for update;
    else
      return false; -- el producto o el talle ya no existen
    end if;
    if not found then return false; end if;
    if v_stock is not null and v_stock < v_i.qty then return false; end if;
  end loop;
  -- 2) descontar
  for v_i in select * from public.order_items where order_id = p_order and item_type = 'product' loop
    if v_i.variant_id is not null then
      update public.product_variants set stock = stock - v_i.qty where id = v_i.variant_id and stock is not null;
    else
      update public.products set stock = stock - v_i.qty where id = v_i.product_id and stock is not null;
    end if;
  end loop;
  return true;
end;
$$;

-- 7.4 Crea un pedido a partir del carrito, con los precios y el stock DE LA BASE.
--     p_items: [{"type":"product","id":"<uuid>","variant_id":"<uuid>|null","qty":2}, ...]   (tienda)
--           o  [{"type":"class","id":"<uuid>"}]                                              (una clase suelta)
--     Errores (el mensaje es el código estable que usa la API):
--       user_not_found P0002 · invalid_cart 22023 · size_required 22023 · product_unavailable P0002 ·
--       class_unavailable P0002 · insufficient_stock 23514 · already_owned 23505 · too_many_orders 54000
create or replace function public.payments_create_order(p_user uuid, p_items jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_elem     jsonb;
  v_type     text;
  v_products integer := 0;
  v_classes  integer := 0;
  v_kind     text;
  v_row      record;
  v_prod     public.products;
  v_var      public.product_variants;
  v_cls      public.classes;
  v_open     record;
  v_lines    jsonb := '[]'::jsonb;
  v_total    bigint := 0;
  v_tax      bigint := 0;
  v_line     bigint;
  v_order    uuid;
  v_has_var  boolean;
begin
  if p_user is null or not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 30 then
    raise exception 'invalid_cart' using errcode = '22023';
  end if;

  -- Validar la FORMA del carrito antes de tocar nada.
  for v_elem in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_elem) is distinct from 'object' then
      raise exception 'invalid_cart' using errcode = '22023';
    end if;
    v_type := v_elem ->> 'type';
    if v_type = 'product' then
      v_products := v_products + 1;
      if jsonb_typeof(v_elem -> 'qty') is distinct from 'number'
         or (v_elem ->> 'qty')::numeric <> trunc((v_elem ->> 'qty')::numeric)
         or (v_elem ->> 'qty')::numeric not between 1 and 10 then
        raise exception 'invalid_cart' using errcode = '22023';
      end if;
    elsif v_type = 'class' then
      v_classes := v_classes + 1;
    else
      raise exception 'invalid_cart' using errcode = '22023';
    end if;
    if jsonb_typeof(v_elem -> 'id') is distinct from 'string' then
      raise exception 'invalid_cart' using errcode = '22023';
    end if;
  end loop;
  -- Un pedido es de un solo tipo: o productos físicos, o UNA clase.
  if (v_products > 0 and v_classes > 0) or v_classes > 1 then
    raise exception 'invalid_cart' using errcode = '22023';
  end if;
  v_kind := case when v_classes = 1 then 'class' else 'shop' end;

  -- Un intento nuevo reemplaza a los anteriores sin pagar de la misma persona (si no, su propio pedido abandonado
  -- le seguiría reteniendo el stock). Si algún pago de esos llegara igual, entra por el camino de "pago tardío".
  for v_open in select id from public.orders where user_id = p_user and status = 'created' order by created_at loop
    perform public.payments_release_order(v_open.id, 'cancelled', 'superseded');
  end loop;
  if (select count(*) from public.orders where user_id = p_user and created_at > now() - interval '10 minutes') >= 10 then
    raise exception 'too_many_orders' using errcode = '54000';
  end if;

  if v_kind = 'class' then
    select * into v_cls from public.classes
     where id = ((select value from jsonb_array_elements(p_items) limit 1) ->> 'id')::uuid
       and is_published and video_status = 'ready' and access_level = 'restricted' and price_cents is not null;
    if not found then
      raise exception 'class_unavailable' using errcode = 'P0002';
    end if;
    if public.payments_has_class_access(p_user, v_cls.id) then
      raise exception 'already_owned' using errcode = '23505';
    end if;
    v_lines := jsonb_build_array(jsonb_build_object(
      'item_type', 'class', 'class_id', v_cls.id, 'title', v_cls.title, 'unit_cents', v_cls.price_cents,
      'tax_rate_bps', v_cls.tax_rate_bps, 'qty', 1));
    v_total := v_cls.price_cents;
    v_tax := round(v_total::numeric * v_cls.tax_rate_bps / (10000 + v_cls.tax_rate_bps));
  else
    -- Mismo producto y talle repetidos se suman (tope por línea: 10, igual que el carrito).
    for v_row in
      select (e ->> 'id')::uuid as pid, nullif(e ->> 'variant_id', '')::uuid as vid, sum((e ->> 'qty')::integer)::integer as qty
        from jsonb_array_elements(p_items) e
       group by 1, 2
       order by 1, 2
    loop
      if v_row.qty > 10 then
        raise exception 'invalid_cart' using errcode = '22023';
      end if;

      select * into v_prod from public.products where id = v_row.pid and is_active for update;
      if not found or v_prod.price_cents <= 0 then
        raise exception 'product_unavailable' using errcode = 'P0002';
      end if;
      v_has_var := exists (select 1 from public.product_variants where product_id = v_prod.id);

      if v_has_var then
        if v_row.vid is null then
          raise exception 'size_required' using errcode = '22023';
        end if;
        select * into v_var from public.product_variants where id = v_row.vid and product_id = v_prod.id for update;
        if not found then
          raise exception 'product_unavailable' using errcode = 'P0002';
        end if;
        if v_var.stock is not null then
          if v_var.stock < v_row.qty then
            raise exception 'insufficient_stock' using errcode = '23514';
          end if;
          update public.product_variants set stock = stock - v_row.qty where id = v_var.id;
        end if;
      else
        if v_row.vid is not null then
          raise exception 'product_unavailable' using errcode = 'P0002';
        end if;
        if v_prod.stock is not null then
          if v_prod.stock < v_row.qty then
            raise exception 'insufficient_stock' using errcode = '23514';
          end if;
          update public.products set stock = stock - v_row.qty where id = v_prod.id;
        end if;
      end if;

      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'item_type', 'product', 'product_id', v_prod.id, 'variant_id', case when v_has_var then v_var.id end,
        'title', v_prod.title, 'size', case when v_has_var then v_var.size end,
        'unit_cents', v_prod.price_cents, 'tax_rate_bps', v_prod.tax_rate_bps, 'qty', v_row.qty));
      v_line := v_prod.price_cents::bigint * v_row.qty;
      v_total := v_total + v_line;
      v_tax := v_tax + round(v_line::numeric * v_prod.tax_rate_bps / (10000 + v_prod.tax_rate_bps));
    end loop;
  end if;

  if v_total < 1 or v_total > 10000000 then
    raise exception 'invalid_cart' using errcode = '22023';
  end if;

  insert into public.orders (user_id, kind, total_cents, tax_cents, stock_reserved)
  values (p_user, v_kind, v_total, v_tax, v_kind = 'shop')
  returning id into v_order;

  insert into public.order_items (order_id, item_type, product_id, variant_id, class_id, title, size, unit_cents, tax_rate_bps, qty)
  select v_order, l ->> 'item_type', (l ->> 'product_id')::uuid, (l ->> 'variant_id')::uuid, (l ->> 'class_id')::uuid,
         l ->> 'title', l ->> 'size', (l ->> 'unit_cents')::integer, (l ->> 'tax_rate_bps')::integer, (l ->> 'qty')::integer
    from jsonb_array_elements(v_lines) l;

  return v_order;
end;
$$;

-- 7.5 Registra el pago de un pedido YA verificado contra PayPal (la Edge Function consultó la API; esto nunca recibe
--     datos del navegador). Devuelve: paid · already_paid · pending · mismatch · not_found.
create or replace function public.payments_mark_paid(
  p_order          uuid,
  p_capture_id     text,
  p_amount_cents   integer,
  p_currency       text,
  p_payer_id       text,
  p_shipping       jsonb,
  p_paypal_status  text,
  p_capture_status text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_o        public.orders;
  v_note     text;
  v_reserved boolean;
begin
  select * into v_o from public.orders where id = p_order for update;
  if not found then
    return 'not_found';
  end if;
  if v_o.status in ('paid', 'refunded') then
    return 'already_paid';
  end if;

  -- El monto y la moneda cobrados tienen que ser EXACTAMENTE los del pedido. Si no, no se da nada por pagado.
  if p_currency is distinct from v_o.currency or p_amount_cents is distinct from v_o.total_cents then
    update public.orders set needs_review = true, review_note = 'amount_mismatch', paypal_status = left(p_paypal_status, 40)
     where id = p_order;
    return 'mismatch';
  end if;

  if p_capture_status is distinct from 'COMPLETED' then
    update public.orders
       set status = 'pending', paypal_capture_id = coalesce(p_capture_id, paypal_capture_id),
           paypal_payer_id = coalesce(p_payer_id, paypal_payer_id), paypal_status = left(p_paypal_status, 40)
     where id = p_order;
    return 'pending';
  end if;

  v_reserved := v_o.stock_reserved;
  -- Pago tardío: el stock ya se había liberado (pedido cancelado o vencido). Se intenta reservarlo de nuevo; si no
  -- alcanza, igual se registra el pago (el dinero ya se cobró) y se marca para revisión (devolver o conseguir el producto).
  if v_o.kind = 'shop' and v_o.status in ('failed', 'cancelled') and not v_o.stock_reserved then
    v_reserved := public.payments_reserve_stock(p_order);
    if not v_reserved then
      v_note := 'paid_without_stock';
    end if;
  end if;

  update public.orders
     set status = 'paid', paid_at = now(), failure_reason = null, cancelled_at = null,
         stock_reserved = v_reserved,
         paypal_capture_id = coalesce(p_capture_id, paypal_capture_id),
         paypal_payer_id = coalesce(p_payer_id, paypal_payer_id),
         paypal_status = left(p_paypal_status, 40),
         shipping = coalesce(p_shipping, shipping),
         needs_review = needs_review or v_note is not null,
         review_note = coalesce(v_note, review_note)
   where id = p_order;

  -- Pedido digital: el acceso a la clase se concede acá, en la misma transacción que el pago.
  if v_o.kind = 'class' and v_o.user_id is not null then
    insert into public.entitlements (user_id, scope, class_id, source, external_ref)
    select v_o.user_id, 'class', i.class_id, 'paypal', v_o.id::text
      from public.order_items i
     where i.order_id = v_o.id and i.class_id is not null
    on conflict (source, external_ref) where source = 'paypal' and external_ref is not null do nothing;
  end if;

  return 'paid';
end;
$$;

-- 7.6 Aplica un reembolso (o contracargo) ya verificado. Idempotente por id de reembolso. Un reembolso total de una
--     clase quita el acceso; uno de productos NO repone stock solo (depende de si el producto vuelve).
--     Devuelve: applied · duplicate · not_found · not_paid.
create or replace function public.payments_apply_refund(p_order uuid, p_refund_id text, p_amount_cents integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_o   public.orders;
  v_new integer;
begin
  if p_refund_id is null or char_length(p_refund_id) not between 3 and 100 then
    raise exception 'invalid_refund' using errcode = '22023';
  end if;
  select * into v_o from public.orders where id = p_order for update;
  if not found then
    return 'not_found';
  end if;
  if v_o.status not in ('paid', 'refunded') then
    return 'not_paid';
  end if;
  if p_refund_id = any (v_o.refund_ids) then
    return 'duplicate';
  end if;

  v_new := least(v_o.total_cents, v_o.refunded_cents + greatest(coalesce(p_amount_cents, 0), 0));
  update public.orders
     set refund_ids = refund_ids || p_refund_id,
         refunded_cents = v_new,
         status = case when v_new >= total_cents then 'refunded' else status end,
         refunded_at = case when v_new >= total_cents then now() else refunded_at end
   where id = p_order;

  if v_new >= v_o.total_cents and v_o.kind = 'class' then
    delete from public.entitlements where source = 'paypal' and external_ref = p_order::text;
  end if;
  return 'applied';
end;
$$;

-- 7.7 Alta de una suscripción (queda "pendiente de aprobación" hasta que PayPal confirme).
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

  insert into public.subscriptions (user_id, paypal_subscription_id, plan_id)
  values (p_user, p_paypal_subscription_id, p_plan_id)
  returning id into v_id;
  return v_id;
end;
$$;

-- 7.8 Sincroniza una suscripción con lo que PayPal informa (la Edge Function la consultó a la API; nunca llega acá lo
--     que dice el navegador ni el cuerpo crudo del webhook) y mantiene el entitlement:
--       active     -> acceso hasta la próxima fecha de cobro + 2 días de gracia (un cobro que se demora no corta el acceso)
--       suspended  -> no se extiende; el acceso termina cuando vence lo ya cubierto
--       cancelled / expired -> el acceso termina cuando vence el período YA PAGADO (no al cancelar)
--     p_user solo se usa si la suscripción todavía no existe en la base (llegó primero el webhook).
--     Devuelve: ok · unknown_subscription.
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
begin
  if p_status not in ('approval_pending', 'active', 'suspended', 'cancelled', 'expired') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  select * into v_s from public.subscriptions where paypal_subscription_id = p_paypal_subscription_id for update;
  if not found then
    if p_user is null or not exists (select 1 from public.profiles where id = p_user) then
      return 'unknown_subscription';
    end if;
    insert into public.subscriptions (user_id, paypal_subscription_id, plan_id)
    values (p_user, p_paypal_subscription_id, p_plan_id)
    returning * into v_s;
  end if;

  update public.subscriptions
     set plan_id = p_plan_id,
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
      insert into public.entitlements (user_id, scope, plan, source, external_ref, expires_at)
      values (v_s.user_id, 'all', p_plan_id, 'paypal', p_paypal_subscription_id, v_until)
      on conflict (source, external_ref) where source = 'paypal' and external_ref is not null
      do update set expires_at = excluded.expires_at, plan = excluded.plan;
    elsif p_status in ('cancelled', 'expired') then
      update public.entitlements
         set expires_at = least(coalesce(expires_at, 'infinity'::timestamptz), coalesce(v_s.current_period_end, now()))
       where source = 'paypal' and external_ref = p_paypal_subscription_id;
    end if;
  end if;
  return 'ok';
end;
$$;

-- 7.9 Idempotencia del webhook: new (primera vez) · duplicate (ya procesado o ignorado) · retry (llegó de nuevo y
--     la vez anterior no terminó).
create or replace function public.payments_event_begin(
  p_event_id text, p_event_type text, p_resource_type text, p_resource_id text, p_summary jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  insert into public.payment_events (event_id, event_type, resource_type, resource_id, summary)
  values (p_event_id, p_event_type, p_resource_type, p_resource_id, coalesce(p_summary, '{}'::jsonb))
  on conflict (event_id) do nothing;
  if found then
    return 'new';
  end if;
  select status into v_status from public.payment_events where event_id = p_event_id for update;
  if v_status in ('processed', 'ignored') then
    return 'duplicate';
  end if;
  update public.payment_events set attempts = attempts + 1, status = 'received' where event_id = p_event_id;
  return 'retry';
end;
$$;

create or replace function public.payments_event_finish(p_event_id text, p_status text, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('processed', 'ignored', 'failed') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  update public.payment_events
     set status = p_status, error = left(p_error, 500), processed_at = now()
   where event_id = p_event_id;
end;
$$;

-- Ninguna de estas funciones es ejecutable desde el navegador: solo la service role (las Edge Functions).
revoke execute on function
  public.payments_has_class_access(uuid, uuid),
  public.payments_release_order(uuid, text, text),
  public.payments_reserve_stock(uuid),
  public.payments_create_order(uuid, jsonb),
  public.payments_mark_paid(uuid, text, integer, text, text, jsonb, text, text),
  public.payments_apply_refund(uuid, text, integer),
  public.payments_start_subscription(uuid, text, text),
  public.payments_sync_subscription(text, uuid, text, text, timestamptz, timestamptz),
  public.payments_event_begin(text, text, text, text, jsonb),
  public.payments_event_finish(text, text, text)
from public, anon, authenticated;

grant execute on function
  public.payments_has_class_access(uuid, uuid),
  public.payments_release_order(uuid, text, text),
  public.payments_reserve_stock(uuid),
  public.payments_create_order(uuid, jsonb),
  public.payments_mark_paid(uuid, text, integer, text, text, jsonb, text, text),
  public.payments_apply_refund(uuid, text, integer),
  public.payments_start_subscription(uuid, text, text),
  public.payments_sync_subscription(text, uuid, text, text, timestamptz, timestamptz),
  public.payments_event_begin(text, text, text, text, jsonb),
  public.payments_event_finish(text, text, text)
to service_role;
