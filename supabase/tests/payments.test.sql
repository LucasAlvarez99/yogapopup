-- Pruebas de las Fases 17-22: pedidos, stock, accesos, reembolsos, suscripciones, eventos y permisos (RLS).
-- Requiere el esquema de tests/roles_and_audit.test.sql ya aplicado en la misma base (helper t.raises).
-- Usuarios PROPIOS (f5 comprador, f6 otra persona, f7 admin, f8 developer).

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000000f5', 'compra@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000000f6', 'otra@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000000f7', 'admin-pagos@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000000f8', 'dev-pagos@test.dev', '{}');
update public.profiles set role = 'admin' where id = '00000000-0000-4000-8000-0000000000f7';
update public.profiles set role = 'developer' where id = '00000000-0000-4000-8000-0000000000f8';

create table t.paytest (name text primary key, id uuid);
grant all on t.paytest to public;
create function t.pp(n text) returns uuid language sql as $$ select id from t.paytest where name = n $$;
grant execute on function t.pp(text) to public;

-- Catálogo de prueba
do $$ declare v uuid; c uuid; begin
  insert into public.products (title, price_cents, stock, is_active, tax_rate_bps) values ('Mat', 2000, 5, true, 2100) returning id into v;
  insert into t.paytest values ('mat', v);
  insert into public.products (title, price_cents, stock, is_active) values ('Bloque sin control', 1000, null, true) returning id into v;
  insert into t.paytest values ('bloque', v);
  insert into public.products (title, price_cents, stock, is_active) values ('Oculto', 1000, 5, false) returning id into v;
  insert into t.paytest values ('oculto', v);
  insert into public.products (title, price_cents, stock, is_active) values ('Gratis', 0, 5, true) returning id into v;
  insert into t.paytest values ('gratis', v);
  insert into public.products (title, price_cents, is_active) values ('Remera', 3000, true) returning id into v;
  insert into t.paytest values ('remera', v);
  insert into public.product_variants (product_id, size, stock, sort_order) values (v, 'M', 2, 0) returning id into c;
  insert into t.paytest values ('remera_m', c);
  insert into public.product_variants (product_id, size, stock, sort_order) values (v, 'L', 0, 1) returning id into c;
  insert into t.paytest values ('remera_l', c);

  insert into public.classes (title, access_level, video_status, is_published, r2_object_key, price_cents)
    values ('Curso pago', 'restricted', 'ready', true, 'classes/x/a.mp4', 1210) returning id into c;
  insert into t.paytest values ('curso', c);
  insert into public.classes (title, access_level, video_status, is_published, r2_object_key, price_cents)
    values ('Curso gratis', 'free', 'ready', true, 'classes/x/b.mp4', 1000) returning id into c;
  insert into t.paytest values ('curso_free', c);
  insert into public.classes (title, access_level, video_status, is_published, r2_object_key)
    values ('Curso sin precio', 'restricted', 'ready', true, 'classes/x/c.mp4') returning id into c;
  insert into t.paytest values ('curso_sin_precio', c);
  insert into public.classes (title, access_level, video_status, is_published, r2_object_key)
    values ('Curso de suscripcion', 'restricted', 'ready', true, 'classes/x/d.mp4') returning id into c;
  insert into t.paytest values ('curso_sub', c);
  insert into public.classes (title, access_level, video_status, is_published, r2_object_key, price_cents)
    values ('Curso borrador', 'restricted', 'pending', false, 'classes/x/e.mp4', 900) returning id into c;
  insert into t.paytest values ('curso_borrador', c);
end $$;

create function t.pstock(n text) returns integer language sql as $$
  select coalesce((select stock from public.product_variants where id = t.pp(n)), (select stock from public.products where id = t.pp(n)))
$$;
grant execute on function t.pstock(text) to public;

-- 1. Los clientes NO pueden escribir ni ejecutar nada de pagos; solo leer lo suyo.
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000f5', true);
  set local role authenticated;
  perform t.raises($q$ insert into public.orders (user_id, kind, total_cents) values (auth.uid(), 'shop', 100) $q$, '42501');
  perform t.raises($q$ update public.orders set status = 'paid' $q$, '42501');
  perform t.raises($q$ delete from public.orders $q$, '42501');
  perform t.raises($q$ insert into public.subscriptions (user_id, paypal_subscription_id, plan_id) values (auth.uid(), 'I-ABCDE', 'P-123') $q$, '42501');
  perform t.raises($q$ insert into public.entitlements (user_id, scope, source) values (auth.uid(), 'all', 'paypal') $q$, '42501');
  perform t.raises(format($q$ select public.payments_create_order(auth.uid(), '[{"type":"product","id":"%s","qty":1}]'::jsonb) $q$, t.pp('mat')), '42501');
  perform t.raises($q$ select public.payments_mark_paid(gen_random_uuid(), 'CAP-1', 100, 'EUR', null, null, 'COMPLETED', 'COMPLETED') $q$, '42501');
  perform t.raises($q$ select public.payments_event_begin('WH-1', 'X.Y', null, null, '{}') $q$, '42501');
  reset role;
  set local role anon;
  perform t.raises($q$ select * from public.orders $q$, '42501');
  perform t.raises($q$ select * from public.subscriptions $q$, '42501');
  reset role;
end $$;

-- 2. Pedido de tienda: precio y stock salen de la base; el stock se reserva; se guarda una copia del precio.
do $$ declare o uuid; r public.orders; begin
  o := public.payments_create_order('00000000-0000-4000-8000-0000000000f5',
    format('[{"type":"product","id":"%s","qty":2},{"type":"product","id":"%s","qty":1},{"type":"product","id":"%s","qty":1}]',
           t.pp('mat'), t.pp('bloque'), t.pp('mat'))::jsonb);
  select * into r from public.orders where id = o;
  assert r.kind = 'shop' and r.status = 'created' and r.stock_reserved, 'pedido de tienda creado con stock reservado';
  assert r.total_cents = 3 * 2000 + 1000, format('total = 7000 (mat x3 duplicado sumado + bloque), fue %s', r.total_cents);
  -- IVA incluido: 21 % de 6000 = 1041.32 -> 1041; 21 % de 1000 -> 173.55 -> 174
  assert r.tax_cents = 1041 + 174, format('IVA incluido, fue %s', r.tax_cents);
  assert t.pstock('mat') = 2, 'el stock se descontó (5 - 3)';
  assert t.pstock('bloque') is null, 'sin control de stock sigue sin control';
  assert (select count(*) from public.order_items where order_id = o) = 2, 'las líneas duplicadas se suman en una';
  assert (select qty from public.order_items where order_id = o and title = 'Mat') = 3, 'cantidad sumada';
  insert into t.paytest values ('o1', o);
end $$;

-- 3. Validaciones del pedido: nada se descuenta si algo falla.
do $$ begin
  perform t.raises(format($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000f6', '[{"type":"product","id":"%s","qty":99}]'::jsonb) $q$, t.pp('mat')), '22023');
  perform t.raises(format($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000f6', '[{"type":"product","id":"%s","qty":3}]'::jsonb) $q$, t.pp('mat')), '23514'); -- solo quedan 2
  assert t.pstock('mat') = 2, 'un pedido rechazado no toca el stock';
  perform t.raises(format($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000f6', '[{"type":"product","id":"%s","qty":1}]'::jsonb) $q$, t.pp('oculto')), 'P0002');
  perform t.raises(format($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000f6', '[{"type":"product","id":"%s","qty":1}]'::jsonb) $q$, t.pp('gratis')), 'P0002');
  perform t.raises(format($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000f6', '[{"type":"product","id":"%s","qty":1,"price_cents":1}]'::jsonb) $q$, t.pp('remera')), '22023'); -- con talles exige talle
  perform t.raises(format($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000f6', '[{"type":"product","id":"%s","variant_id":"%s","qty":1}]'::jsonb) $q$, t.pp('mat'), t.pp('remera_m')), 'P0002'); -- talle ajeno
  perform t.raises(format($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000f6', '[{"type":"product","id":"%s","variant_id":"%s","qty":1}]'::jsonb) $q$, t.pp('remera'), t.pp('remera_l')), '23514'); -- talle agotado
  perform t.raises($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000f6', '[]'::jsonb) $q$, '22023');
  perform t.raises($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000f6', '{"a":1}'::jsonb) $q$, '22023');
  perform t.raises($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000f6', '[{"type":"otra","id":"x"}]'::jsonb) $q$, '22023');
  perform t.raises($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000f6', '[{"type":"product","id":"no-es-uuid","qty":1}]'::jsonb) $q$, '22P02');
  perform t.raises(format($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000f6', '[{"type":"product","id":"%s","qty":1},{"type":"class","id":"%s"}]'::jsonb) $q$, t.pp('mat'), t.pp('curso')), '22023'); -- mezcla
  perform t.raises($q$ select public.payments_create_order('00000000-0000-4000-8000-00000000dead', '[]'::jsonb) $q$, 'P0002');
end $$;

-- 4. Talles: manda el stock del talle.
do $$ declare o uuid; begin
  o := public.payments_create_order('00000000-0000-4000-8000-0000000000f6',
    format('[{"type":"product","id":"%s","variant_id":"%s","qty":2}]', t.pp('remera'), t.pp('remera_m'))::jsonb);
  assert t.pstock('remera_m') = 0, 'el talle M quedó en 0';
  assert (select size from public.order_items where order_id = o) = 'M', 'se guardó el talle';
  -- otra persona no puede comprar el talle que otra tiene reservado (y el rechazo no toca nada de lo de ella)
  perform t.raises(format($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000f5', '[{"type":"product","id":"%s","variant_id":"%s","qty":1}]'::jsonb) $q$, t.pp('remera'), t.pp('remera_m')), '23514');
  assert (select status from public.orders where id = t.pp('o1')) = 'created', 'el rechazo no cancela los pedidos abiertos de quien lo intentó';
  -- Un intento nuevo de la misma persona reemplaza al anterior sin pagar (devuelve el stock) y puede volver a comprar.
  o := public.payments_create_order('00000000-0000-4000-8000-0000000000f6',
    format('[{"type":"product","id":"%s","variant_id":"%s","qty":2}]', t.pp('remera'), t.pp('remera_m'))::jsonb);
  assert t.pstock('remera_m') = 0, 'el stock se reservó de nuevo para el pedido nuevo (no se duplicó el descuento)';
  assert (select count(*) from public.orders where user_id = '00000000-0000-4000-8000-0000000000f6' and status = 'cancelled' and failure_reason = 'superseded') = 1,
    'el pedido anterior quedó cancelado como reemplazado';
  insert into t.paytest values ('o_remera', o);
  perform public.payments_release_order(o, 'cancelled', 'prueba');
  assert t.pstock('remera_m') = 2, 'liberar devuelve el stock';
end $$;

-- 5. Liberar es idempotente: el stock se devuelve UNA sola vez.
do $$ declare o uuid; begin
  o := t.pp('o1');
  assert public.payments_release_order(o, 'cancelled', 'abandonado') = true, 'primera liberación';
  assert t.pstock('mat') = 5, 'stock restaurado';
  assert public.payments_release_order(o, 'cancelled', 'abandonado') = false, 'segunda liberación: no hace nada';
  assert t.pstock('mat') = 5, 'no se devolvió dos veces';
  assert (select status from public.orders where id = o) = 'cancelled', 'quedó cancelado';
  perform t.raises(format($q$ select public.payments_release_order('%s', 'paid', 'x') $q$, o), '22023');
end $$;

-- 6. Cobro verificado: monto distinto = no se da por pagado; PENDING espera; COMPLETED paga; repetir no duplica.
do $$ declare o uuid; res text; begin
  o := public.payments_create_order('00000000-0000-4000-8000-0000000000f5',
    format('[{"type":"product","id":"%s","qty":2}]', t.pp('mat'))::jsonb);
  insert into t.paytest values ('o2', o);
  assert t.pstock('mat') = 3, 'reservado';

  assert public.payments_mark_paid(o, 'CAP-A1', 3999, 'EUR', 'PAYER1', null, 'COMPLETED', 'COMPLETED') = 'mismatch', 'monto menor: mismatch';
  assert public.payments_mark_paid(o, 'CAP-A1', 4000, 'USD', 'PAYER1', null, 'COMPLETED', 'COMPLETED') = 'mismatch', 'otra moneda: mismatch';
  assert (select status from public.orders where id = o) = 'created' and (select needs_review from public.orders where id = o),
    'un monto que no cuadra no marca el pedido como pagado y pide revisión';

  assert public.payments_mark_paid(o, 'CAP-A1', 4000, 'EUR', 'PAYER1', null, 'COMPLETED', 'PENDING') = 'pending', 'PENDING espera';
  assert (select status from public.orders where id = o) = 'pending', 'estado pending';

  res := public.payments_mark_paid(o, 'CAP-A1', 4000, 'EUR', 'PAYER1', '{"name":"Ana","address":{"country_code":"ES"}}', 'COMPLETED', 'COMPLETED');
  assert res = 'paid', format('pagado, fue %s', res);
  assert (select status from public.orders where id = o) = 'paid' and (select paid_at from public.orders where id = o) is not null, 'quedó pagado';
  assert (select shipping ->> 'name' from public.orders where id = o) = 'Ana', 'guardó el envío de PayPal';
  assert public.payments_mark_paid(o, 'CAP-A1', 4000, 'EUR', 'PAYER1', null, 'COMPLETED', 'COMPLETED') = 'already_paid', 'repetir no duplica';
  assert t.pstock('mat') = 3, 'el stock no se vuelve a tocar';
  assert public.payments_release_order(o, 'cancelled', 'x') = false, 'un pedido pagado no se libera';
  assert public.payments_mark_paid(gen_random_uuid(), 'CAP-X', 1, 'EUR', null, null, 'COMPLETED', 'COMPLETED') = 'not_found', 'pedido inexistente';
end $$;

-- 7. Pago tardío: el pedido ya se había cancelado. Con stock se reserva de nuevo; sin stock se paga y se marca para revisión.
do $$ declare o uuid; o2 uuid; begin
  o := public.payments_create_order('00000000-0000-4000-8000-0000000000f6',
    format('[{"type":"product","id":"%s","qty":1}]', t.pp('mat'))::jsonb);
  perform public.payments_release_order(o, 'cancelled', 'vencido');
  assert t.pstock('mat') = 3, 'stock liberado';
  assert public.payments_mark_paid(o, 'CAP-LATE1', 2000, 'EUR', 'P', null, 'COMPLETED', 'COMPLETED') = 'paid', 'pago tardío con stock';
  assert t.pstock('mat') = 2, 'el stock se volvió a reservar';
  assert not (select needs_review from public.orders where id = o), 'sin problemas';

  -- ahora sin stock: otra persona se lleva las 2 unidades que quedan, y el pago tardío llega después
  o2 := public.payments_create_order('00000000-0000-4000-8000-0000000000f5',
    format('[{"type":"product","id":"%s","qty":1}]', t.pp('mat'))::jsonb);
  perform public.payments_release_order(o2, 'cancelled', 'vencido');
  perform public.payments_create_order('00000000-0000-4000-8000-0000000000f7',
    format('[{"type":"product","id":"%s","qty":2}]', t.pp('mat'))::jsonb);
  assert t.pstock('mat') = 0, 'agotado';
  assert public.payments_mark_paid(o2, 'CAP-LATE2', 2000, 'EUR', 'P', null, 'COMPLETED', 'COMPLETED') = 'paid', 'el dinero ya se cobró: se registra';
  assert (select needs_review and review_note = 'paid_without_stock' from public.orders where id = o2), 'marcado para revisión por falta de stock';
  assert t.pstock('mat') = 0, 'el stock no queda negativo';
  -- limpieza para no afectar a las demás pruebas
  update public.products set stock = 5 where id = t.pp('mat');
end $$;

-- 8. Clase suelta: validaciones, acceso concedido al pagar (una sola vez) y revocado al reembolsar.
do $$ declare o uuid; begin
  perform t.raises(format($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000f5', '[{"type":"class","id":"%s"}]'::jsonb) $q$, t.pp('curso_free')), 'P0002'); -- gratis: no se cobra
  perform t.raises(format($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000f5', '[{"type":"class","id":"%s"}]'::jsonb) $q$, t.pp('curso_sin_precio')), 'P0002');
  perform t.raises(format($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000f5', '[{"type":"class","id":"%s"}]'::jsonb) $q$, t.pp('curso_borrador')), 'P0002');
  perform t.raises(format($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000f5', '[{"type":"class","id":"%s"},{"type":"class","id":"%s"}]'::jsonb) $q$, t.pp('curso'), t.pp('curso')), '22023'); -- una por pedido

  o := public.payments_create_order('00000000-0000-4000-8000-0000000000f5', format('[{"type":"class","id":"%s"}]', t.pp('curso'))::jsonb);
  insert into t.paytest values ('o_curso', o);
  assert (select kind from public.orders where id = o) = 'class' and not (select stock_reserved from public.orders where id = o), 'pedido digital sin stock';
  assert (select total_cents from public.orders where id = o) = 1210 and (select tax_cents from public.orders where id = o) = 210, 'precio e IVA (21 % de 12,10 € = 2,10 €) de la base';

  -- Antes de pagar NO tiene acceso (clase restringida)
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000f5', true);
  set local role authenticated;
  assert not public.can_access_class(t.pp('curso')), 'sin pago no hay acceso';
  reset role;

  assert public.payments_mark_paid(o, 'CAP-C1', 1210, 'EUR', 'P', null, 'COMPLETED', 'COMPLETED') = 'paid', 'pagado';
  assert public.payments_mark_paid(o, 'CAP-C1', 1210, 'EUR', 'P', null, 'COMPLETED', 'COMPLETED') = 'already_paid', 'idempotente';
  assert (select count(*) from public.entitlements where source = 'paypal' and external_ref = o::text) = 1, 'un solo acceso (no se duplica)';

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000f5', true);
  set local role authenticated;
  assert public.can_access_class(t.pp('curso')), 'pagó: tiene acceso';
  assert not public.can_access_class(t.pp('curso_sub')), 'y solo a ESA clase';
  reset role;

  perform t.raises(format($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000f5', '[{"type":"class","id":"%s"}]'::jsonb) $q$, t.pp('curso')), '23505'); -- ya la tiene

  -- Reembolso parcial: el acceso sigue. Duplicado: no suma dos veces. Total: se quita el acceso.
  assert public.payments_apply_refund(o, 'REF-1', 200) = 'applied', 'reembolso parcial';
  assert public.payments_apply_refund(o, 'REF-1', 200) = 'duplicate', 'mismo reembolso reenviado';
  assert (select refunded_cents from public.orders where id = o) = 200 and (select status from public.orders where id = o) = 'paid', 'parcial: sigue pagado';
  assert exists (select 1 from public.entitlements where external_ref = o::text), 'parcial: conserva el acceso';
  assert public.payments_apply_refund(o, 'REF-2', 5000) = 'applied', 'el resto (topado al total)';
  assert (select refunded_cents from public.orders where id = o) = 1210 and (select status from public.orders where id = o) = 'refunded', 'reembolsado por completo';
  assert not exists (select 1 from public.entitlements where external_ref = o::text), 'reembolso total: se quita el acceso';
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000f5', true);
  set local role authenticated;
  assert not public.can_access_class(t.pp('curso')), 'sin acceso tras el reembolso';
  reset role;
  assert public.payments_apply_refund(gen_random_uuid(), 'REF-9', 1) = 'not_found', 'pedido inexistente';
  assert public.payments_apply_refund(t.pp('o1'), 'REF-8', 1) = 'not_paid', 'un pedido que no se pagó no se reembolsa';
  perform t.raises(format($q$ select public.payments_apply_refund('%s', 'x', 1) $q$, o), '22023');
end $$;

-- 9. Suscripción: alta, activación (acceso con gracia), cancelación (acceso hasta el fin de lo pagado), fallo de pago.
do $$ declare s uuid; e public.entitlements; nxt timestamptz := now() + interval '30 days'; begin
  s := public.payments_start_subscription('00000000-0000-4000-8000-0000000000f6', 'I-SUB0001', 'P-PLAN1');
  assert (select status from public.subscriptions where id = s) = 'approval_pending', 'queda pendiente de aprobación';
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000f6', true);
  set local role authenticated;
  assert not public.can_access_class(t.pp('curso_sub')), 'pendiente: sin acceso';
  reset role;

  assert public.payments_sync_subscription('I-SUB0001', null, 'P-PLAN1', 'active', nxt, now()) = 'ok', 'activada';
  select * into e from public.entitlements where source = 'paypal' and external_ref = 'I-SUB0001';
  assert e.scope = 'all' and e.plan = 'P-PLAN1', 'acceso a todo';
  assert e.expires_at = nxt + interval '2 days', 'acceso hasta la próxima fecha de cobro + 2 días de gracia';
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000f6', true);
  set local role authenticated;
  assert public.can_access_class(t.pp('curso_sub')), 'suscripta: acceso al contenido restringido';
  reset role;

  -- Renovación: se extiende; reenviar lo mismo no duplica el acceso.
  assert public.payments_sync_subscription('I-SUB0001', null, 'P-PLAN1', 'active', nxt + interval '30 days', now()) = 'ok', 'renovada';
  assert (select count(*) from public.entitlements where external_ref = 'I-SUB0001') = 1, 'un solo acceso';
  assert (select expires_at from public.entitlements where external_ref = 'I-SUB0001') = nxt + interval '32 days', 'se extendió';

  -- Pago fallido: suspendida. NO se extiende.
  assert public.payments_sync_subscription('I-SUB0001', null, 'P-PLAN1', 'suspended', null, null) = 'ok', 'suspendida';
  assert (select expires_at from public.entitlements where external_ref = 'I-SUB0001') = nxt + interval '32 days', 'suspendida: no se extiende';
  perform t.raises($q$ select public.payments_start_subscription('00000000-0000-4000-8000-0000000000f6', 'I-SUB0002', 'P-PLAN1') $q$, '23505'); -- ya tiene una viva

  -- Reactivada y luego cancelada: el acceso termina cuando vence el período PAGADO (sin la gracia), no al cancelar.
  perform public.payments_sync_subscription('I-SUB0001', null, 'P-PLAN1', 'active', nxt + interval '30 days', now());
  assert public.payments_sync_subscription('I-SUB0001', null, 'P-PLAN1', 'cancelled', null, null) = 'ok', 'cancelada';
  assert (select status from public.subscriptions where paypal_subscription_id = 'I-SUB0001') = 'cancelled', 'cancelada en la base';
  assert (select expires_at from public.entitlements where external_ref = 'I-SUB0001') = nxt + interval '30 days',
    'tras cancelar sigue hasta el fin del período pagado (sin gracia)';
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000f6', true);
  set local role authenticated;
  assert public.can_access_class(t.pp('curso_sub')), 'cancelada: todavía tiene lo que ya pagó';
  reset role;
  assert public.payments_sync_subscription('I-SUB0001', null, 'P-PLAN1', 'cancelled', null, null) = 'ok', 'cancelar dos veces no rompe nada';

  -- Una suscripción que nunca estuvo activa y se cancela no deja acceso.
  perform public.payments_start_subscription('00000000-0000-4000-8000-0000000000f5', 'I-SUB0003', 'P-PLAN1');
  perform public.payments_sync_subscription('I-SUB0003', null, 'P-PLAN1', 'cancelled', null, null);
  assert not exists (select 1 from public.entitlements where external_ref = 'I-SUB0003'), 'cancelada sin haber pagado: sin acceso';

  -- Llegó primero el webhook (la suscripción no estaba en la base): se crea con el usuario indicado, o se rechaza.
  assert public.payments_sync_subscription('I-SUB0004', null, 'P-PLAN1', 'active', nxt, now()) = 'unknown_subscription', 'sin usuario no se inventa nada';
  assert public.payments_sync_subscription('I-SUB0004', '00000000-0000-4000-8000-00000000dead', 'P-PLAN1', 'active', nxt, now()) = 'unknown_subscription', 'usuario inexistente';
  assert public.payments_sync_subscription('I-SUB0004', '00000000-0000-4000-8000-0000000000f7', 'P-PLAN1', 'active', nxt, now()) = 'ok', 'se crea para el usuario indicado';
  assert (select user_id from public.subscriptions where paypal_subscription_id = 'I-SUB0004') = '00000000-0000-4000-8000-0000000000f7', 'del usuario correcto';
  perform t.raises($q$ select public.payments_sync_subscription('I-SUB0004', null, 'P-PLAN1', 'rara', null, null) $q$, '22023');
end $$;

-- 10. Idempotencia del webhook
do $$ begin
  assert public.payments_event_begin('WH-EVT-1', 'PAYMENT.CAPTURE.COMPLETED', 'capture', 'CAP-1', '{"a":1}') = 'new', 'primera vez';
  assert public.payments_event_begin('WH-EVT-1', 'PAYMENT.CAPTURE.COMPLETED', 'capture', 'CAP-1', '{"a":1}') = 'retry', 'reenviado antes de terminar: se reintenta';
  perform public.payments_event_finish('WH-EVT-1', 'processed', null);
  assert public.payments_event_begin('WH-EVT-1', 'PAYMENT.CAPTURE.COMPLETED', 'capture', 'CAP-1', '{"a":1}') = 'duplicate', 'ya procesado: duplicado';
  assert (select count(*) from public.payment_events where event_id = 'WH-EVT-1') = 1, 'una sola fila por evento';
  assert public.payments_event_begin('WH-EVT-2', 'X.Y', null, null, null) = 'new';
  perform public.payments_event_finish('WH-EVT-2', 'failed', repeat('e', 900));
  assert length((select error from public.payment_events where event_id = 'WH-EVT-2')) = 500, 'el error se acota';
  assert public.payments_event_begin('WH-EVT-2', 'X.Y', null, null, null) = 'retry', 'un evento fallido se puede reintentar';
  assert (select attempts from public.payment_events where event_id = 'WH-EVT-2') = 2, 'cuenta los intentos';
  perform public.payments_event_finish('WH-EVT-3', 'ignored', null);
  perform t.raises($q$ select public.payments_event_finish('WH-EVT-1', 'otro', null) $q$, '22023');
end $$;

-- 11. RLS: cada persona ve solo lo suyo; el personal de gestión ve los pedidos; los eventos solo el desarrollador.
do $$ declare n integer; begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000f5', true);
  set local role authenticated;
  assert (select count(*) from public.orders where user_id <> auth.uid()) = 0, 'no ve pedidos ajenos';
  assert (select count(*) from public.orders) > 0, 've los propios';
  assert (select count(*) from public.order_items i where not exists (select 1 from public.orders o where o.id = i.order_id and o.user_id = auth.uid())) = 0, 'ni líneas ajenas';
  assert (select count(*) from public.subscriptions where user_id <> auth.uid()) = 0, 'ni suscripciones ajenas';
  assert (select count(*) from public.payment_events) = 0, 'un usuario común no ve los eventos técnicos';
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000f7', true);
  set local role authenticated;
  select count(*) into n from public.orders;
  assert n >= 5 and exists (select 1 from public.orders where user_id = '00000000-0000-4000-8000-0000000000f5'), 'el admin ve los pedidos de todos';
  assert (select count(*) from public.payment_events) = 0, 'el admin NO ve los eventos técnicos';
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000f8', true);
  set local role authenticated;
  assert (select count(*) from public.payment_events) > 0, 'el developer sí ve los eventos';
  reset role;
end $$;

-- 12. Precio de una clase: lo edita la gestión (queda auditado), un usuario común no.
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000f5', true);
  set local role authenticated;
  update public.classes set price_cents = 1 where id = t.pp('curso');
  assert (select price_cents from public.classes where id = t.pp('curso')) = 1210, 'un usuario común no cambia el precio (RLS: 0 filas)';
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000f7', true);
  set local role authenticated;
  update public.classes set price_cents = 1500 where id = t.pp('curso');
  reset role;
  assert (select price_cents from public.classes where id = t.pp('curso')) = 1500, 'el admin sí';
  assert exists (select 1 from public.audit_log where action = 'class.price_change' and entity_id = t.pp('curso')::text
                 and (details ->> 'price_from')::int = 1210 and (details ->> 'price_to')::int = 1500), 'el cambio de precio quedó auditado';
  perform t.raises(format($q$ update public.classes set price_cents = 0 where id = '%s' $q$, t.pp('curso')), '23514');
  -- el catálogo público puede leer el precio
  set local role anon;
  assert (select price_cents from public.classes where id = t.pp('curso')) = 1500, 'anon lee el precio de una clase publicada';
  reset role;
end $$;
