-- =============================================================================
-- YogaPop Up · Envío con costo y domicilio guardado en el pedido
--
--   * shop_settings (una sola fila): costo de envío en céntimos, editable desde el panel por el personal. Lo lee cualquiera
--     (el carrito lo muestra); solo lo cambia el personal de gestión.
--   * orders.shipping_cents: el envío cobrado en ese pedido (0 si solo hay videos). Ya está incluido en total_cents.
--   * orders.ship_to: domicilio y contacto que la persona completó en el formulario (nombre, dirección, ciudad, provincia,
--     país, teléfono, mail). Es el dato que usa quien despacha; `shipping` sigue guardando lo que devuelve PayPal.
--   * payments_create_order(p_user, p_items, p_ship_to): suma el envío al total y guarda el domicilio.
-- =============================================================================

create table public.shop_settings (
  id             boolean     primary key default true check (id),
  shipping_cents integer     not null default 1000 check (shipping_cents between 0 and 100000),
  updated_at     timestamptz not null default now()
);
insert into public.shop_settings (id) values (true);

alter table public.shop_settings enable row level security;
create policy shop_settings_select on public.shop_settings for select to anon, authenticated using (true);
create policy shop_settings_update on public.shop_settings for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
revoke all on public.shop_settings from anon, authenticated;
grant select on public.shop_settings to anon, authenticated;
grant update (shipping_cents) on public.shop_settings to authenticated;

create trigger shop_settings_set_updated_at
  before update on public.shop_settings
  for each row execute function public.set_updated_at();

alter table public.orders
  add column shipping_cents integer not null default 0 check (shipping_cents >= 0 and shipping_cents <= total_cents),
  add column ship_to        jsonb   check (ship_to is null or pg_column_size(ship_to) < 4096);

drop function public.payments_create_order(uuid, jsonb);

create function public.payments_create_order(p_user uuid, p_items jsonb, p_ship_to jsonb default null)
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
  v_ship     integer := 0; -- envío (solo pedidos con productos físicos)
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
  -- Un pedido puede tener videos, productos o las dos cosas. Con algún producto físico es un pedido 'shop' (lleva envío y reserva
  -- stock); solo con videos es un pedido 'class' (digital: sin envío).
  v_kind := case when v_products > 0 then 'shop' else 'class' end;

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

  -- Videos: cada uno se vende una vez por pedido (repetidos se ignoran), se alquila por 30 días y lleva el descuento del nivel.
  for v_row in
    select distinct (e ->> 'id')::uuid as cid
      from jsonb_array_elements(p_items) e
     where e ->> 'type' = 'class'
     order by 1
  loop
    select * into v_cls from public.classes
     where id = v_row.cid
       and is_published and video_status = 'ready' and access_level = 'restricted' and price_cents is not null;
    if not found then
      raise exception 'class_unavailable' using errcode = 'P0002';
    end if;
    if public.payments_has_class_access(p_user, v_cls.id) then
      raise exception 'already_owned' using errcode = '23505';
    end if;
    v_list := v_cls.price_cents;
    v_unit := public.payments_discounted_cents(v_list, v_disc);
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'item_type', 'class', 'class_id', v_cls.id, 'title', v_cls.title, 'unit_cents', v_unit,
      'list_unit_cents', case when v_disc > 0 then v_list end,
      'tax_rate_bps', v_cls.tax_rate_bps, 'qty', 1));
    v_total := v_total + v_unit;
    v_off := v_off + (v_list - v_unit);
    v_tax := v_tax + round(v_unit::numeric * v_cls.tax_rate_bps / (10000 + v_cls.tax_rate_bps));
  end loop;

  if v_products > 0 then
    -- Mismo producto y talle repetidos se suman (tope por línea: 10, igual que el carrito).
    for v_row in
      select (e ->> 'id')::uuid as pid, nullif(e ->> 'variant_id', '')::uuid as vid, sum((e ->> 'qty')::integer)::integer as qty
        from jsonb_array_elements(p_items) e
      where e ->> 'type' = 'product'
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

  -- Envío: lo fija el servidor (shop_settings), nunca el navegador. Solo si hay algún producto físico; se suma al total
  -- y su IVA (21 %) queda incluido en tax_cents, igual que el de los productos.
  if v_products > 0 then
    select shipping_cents into v_ship from public.shop_settings where id;
    v_ship := coalesce(v_ship, 0);
    v_total := v_total + v_ship;
    v_tax := v_tax + round(v_ship::numeric * 2100 / 12100);
  end if;

  insert into public.orders (user_id, kind, total_cents, tax_cents, stock_reserved, discount_bps, discount_cents, shipping_cents, ship_to)
  values (p_user, v_kind, v_total, v_tax, v_kind = 'shop', v_disc, v_off, v_ship,
          case when v_products > 0 then p_ship_to end)
  returning id into v_order;

  insert into public.order_items (order_id, item_type, product_id, variant_id, class_id, title, size, unit_cents, list_unit_cents, tax_rate_bps, qty)
  select v_order, l ->> 'item_type', (l ->> 'product_id')::uuid, (l ->> 'variant_id')::uuid, (l ->> 'class_id')::uuid,
         l ->> 'title', l ->> 'size', (l ->> 'unit_cents')::integer, (l ->> 'list_unit_cents')::integer,
         (l ->> 'tax_rate_bps')::integer, (l ->> 'qty')::integer
    from jsonb_array_elements(v_lines) l;

  return v_order;
end;
$$;

revoke all on function public.payments_create_order(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.payments_create_order(uuid, jsonb, jsonb) to service_role;
