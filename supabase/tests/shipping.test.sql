-- Envío: el costo sale de shop_settings (lo cambia el personal), se suma al total solo con productos físicos y el domicilio
-- queda guardado en el pedido. Requiere tests/roles_and_audit.test.sql ya aplicado (helper t.raises). Usuarios PROPIOS (e1, e2).

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000005e1', 'envio1@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000005e2', 'envio-admin@test.dev', '{}');
update public.profiles set role = 'admin' where id = '00000000-0000-4000-8000-0000000005e2';
update public.shop_settings set shipping_cents = 1000;

do $$ declare
  p uuid; c uuid; o uuid;
  u constant uuid := '00000000-0000-4000-8000-0000000005e1';
  addr constant jsonb := '{"name":"Ana Pérez","address_line_1":"Calle Mayor 1","address_line_2":"2ºB","postal_code":"07800","city":"Ibiza","region":"Illes Balears","country_code":"ES","phone":"+34600111222","email":"ana@test.dev"}';
begin
  insert into public.products (title, price_cents, stock, is_active, tax_rate_bps) values ('Mat envío', 3000, 5, true, 2100) returning id into p;
  insert into public.classes (title, access_level, video_status, is_published, r2_object_key, price_cents, tax_rate_bps)
    values ('Video envío', 'restricted', 'ready', true, 'k/ship-a', 1000, 2100) returning id into c;

  -- 1. Con productos: el envío se suma al total, queda aparte y el domicilio se guarda
  o := public.payments_create_order(u, format('[{"type":"product","id":"%s","qty":2}]', p)::jsonb, addr);
  assert (select total_cents from public.orders where id = o) = 6000 + 1000, 'total = productos + envío';
  assert (select shipping_cents from public.orders where id = o) = 1000, 'envío guardado aparte';
  assert (select sum(unit_cents * qty) from public.order_items where order_id = o) = 6000, 'las líneas son solo la compra';
  assert (select tax_cents from public.orders where id = o) = round(6000 * 2100 / 12100.0) + round(1000 * 2100 / 12100.0), 'el IVA del envío está incluido';
  assert (select ship_to ->> 'city' from public.orders where id = o) = 'Ibiza', 'domicilio guardado';
  assert (select ship_to ->> 'phone' from public.orders where id = o) = '+34600111222', 'teléfono guardado';
  assert (select ship_to ->> 'email' from public.orders where id = o) = 'ana@test.dev', 'mail guardado';

  -- 2. Producto + video: también lleva envío
  o := public.payments_create_order(u, format('[{"type":"product","id":"%s","qty":1},{"type":"class","id":"%s"}]', p, c)::jsonb, addr);
  assert (select total_cents from public.orders where id = o) = 3000 + 1000 + 1000, 'producto + video + envío';

  -- 3. Solo video: digital, sin envío y sin domicilio
  o := public.payments_create_order(u, format('[{"type":"class","id":"%s"}]', c)::jsonb, addr);
  assert (select total_cents from public.orders where id = o) = 1000, 'solo video: sin envío';
  assert (select shipping_cents from public.orders where id = o) = 0, 'shipping_cents 0';
  assert (select ship_to from public.orders where id = o) is null, 'un pedido digital no guarda domicilio';

  -- 4. Envío gratis (0): el pedido sigue siendo válido
  update public.shop_settings set shipping_cents = 0;
  o := public.payments_create_order(u, format('[{"type":"product","id":"%s","qty":1}]', p)::jsonb, addr);
  assert (select total_cents from public.orders where id = o) = 3000, 'con envío 0 el total es la compra';
  update public.shop_settings set shipping_cents = 1000;

  -- 5. Permisos: cualquiera lee el costo; solo el personal lo cambia y con límites
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000005e1', true);
  set local role authenticated;
  assert (select shipping_cents from public.shop_settings) = 1000, 'una persona común lee el costo';
  update public.shop_settings set shipping_cents = 1;
  assert (select shipping_cents from public.shop_settings) = 1000, 'una persona común no puede cambiarlo (RLS: 0 filas)';
  perform t.raises($q$ select public.payments_create_order(auth.uid(), '[]'::jsonb, null) $q$, '42501');
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000005e2', true);
  set local role authenticated;
  update public.shop_settings set shipping_cents = 1200;
  assert (select shipping_cents from public.shop_settings) = 1200, 'el personal sí lo cambia';
  perform t.raises($q$ update public.shop_settings set shipping_cents = -5 $q$, '23514');
  reset role;
  update public.shop_settings set shipping_cents = 1000;
  set local role anon;
  assert (select shipping_cents from public.shop_settings) = 1000, 'sin sesión también se lee (el carrito lo muestra)';
  reset role;
end $$;
