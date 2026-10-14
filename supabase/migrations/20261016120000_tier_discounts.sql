-- =============================================================================
-- YogaPop Up · Beneficios por nivel: descuento en toda la tienda (y en los videos sueltos) y clases gratis por mes
--
--   Cada nivel guarda su descuento (discount_bps, en puntos básicos: 500 = 5 %) y cuántas clases virtuales gratis da por
--   mes (monthly_free_classes). Hoy: nivel 1 sin beneficios extra, nivel 2 con 5 %, nivel 3 con 7 % y 1 clase gratis al mes.
--   La gestión los cambia desde el panel (Pagos > Planes) por la Edge Function paypal-save-tier.
--
--   El descuento lo aplica SOLO el servidor al crear el pedido, según la suscripción vigente de quien compra:
--   el precio unitario del pedido ya sale con el descuento (así PayPal cobra exactamente lo que dice el pedido), y se
--   conserva el precio de lista (order_items.list_unit_cents) y cuánto se descontó (orders.discount_bps / discount_cents).
--   El IVA se calcula sobre el precio ya descontado. Los pedidos siguen siendo de un solo tipo (productos O una clase).
--   (El cupón mensual de clase gratis que usa monthly_free_classes llega en la migración siguiente.)
-- =============================================================================

-- 1. Beneficios del nivel
alter table public.subscription_tiers
  add column discount_bps        integer  not null default 0 check (discount_bps between 0 and 5000),
  add column monthly_free_classes smallint not null default 0 check (monthly_free_classes between 0 and 5);

update public.subscription_tiers set discount_bps = 500 where tier = 2;
update public.subscription_tiers set discount_bps = 700, monthly_free_classes = 1 where tier = 3;

-- Lo que se ofrece es público (se muestra antes de iniciar sesión).
grant select (discount_bps, monthly_free_classes) on public.subscription_tiers to anon, authenticated;

-- 2. Lo que quedó registrado en cada pedido
alter table public.orders
  add column discount_bps   integer not null default 0 check (discount_bps between 0 and 5000),
  add column discount_cents integer not null default 0 check (discount_cents >= 0);
alter table public.order_items
  add column list_unit_cents integer check (list_unit_cents is null or list_unit_cents > 0);

comment on column public.order_items.list_unit_cents is
  'Precio de lista de la unidad cuando el pedido tuvo descuento (unit_cents ya es el precio con descuento). NULL = sin descuento.';

-- 3. Descuento vigente de una persona: el MAYOR de sus suscripciones con acceso vigente (la gracia de 2 días y el
--    período ya pagado de una suscripción cancelada cuentan igual que el acceso). Un acceso manual sin nivel no da descuento.
create or replace function public.payments_user_discount_bps(p_user uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(max(t.discount_bps), 0)
    from public.entitlements e
    join public.subscription_tiers t on t.tier = e.tier
   where e.user_id = p_user
     and e.scope = 'all'
     and e.tier is not null
     and (e.expires_at is null or e.expires_at > now());
$$;

-- Precio con descuento (nunca menos de 1 céntimo, para no romper el CHECK de unit_cents).
create or replace function public.payments_discounted_cents(p_cents integer, p_bps integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select greatest(1, round(p_cents::numeric * (10000 - least(greatest(coalesce(p_bps, 0), 0), 10000)) / 10000)::integer);
$$;

revoke execute on function public.payments_user_discount_bps(uuid), public.payments_discounted_cents(integer, integer)
  from public, anon, authenticated;
grant execute on function public.payments_user_discount_bps(uuid), public.payments_discounted_cents(integer, integer)
  to service_role;

-- 4. Crear un pedido: igual que antes, pero con el descuento del nivel
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
  v_disc     integer;   -- descuento de la suscripción de la persona, en puntos básicos (500 = 5 %)
  v_list     integer;   -- precio de lista de una línea (unidad)
  v_unit     integer;   -- precio de una unidad YA con el descuento
  v_off      bigint := 0; -- cuánto se descontó en total
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

  -- El descuento lo decide SOLO el servidor, según la suscripción vigente de quien compra: nunca lo manda el navegador.
  v_disc := public.payments_user_discount_bps(p_user);

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
    v_list := v_cls.price_cents;
    v_unit := public.payments_discounted_cents(v_list, v_disc);
    v_lines := jsonb_build_array(jsonb_build_object(
      'item_type', 'class', 'class_id', v_cls.id, 'title', v_cls.title, 'unit_cents', v_unit,
      'list_unit_cents', case when v_disc > 0 then v_list end,
      'tax_rate_bps', v_cls.tax_rate_bps, 'qty', 1));
    v_total := v_unit;
    v_off := v_list - v_unit;
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

      v_list := v_prod.price_cents;
      v_unit := public.payments_discounted_cents(v_list, v_disc);
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'item_type', 'product', 'product_id', v_prod.id, 'variant_id', case when v_has_var then v_var.id end,
        'title', v_prod.title, 'size', case when v_has_var then v_var.size end,
        'unit_cents', v_unit, 'list_unit_cents', case when v_disc > 0 then v_list end,
        'tax_rate_bps', v_prod.tax_rate_bps, 'qty', v_row.qty));
      v_line := v_unit::bigint * v_row.qty;
      v_off := v_off + (v_list - v_unit)::bigint * v_row.qty;
      v_total := v_total + v_line;
      v_tax := v_tax + round(v_line::numeric * v_prod.tax_rate_bps / (10000 + v_prod.tax_rate_bps));
    end loop;
  end if;

  if v_total < 1 or v_total > 10000000 then
    raise exception 'invalid_cart' using errcode = '22023';
  end if;

  insert into public.orders (user_id, kind, total_cents, tax_cents, stock_reserved, discount_bps, discount_cents)
  values (p_user, v_kind, v_total, v_tax, v_kind = 'shop', v_disc, v_off)
  returning id into v_order;

  insert into public.order_items (order_id, item_type, product_id, variant_id, class_id, title, size, unit_cents, list_unit_cents, tax_rate_bps, qty)
  select v_order, l ->> 'item_type', (l ->> 'product_id')::uuid, (l ->> 'variant_id')::uuid, (l ->> 'class_id')::uuid,
         l ->> 'title', l ->> 'size', (l ->> 'unit_cents')::integer, (l ->> 'list_unit_cents')::integer,
         (l ->> 'tax_rate_bps')::integer, (l ->> 'qty')::integer
    from jsonb_array_elements(v_lines) l;

  return v_order;
end;
$$;

-- 5. Guardar un nivel: ahora también el descuento y las clases gratis por mes (opcionales: si no se mandan, se conservan)
drop function public.payments_save_tier(smallint, text, text, integer, text);

create or replace function public.payments_save_tier(
  p_tier         smallint,
  p_name         text,
  p_benefits     text,
  p_price_cents  integer,
  p_plan_id      text,
  p_discount_bps integer default null,
  p_monthly_free integer default null
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
         discount_bps = coalesce(p_discount_bps, discount_bps),
         monthly_free_classes = coalesce(p_monthly_free, monthly_free_classes),
         updated_at = now()
   where tier = p_tier;
  return 'ok';
end;
$$;

revoke execute on function public.payments_save_tier(smallint, text, text, integer, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.payments_save_tier(smallint, text, text, integer, text, integer, integer)
  to service_role;
