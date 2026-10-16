-- Videos en el carrito: varios videos en un pedido, mezcla con productos, descuento y reembolso.
-- Requiere tests/roles_and_audit.test.sql ya aplicado (helper t.raises). Usuarios PROPIOS (b8, b9).

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000000b8', 'carrito1@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000000b9', 'carrito2@test.dev', '{}');

-- Estos tests miran precios y totales: el envío (shipping.test.sql) se prueba aparte, acá va en 0.
update public.shop_settings set shipping_cents = 0;

do $$ declare
  c1 uuid; c2 uuid; c3 uuid; cf uuid; p uuid; o uuid;
  u constant uuid := '00000000-0000-4000-8000-0000000000b8';
  u2 constant uuid := '00000000-0000-4000-8000-0000000000b9';
begin
  insert into public.classes (title, access_level, video_status, is_published, r2_object_key, price_cents, tax_rate_bps)
    values ('Video A', 'restricted', 'ready', true, 'k/cv-a', 1000, 2100) returning id into c1;
  insert into public.classes (title, access_level, video_status, is_published, r2_object_key, price_cents, tax_rate_bps)
    values ('Video B', 'restricted', 'ready', true, 'k/cv-b', 2500, 2100) returning id into c2;
  insert into public.classes (title, access_level, video_status, is_published, r2_object_key)
    values ('Video libre', 'free', 'ready', true, 'k/cv-free') returning id into cf;
  insert into public.products (title, price_cents, stock, is_active, tax_rate_bps)
    values ('Mat de prueba carrito', 3000, 5, true, 2100) returning id into p;

  -- 1. Dos videos en un pedido: pedido digital (kind class), total = suma, un acceso por video
  o := public.payments_create_order(u, format('[{"type":"class","id":"%s"},{"type":"class","id":"%s"}]', c1, c2)::jsonb);
  assert (select kind from public.orders where id = o) = 'class', 'solo videos: pedido digital';
  assert (select total_cents from public.orders where id = o) = 3500, 'total = suma de los videos';
  assert (select count(*) from public.order_items where order_id = o and class_id is not null) = 2, 'una línea por video';
  assert not (select stock_reserved from public.orders where id = o), 'sin productos no se reserva stock';
  assert public.payments_mark_paid(o, 'CAP-CV1', 3500, 'EUR', 'P', null, 'COMPLETED', 'COMPLETED') = 'paid', 'pagado';
  assert public.payments_has_class_access(u, c1) and public.payments_has_class_access(u, c2), 'acceso a los dos videos';
  assert (select count(*) from public.entitlements where source = 'paypal' and external_ref like o::text || ':%') = 2, 'un acceso por video';
  assert (select max(expires_at) from public.entitlements where source = 'paypal' and external_ref like o::text || ':%') between now() + interval '29 days 23 hours' and now() + interval '30 days 1 hour', '30 días';
  assert public.payments_mark_paid(o, 'CAP-CV1', 3500, 'EUR', 'P', null, 'COMPLETED', 'COMPLETED') = 'already_paid', 'idempotente';
  assert (select count(*) from public.entitlements where source = 'paypal' and external_ref like o::text || ':%') = 2, 'no se duplican accesos';

  -- 2. Reembolso total: se quitan los dos accesos
  assert public.payments_apply_refund(o, 'REF-CV1', 3500) = 'applied';
  assert not public.payments_has_class_access(u, c1) and not public.payments_has_class_access(u, c2), 'reembolsado: sin acceso a ninguno';

  -- 3. Mezcla video + producto: un solo pedido 'shop' que reserva stock, con envío, y da acceso al video al pagar
  o := public.payments_create_order(u2, format('[{"type":"product","id":"%s","qty":2},{"type":"class","id":"%s"}]', p, c1)::jsonb);
  assert (select kind from public.orders where id = o) = 'shop', 'con productos es pedido de tienda';
  assert (select total_cents from public.orders where id = o) = 7000, 'total = 2 x 30 + 10';
  assert (select stock from public.products where id = p) = 3, 'se reservó el stock del producto';
  assert (select stock_reserved from public.orders where id = o), 'stock reservado';
  assert (select tax_cents from public.orders where id = o) = round(7000::numeric * 2100 / 12100), 'IVA de todo el pedido';
  assert not public.payments_has_class_access(u2, c1), 'antes de pagar no hay acceso';
  assert public.payments_mark_paid(o, 'CAP-CV2', 7000, 'EUR', 'P', '{"name":"X"}'::jsonb, 'COMPLETED', 'COMPLETED') = 'paid';
  assert public.payments_has_class_access(u2, c1), 'pagado: acceso al video de la mezcla';
  -- Cancelar un pedido mezclado sin pagar devuelve el stock
  o := public.payments_create_order(u, format('[{"type":"product","id":"%s","qty":1},{"type":"class","id":"%s"}]', p, c2)::jsonb);
  assert (select stock from public.products where id = p) = 2, 'reservado';
  assert public.payments_release_order(o, 'cancelled', 'prueba'), 'cancelado';
  assert (select stock from public.products where id = p) = 3, 'el stock volvió';

  -- 4. Reglas: el mismo video repetido se cobra una vez; ya tenido / libre / inexistente se rechazan
  o := public.payments_create_order(u, format('[{"type":"class","id":"%s"},{"type":"class","id":"%s"}]', c2, c2)::jsonb);
  assert (select total_cents from public.orders where id = o) = 2500, 'video repetido: una sola vez';
  perform t.raises(format($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000b9', '[{"type":"class","id":"%s"},{"type":"class","id":"%s"}]'::jsonb) $q$, c1, c2), '23505'); -- ya tiene c1
  perform t.raises(format($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000b8', '[{"type":"class","id":"%s"}]'::jsonb) $q$, cf), 'P0002'); -- libre: no se vende
  perform t.raises($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000b8', '[{"type":"class","id":"00000000-0000-4000-8000-00000000c0de"}]'::jsonb) $q$, 'P0002');

  -- 5. Con descuento de nivel (5 %): se aplica a videos y productos juntos. Un video de nivel 3 se puede comprar desde el nivel 2.
  insert into public.classes (title, access_level, video_status, is_published, r2_object_key, price_cents, tax_rate_bps, min_tier)
    values ('Video nivel 3', 'restricted', 'ready', true, 'k/cv-n3', 4000, 2100, 3) returning id into c3;
  insert into public.entitlements (user_id, scope, tier, source, external_ref, expires_at)
    values (u2, 'all', 2, 'paypal', 'I-CARRITO2', now() + interval '10 days');
  o := public.payments_create_order(u2, format('[{"type":"product","id":"%s","qty":1},{"type":"class","id":"%s"}]', p, c3)::jsonb);
  assert (select total_cents from public.orders where id = o) = 2850 + 3800, 'total con 5 % en producto y video';
  assert (select discount_cents from public.orders where id = o) = 150 + 200, 'descuento total';
  assert (select sum(unit_cents * qty) from public.order_items where order_id = o) = (select total_cents from public.orders where id = o), 'las líneas suman el total';
  -- el nivel 2 ya cubre a Video B (min_tier 1): no se compra
  perform t.raises(format($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000b9', '[{"type":"class","id":"%s"}]'::jsonb) $q$, c2), '23505');
end $$;
