-- =============================================================================
-- YogaPop Up · Videos en el carrito
--
--   Los videos se agregan al carrito como cualquier producto de la tienda. Un pedido puede tener:
--     * solo productos        -> kind 'shop'  (envío, reserva de stock)
--     * solo videos           -> kind 'class' (digital, sin envío); ya no se limita a UN video
--     * videos y productos    -> kind 'shop'  (un solo pago; los videos se activan al pagar, los productos se envían)
--   Cada video pagado da su propio acceso de 30 días (external_ref = <pedido>:<video>). El descuento del nivel de la persona
--   se aplica igual a videos y productos. Comprar un video que el nivel ya cubre se sigue rechazando (already_owned).
-- =============================================================================

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

  -- Videos del pedido (solos o junto con productos): el acceso a cada uno se concede acá, en la misma transacción que el pago,
  -- y dura 30 DÍAS desde el pago (no desde que se creó el pedido, para que un pago tardío no pierda días).
  -- Un acceso por video: external_ref = <pedido>:<video> (único por video, así un pedido con varios videos los concede todos).
  if v_o.user_id is not null then
    insert into public.entitlements (user_id, scope, class_id, source, external_ref, expires_at)
    select v_o.user_id, 'class', i.class_id, 'paypal', v_o.id::text || ':' || i.class_id::text, now() + interval '30 days'
      from public.order_items i
     where i.order_id = v_o.id and i.class_id is not null
    on conflict (source, external_ref) where source = 'paypal' and external_ref is not null do nothing;
  end if;

  return 'paid';
end;
$$;


-- Reembolso total: se quitan los accesos a los videos del pedido (cualquiera sea su tipo; los de antes de esta migración
-- guardaban solo el id del pedido). Un reembolso de productos NO repone stock solo.
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

  if v_new >= v_o.total_cents then
    delete from public.entitlements
     where source = 'paypal'
       and (external_ref = p_order::text or external_ref like p_order::text || ':%');
  end if;
  return 'applied';
end;
$$;
