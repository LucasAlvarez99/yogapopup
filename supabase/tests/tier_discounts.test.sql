-- Beneficios por nivel: el descuento lo pone el servidor según la suscripción vigente, en videos sueltos y en productos.
-- Requiere el esquema de tests/roles_and_audit.test.sql ya aplicado (helper t.raises). Usuarios PROPIOS (a5..a9).

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000000a5', 'sin-sub@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000000a6', 'nivel2-desc@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000000a7', 'nivel3-desc@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000000a8', 'manual-desc@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000000a9', 'vencida-desc@test.dev', '{}');

create table t.disctest (name text primary key, id uuid);
grant all on t.disctest to public;
create function t.dd(n text) returns uuid language sql as $$ select id from t.disctest where name = n $$;
grant execute on function t.dd(text) to public;

-- 1. Valores iniciales de los niveles
do $$ begin
  assert (select array_agg(discount_bps order by tier) from public.subscription_tiers) = array[0, 500, 700], 'descuentos 0 %, 5 % y 7 %';
  assert (select array_agg(monthly_free_classes order by tier) from public.subscription_tiers) = array[0, 0, 1]::smallint[], 'clase gratis al mes solo en el nivel 3';
  perform t.raises($q$ update public.subscription_tiers set discount_bps = 6000 where tier = 2 $q$, '23514');
  perform t.raises($q$ update public.subscription_tiers set discount_bps = -1 where tier = 2 $q$, '23514');
  perform t.raises($q$ update public.subscription_tiers set monthly_free_classes = 6 where tier = 3 $q$, '23514');
  assert public.payments_discounted_cents(1000, 500) = 950 and public.payments_discounted_cents(2000, 700) = 1860, 'precio con descuento';
  assert public.payments_discounted_cents(1, 700) = 1, 'nunca menos de un céntimo';
  assert public.payments_discounted_cents(999, 0) = 999 and public.payments_discounted_cents(999, null) = 999, 'sin descuento';
end $$;

-- 2. Catálogo de prueba y suscripciones (los planes de cada nivel los crea payments_save_tier, como en el panel)
do $$ declare v uuid; begin
  insert into public.products (title, price_cents, stock, is_active, tax_rate_bps) values ('Mat descuento', 2000, 50, true, 2100) returning id into v;
  insert into t.disctest values ('mat', v);
  insert into public.classes (title, access_level, video_status, is_published, r2_object_key, price_cents, tax_rate_bps)
    values ('Video con descuento', 'restricted', 'ready', true, 'k/desc', 1000, 2100) returning id into v;
  insert into t.disctest values ('video', v);
  insert into public.classes (title, access_level, video_status, is_published, r2_object_key, price_cents, tax_rate_bps, min_tier)
    values ('Video solo nivel 3', 'restricted', 'ready', true, 'k/desc3', 1000, 2100, 3) returning id into v;
  insert into t.disctest values ('video3', v);

  perform public.payments_save_tier(2::smallint, 'Plus', '', 2000, 'P-DESC-2');
  perform public.payments_save_tier(3::smallint, 'Premium', '', 3000, 'P-DESC-3');

  perform public.payments_start_subscription('00000000-0000-4000-8000-0000000000a6', 'I-DESC2', 'P-DESC-2');
  perform public.payments_sync_subscription('I-DESC2', null, 'P-DESC-2', 'active', now() + interval '30 days', now());
  perform public.payments_start_subscription('00000000-0000-4000-8000-0000000000a7', 'I-DESC3', 'P-DESC-3');
  perform public.payments_sync_subscription('I-DESC3', null, 'P-DESC-3', 'active', now() + interval '30 days', now());
  insert into public.entitlements (user_id, scope, source) values ('00000000-0000-4000-8000-0000000000a8', 'all', 'manual');
  -- Suscripción vencida hace mucho: ya no da descuento
  insert into public.entitlements (user_id, scope, tier, source, external_ref, expires_at)
    values ('00000000-0000-4000-8000-0000000000a9', 'all', 3, 'paypal', 'I-DESC-VIEJA', now() - interval '3 days');
end $$;

-- 3. Qué descuento tiene cada persona
do $$ begin
  assert public.payments_user_discount_bps('00000000-0000-4000-8000-0000000000a5') = 0, 'sin suscripción: 0';
  assert public.payments_user_discount_bps('00000000-0000-4000-8000-0000000000a6') = 500, 'nivel 2: 5 %';
  assert public.payments_user_discount_bps('00000000-0000-4000-8000-0000000000a7') = 700, 'nivel 3: 7 %';
  assert public.payments_user_discount_bps('00000000-0000-4000-8000-0000000000a8') = 0, 'acceso manual sin nivel: sin descuento';
  assert public.payments_user_discount_bps('00000000-0000-4000-8000-0000000000a9') = 0, 'suscripción vencida: sin descuento';
end $$;

-- 4. Video suelto con y sin descuento (el IVA se calcula sobre el precio ya descontado).
--    Quien ya ve un video por su nivel no lo compra suelto: el descuento aplica a los videos que su nivel NO cubre.
do $$ declare o uuid; begin
  o := public.payments_create_order('00000000-0000-4000-8000-0000000000a5', format('[{"type":"class","id":"%s"}]', t.dd('video'))::jsonb);
  assert (select total_cents from public.orders where id = o) = 1000, 'sin suscripción paga el precio de lista';
  assert (select discount_bps from public.orders where id = o) = 0 and (select discount_cents from public.orders where id = o) = 0;
  assert (select list_unit_cents from public.order_items where order_id = o) is null, 'sin descuento no guarda precio de lista';

  perform t.raises(format($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000a6', '[{"type":"class","id":"%s"}]'::jsonb) $q$, t.dd('video')), '23505'); -- el nivel 2 ya lo ve
  perform t.raises(format($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000a7', '[{"type":"class","id":"%s"}]'::jsonb) $q$, t.dd('video3')), '23505'); -- el nivel 3 ve todo

  o := public.payments_create_order('00000000-0000-4000-8000-0000000000a6', format('[{"type":"class","id":"%s"}]', t.dd('video3'))::jsonb);
  assert (select total_cents from public.orders where id = o) = 950, 'nivel 2 compra un video de nivel 3: 5 % menos (9,50 €)';
  assert (select discount_bps from public.orders where id = o) = 500 and (select discount_cents from public.orders where id = o) = 50, 'queda registrado cuánto se descontó';
  assert (select unit_cents from public.order_items where order_id = o) = 950 and (select list_unit_cents from public.order_items where order_id = o) = 1000, 'precio con descuento y de lista';
  assert (select tax_cents from public.orders where id = o) = 165, 'IVA sobre el precio descontado (21 % de 9,50 € incluido = 1,65 €)';
  -- PayPal cobra exactamente el total del pedido: el pago se acepta con el monto descontado y se rechaza con el de lista
  assert public.payments_mark_paid(o, 'CAP-D2', 1000, 'EUR', 'P', null, 'COMPLETED', 'COMPLETED') = 'mismatch', 'el precio de lista ya no es el monto del pedido';
  assert public.payments_mark_paid(o, 'CAP-D2', 950, 'EUR', 'P', null, 'COMPLETED', 'COMPLETED') = 'paid', 'se cobra el monto con descuento';
  assert public.payments_has_class_access('00000000-0000-4000-8000-0000000000a6', t.dd('video3')), 'y se concede el acceso';

  o := public.payments_create_order('00000000-0000-4000-8000-0000000000a9', format('[{"type":"class","id":"%s"}]', t.dd('video'))::jsonb);
  assert (select total_cents from public.orders where id = o) = 1000, 'suscripción vencida: precio de lista';
end $$;

-- 5. Productos de la tienda: el descuento va por unidad y se suma por cantidad
do $$ declare o uuid; begin
  o := public.payments_create_order('00000000-0000-4000-8000-0000000000a7', format('[{"type":"product","id":"%s","variant_id":null,"qty":2}]', t.dd('mat'))::jsonb);
  assert (select unit_cents from public.order_items where order_id = o) = 1860, 'unidad con 7 %: 18,60 €';
  assert (select list_unit_cents from public.order_items where order_id = o) = 2000;
  assert (select total_cents from public.orders where id = o) = 3720, 'total de 2 unidades';
  assert (select discount_cents from public.orders where id = o) = 280, 'descuento total = 2 × 1,40 €';
  assert (select tax_cents from public.orders where id = o) = round(3720::numeric * 2100 / 12100), 'IVA sobre lo descontado';

  o := public.payments_create_order('00000000-0000-4000-8000-0000000000a5', format('[{"type":"product","id":"%s","variant_id":null,"qty":2}]', t.dd('mat'))::jsonb);
  assert (select total_cents from public.orders where id = o) = 4000 and (select discount_cents from public.orders where id = o) = 0, 'sin suscripción: 40 €';
  o := public.payments_create_order('00000000-0000-4000-8000-0000000000a8', format('[{"type":"product","id":"%s","variant_id":null,"qty":1}]', t.dd('mat'))::jsonb);
  assert (select total_cents from public.orders where id = o) = 2000, 'acceso manual sin nivel: precio de lista';
end $$;

-- 6. Una suscripción cancelada conserva el descuento mientras dure lo pagado
do $$ begin
  perform public.payments_sync_subscription('I-DESC3', null, 'P-DESC-3', 'cancelled', null, null);
  assert public.payments_user_discount_bps('00000000-0000-4000-8000-0000000000a7') = 700, 'cancelada pero con acceso vigente: sigue el descuento';
  update public.entitlements set expires_at = now() - interval '1 minute' where external_ref = 'I-DESC3';
  assert public.payments_user_discount_bps('00000000-0000-4000-8000-0000000000a7') = 0, 'vencido el período pagado: sin descuento';
end $$;

-- 7. La gestión cambia el descuento y las clases gratis (solo service role); si no se mandan, se conservan
do $$ begin
  assert public.payments_save_tier(2::smallint, 'Plus', '', 2000, null, 600, 1) = 'ok';
  assert (select discount_bps from public.subscription_tiers where tier = 2) = 600 and (select monthly_free_classes from public.subscription_tiers where tier = 2) = 1;
  assert public.payments_save_tier(2::smallint, 'Plus', 'Nuevo texto', 2000, null) = 'ok', 'sin mandar beneficios: se conservan';
  assert (select discount_bps from public.subscription_tiers where tier = 2) = 600 and (select monthly_free_classes from public.subscription_tiers where tier = 2) = 1;
  perform t.raises($q$ select public.payments_save_tier(2::smallint, 'Plus', '', 2000, null, 9000, 0) $q$, '23514');
  perform public.payments_save_tier(2::smallint, 'Plus', '', 2000, null, 500, 0);

  set local role anon;
  assert (select discount_bps from public.subscription_tiers where tier = 3) = 700, 'el descuento se muestra sin iniciar sesión';
  perform t.raises($q$ select public.payments_user_discount_bps('00000000-0000-4000-8000-0000000000a7') $q$, '42501');
  perform t.raises($q$ select public.payments_save_tier(2::smallint, 'Plus', '', 2000, null, 100, 0) $q$, '42501');
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a5', true);
  set local role authenticated;
  perform t.raises($q$ update public.subscription_tiers set discount_bps = 5000 where tier = 1 $q$, '42501');
  perform t.raises($q$ select public.payments_user_discount_bps('00000000-0000-4000-8000-0000000000a5') $q$, '42501');
  reset role;
end $$;
