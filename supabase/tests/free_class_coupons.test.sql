-- Cupón mensual de clase virtual gratis (nivel 3): emisión, canje, devolución y permisos.
-- Requiere el esquema de tests/roles_and_audit.test.sql ya aplicado (helper t.raises). Usuarios PROPIOS (a1a1.. ver ids).

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000a1001', 'cupon-n3@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000a1002', 'cupon-n2@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000a1003', 'cupon-otra@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000a1004', 'cupon-vencida@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000a1005', 'cupon-prof@test.dev', '{}');

create table t.coutest (name text primary key, id uuid);
grant all on t.coutest to public;
create function t.cc(n text) returns uuid language sql as $$ select id from t.coutest where name = n $$;
grant execute on function t.cc(text) to public;

do $$ declare sid uuid; begin
  insert into public.teachers (profile_id, public_name) values ('00000000-0000-4000-8000-0000000a1005', 'Profe Cupón');
  insert into public.live_sessions (teacher_id, title, mode, starts_at, capacity)
    values ('00000000-0000-4000-8000-0000000a1005', 'Virtual 1', 'virtual', now() + interval '2 days', 10) returning id into sid;
  insert into t.coutest values ('virtual1', sid);
  insert into public.live_sessions (teacher_id, title, mode, starts_at, capacity)
    values ('00000000-0000-4000-8000-0000000a1005', 'Virtual 2', 'virtual', now() + interval '3 days', 10) returning id into sid;
  insert into t.coutest values ('virtual2', sid);
  insert into public.live_sessions (teacher_id, title, mode, starts_at, capacity)
    values ('00000000-0000-4000-8000-0000000a1005', 'Presencial', 'live', now() + interval '2 days', 10) returning id into sid;
  insert into t.coutest values ('presencial', sid);
  insert into public.live_sessions (teacher_id, title, mode, starts_at, capacity)
    values ('00000000-0000-4000-8000-0000000a1005', 'Virtual llena', 'virtual', now() + interval '2 days', 1) returning id into sid;
  insert into t.coutest values ('llena', sid);
  insert into public.live_bookings (session_id, user_id) values (sid, '00000000-0000-4000-8000-0000000a1005');

  -- Suscripciones: nivel 3 (1 clase gratis), nivel 2 (ninguna) y una de nivel 3 ya vencida
  perform public.payments_save_tier(2::smallint, 'Plus', '', 2000, 'P-CUP-2');
  perform public.payments_save_tier(3::smallint, 'Premium', '', 3000, 'P-CUP-3');
  perform public.payments_start_subscription('00000000-0000-4000-8000-0000000a1001', 'I-CUP3', 'P-CUP-3');
  perform public.payments_sync_subscription('I-CUP3', null, 'P-CUP-3', 'active', now() + interval '30 days', now());
  perform public.payments_start_subscription('00000000-0000-4000-8000-0000000a1002', 'I-CUP2', 'P-CUP-2');
  perform public.payments_sync_subscription('I-CUP2', null, 'P-CUP-2', 'active', now() + interval '30 days', now());
  insert into public.entitlements (user_id, scope, tier, source, external_ref, expires_at)
    values ('00000000-0000-4000-8000-0000000a1004', 'all', 3, 'paypal', 'I-CUP-VIEJA', now() - interval '3 days');
end $$;

-- 1. Emisión: solo para los niveles con clases gratis, una vez por mes (idempotente)
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000a1001', true);
  set local role authenticated;
  assert public.claim_my_free_class_coupons() = 1, 'nivel 3: se crea el cupón del mes';
  assert public.claim_my_free_class_coupons() = 0, 'pedirlo de nuevo no duplica';
  assert (select count(*) from public.free_class_coupons) = 1, 've solo el suyo (1)';
  assert (select redeemed_at from public.free_class_coupons) is null, 'sin usar';
  assert (select period from public.free_class_coupons) = date_trunc('month', now() at time zone 'utc')::date, 'del mes actual';
  assert (select expires_at from public.free_class_coupons) = (date_trunc('month', now() at time zone 'utc') + interval '1 month') at time zone 'utc', 'vence a fin de mes';
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000a1002', true);
  set local role authenticated;
  assert public.claim_my_free_class_coupons() = 0, 'nivel 2: sin clases gratis';
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000a1003', true);
  set local role authenticated;
  assert public.claim_my_free_class_coupons() = 0, 'sin suscripción: nada';
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000a1004', true);
  set local role authenticated;
  assert public.claim_my_free_class_coupons() = 0, 'suscripción vencida: nada';
  reset role;
  assert (select count(*) from public.free_class_coupons) = 1, 'un solo cupón en total';

  -- Sin sesión no se puede
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform t.raises($q$ select public.claim_my_free_class_coupons() $q$, '42501');
  reset role;
  set local role anon;
  perform t.raises($q$ select public.claim_my_free_class_coupons() $q$, '42501');
  reset role;
end $$;

-- 2. Si la gestión sube las clases gratis del nivel, aparece el cupón que falta (sin duplicar el que ya está)
do $$ begin
  perform public.payments_save_tier(3::smallint, 'Premium', '', 3000, null, 700, 2);
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000a1001', true);
  set local role authenticated;
  assert public.claim_my_free_class_coupons() = 1, 'se crea solo el que faltaba';
  assert (select count(*) from public.free_class_coupons) = 2;
  reset role;
  perform public.payments_save_tier(3::smallint, 'Premium', '', 3000, null, 700, 1);
  -- el segundo cupón se descarta para el resto de la prueba (la gestión volvió a 1)
  delete from public.free_class_coupons where slot = 2;
end $$;

-- 3. Canje: reserva y cupón juntos; una persona no usa el cupón de otra; un cupón se usa una sola vez
do $$ declare c uuid; begin
  select id into c from public.free_class_coupons where user_id = '00000000-0000-4000-8000-0000000a1001';
  insert into t.coutest values ('cupon', c);

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000a1003', true);
  set local role authenticated;
  perform t.raises(format($q$ select public.redeem_free_class_coupon('%s', '%s') $q$, c, t.cc('virtual1')), 'P0002'); -- cupón ajeno
  assert (select count(*) from public.free_class_coupons) = 0, 'no ve cupones ajenos';
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000a1001', true);
  set local role authenticated;
  perform t.raises(format($q$ select public.redeem_free_class_coupon('%s', '%s') $q$, c, t.cc('presencial')), '22023'); -- no es virtual
  perform t.raises(format($q$ select public.redeem_free_class_coupon('%s', '%s') $q$, c, t.cc('llena')), '23514'); -- sin cupo
  perform t.raises(format($q$ select public.redeem_free_class_coupon('%s', '%s') $q$, c, gen_random_uuid()), 'P0002'); -- no existe
  assert (select redeemed_at from public.free_class_coupons where id = c) is null, 'los intentos fallidos no gastan el cupón';
  assert not exists (select 1 from public.live_bookings where user_id = '00000000-0000-4000-8000-0000000a1001'), 'ni dejan reservas';

  assert public.redeem_free_class_coupon(c, t.cc('virtual1')) = 'booked', 'canje';
  assert (select redeemed_at is not null and session_id = t.cc('virtual1') from public.free_class_coupons where id = c), 'cupón usado en esa clase';
  assert (select coupon_id from public.live_bookings where user_id = '00000000-0000-4000-8000-0000000a1001' and session_id = t.cc('virtual1')) = c, 'la reserva guarda el cupón';
  perform t.raises(format($q$ select public.redeem_free_class_coupon('%s', '%s') $q$, c, t.cc('virtual2')), 'P0002'); -- ya usado
  reset role;
end $$;

-- 4. Cancelar a tiempo devuelve el cupón; se puede usar de nuevo en otra clase
do $$ declare c uuid := t.cc('cupon'); begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000a1001', true);
  set local role authenticated;
  perform public.cancel_live_booking(t.cc('virtual1'));
  assert not exists (select 1 from public.live_bookings where user_id = '00000000-0000-4000-8000-0000000a1001'), 'reserva cancelada';
  assert (select redeemed_at is null and session_id is null from public.free_class_coupons where id = c), 'el cupón vuelve';
  assert public.redeem_free_class_coupon(c, t.cc('virtual2')) = 'booked', 'se usa en otra clase';
  reset role;
end $$;

-- 5. Si ya estaba anotada, no se gasta el cupón (una reserva común no lo toca)
do $$ declare c uuid := t.cc('cupon'); begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000a1001', true);
  set local role authenticated;
  perform public.cancel_live_booking(t.cc('virtual2'));
  perform public.book_live_session(t.cc('virtual1'));                -- reserva común (sin cupón)
  assert (select redeemed_at from public.free_class_coupons where id = c) is null;
  perform t.raises(format($q$ select public.redeem_free_class_coupon('%s', '%s') $q$, c, t.cc('virtual1')), '23505'); -- ya anotada
  assert (select redeemed_at from public.free_class_coupons where id = c) is null, 'no se gastó el cupón';
  perform public.cancel_live_booking(t.cc('virtual1'));
  assert (select redeemed_at from public.free_class_coupons where id = c) is null, 'cancelar una reserva común no toca el cupón';
  reset role;
end $$;

-- 6. Un cupón vencido no se usa (lo que no se usa en el mes se pierde: no se acumula)
do $$ declare c uuid := t.cc('cupon'); begin
  update public.free_class_coupons set expires_at = now() - interval '1 minute' where id = c;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000a1001', true);
  set local role authenticated;
  perform t.raises(format($q$ select public.redeem_free_class_coupon('%s', '%s') $q$, c, t.cc('virtual2')), 'P0002');
  reset role;
  -- y el mes siguiente se emite uno nuevo, no se suma al viejo
  update public.free_class_coupons set period = (period - interval '1 month')::date where id = c;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000a1001', true);
  set local role authenticated;
  assert public.claim_my_free_class_coupons() = 1, 'mes nuevo: cupón nuevo';
  assert (select count(*) from public.free_class_coupons where redeemed_at is null and expires_at > now()) = 1, 'solo uno vigente: no se acumulan';
  reset role;
end $$;

-- 7. Permisos: nadie escribe cupones directamente; anon no ve nada
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000a1001', true);
  set local role authenticated;
  perform t.raises($q$ insert into public.free_class_coupons (user_id, period, expires_at) values ('00000000-0000-4000-8000-0000000a1001', '2030-01-01', now()) $q$, '42501');
  perform t.raises($q$ update public.free_class_coupons set redeemed_at = null $q$, '42501');
  perform t.raises($q$ delete from public.free_class_coupons $q$, '42501');
  reset role;
  set local role anon;
  perform t.raises($q$ select * from public.free_class_coupons $q$, '42501');
  reset role;
end $$;
