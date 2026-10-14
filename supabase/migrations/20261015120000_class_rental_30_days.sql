-- =============================================================================
-- YogaPop Up · Las clases sueltas se alquilan por 30 días
--
--   Antes, comprar una clase suelta daba acceso para siempre (expires_at null). Ahora el acceso vence a los 30 días del
--   pago: pasado ese plazo la clase vuelve a estar bloqueada y, para verla otra vez, se compra de nuevo (payments_create_order
--   solo rechaza la compra con 'already_owned' mientras el acceso siga vigente, así que no hace falta tocarla).
--   Las suscripciones no cambian. Las compras ya hechas antes de esta migración conservan su acceso sin vencimiento.
-- =============================================================================

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

  -- Pedido digital: el acceso a la clase se concede acá, en la misma transacción que el pago, y dura 30 DÍAS desde el pago
  -- (no desde que se creó el pedido, para que un pago tardío no pierda días). Para volver a verla hay que comprarla de nuevo.
  if v_o.kind = 'class' and v_o.user_id is not null then
    insert into public.entitlements (user_id, scope, class_id, source, external_ref, expires_at)
    select v_o.user_id, 'class', i.class_id, 'paypal', v_o.id::text, now() + interval '30 days'
      from public.order_items i
     where i.order_id = v_o.id and i.class_id is not null
    on conflict (source, external_ref) where source = 'paypal' and external_ref is not null do nothing;
  end if;

  return 'paid';
end;
$$;
