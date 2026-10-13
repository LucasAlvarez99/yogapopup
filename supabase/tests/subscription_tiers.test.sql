-- Suscripción en 3 niveles: precios, planes, acceso por nivel y permisos.
-- Requiere el esquema de tests/roles_and_audit.test.sql ya aplicado (helper t.raises). Usuarios PROPIOS (b2..b5).

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000000b2', 'nivel1@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000000b3', 'nivel3@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000000b4', 'manual@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000000b5', 'admin-niveles@test.dev', '{}');
update public.profiles set role = 'admin' where id = '00000000-0000-4000-8000-0000000000b5';

create table t.tiertest (name text primary key, id uuid);
grant all on t.tiertest to public;
create function t.tc(n text) returns uuid language sql as $$ select id from t.tiertest where name = n $$;
grant execute on function t.tc(text) to public;

-- Clases restringidas con distintos niveles
do $$ declare v uuid; begin
  insert into public.classes (title, access_level, video_status, is_published, r2_object_key, access_tiers)
    values ('Solo premium', 'restricted', 'ready', true, 'k/premium', '{3}') returning id into v;
  insert into t.tiertest values ('premium', v);
  insert into public.classes (title, access_level, video_status, is_published, r2_object_key, access_tiers)
    values ('Plus y premium', 'restricted', 'ready', true, 'k/plus', '{2,3}') returning id into v;
  insert into t.tiertest values ('plus', v);
  insert into public.classes (title, access_level, video_status, is_published, r2_object_key)
    values ('Para todos los niveles', 'restricted', 'ready', true, 'k/todos') returning id into v;
  insert into t.tiertest values ('todos', v);
end $$;

-- 1. Valores iniciales
do $$ begin
  assert (select count(*) from public.subscription_tiers) = 3, 'tres niveles';
  assert (select array_agg(price_cents order by tier) from public.subscription_tiers) = array[1000, 2000, 3000], '10, 20 y 30 euros';
  assert (select access_tiers from public.classes where id = t.tc('todos')) = '{1,2,3}', 'una clase nueva entra en los tres niveles';
end $$;

-- 2. Restricciones de datos
do $$ begin
  perform t.raises($q$ update public.classes set access_tiers = '{}' where title = 'Solo premium' $q$, '23514');
  perform t.raises($q$ update public.classes set access_tiers = '{4}' where title = 'Solo premium' $q$, '23514');
  perform t.raises($q$ update public.subscription_tiers set price_cents = 50 where tier = 1 $q$, '23514');
  perform t.raises($q$ update public.subscription_tiers set price_cents = 60000 where tier = 1 $q$, '23514');
  perform t.raises($q$ update public.subscription_tiers set name = '   ' where tier = 1 $q$, '23514');
  perform t.raises($q$ insert into public.subscription_tiers (tier, name, price_cents) values (4, 'X', 1000) $q$, '23514');
end $$;

-- 3. Guardar un nivel (solo service role): registra el plan nuevo y conserva el historial
do $$ begin
  assert public.payments_save_tier(1::smallint, '  Esencial  ', 'Todas las clases básicas', 1200, 'P-ESENCIAL-1') = 'ok';
  assert (select name from public.subscription_tiers where tier = 1) = 'Esencial', 'nombre sin espacios sobrantes';
  assert (select current_plan_id from public.subscription_tiers where tier = 1) = 'P-ESENCIAL-1', 'plan vigente';
  assert public.payments_save_tier(1::smallint, 'Esencial', 'Todas las clases básicas', 1500, 'P-ESENCIAL-2') = 'ok';
  assert (select count(*) from public.subscription_plans where tier = 1) = 2, 'el plan viejo queda en el historial';
  assert public.payments_save_tier(1::smallint, 'Esencial', 'Nuevo texto', 1500, null) = 'ok', 'solo texto: no toca el plan';
  assert (select current_plan_id from public.subscription_tiers where tier = 1) = 'P-ESENCIAL-2', 'el plan vigente se conserva';
  assert public.payments_save_tier(9::smallint, 'X', '', 1000, null) = 'unknown_tier';
  perform public.payments_save_tier(3::smallint, 'Premium', 'Una charla o clase gratis al mes', 3000, 'P-PREMIUM-1');
  perform public.payments_save_tier(2::smallint, 'Plus', '', 2000, 'P-PLUS-1');
end $$;

-- 4. Permisos: lectura pública sin el id del plan; nadie escribe desde el navegador
do $$ begin
  set local role anon;
  assert (select count(*) from public.subscription_tiers) = 3, 'se ofrece sin iniciar sesión';
  perform t.raises($q$ select current_plan_id from public.subscription_tiers $q$, '42501');
  perform t.raises($q$ select * from public.subscription_plans $q$, '42501');
  perform t.raises($q$ update public.subscription_tiers set price_cents = 100 $q$, '42501');
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000b5', true);
  set local role authenticated;
  perform t.raises($q$ update public.subscription_tiers set price_cents = 100 $q$, '42501');
  perform t.raises($q$ select public.payments_save_tier(1::smallint, 'X', '', 1000, null) $q$, '42501');
  assert (select count(*) from public.subscription_plans) = 4, 'la gestión ve el historial de planes';
  update public.classes set access_tiers = '{1,2}' where id = t.tc('plus');
  update public.classes set access_tiers = '{2,3}' where id = t.tc('plus');
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000b2', true);
  set local role authenticated;
  assert (select count(*) from public.subscription_plans) = 0, 'un alumno no ve los planes';
  update public.classes set access_tiers = '{1}' where id = t.tc('premium');
  assert (select access_tiers from public.classes where id = t.tc('premium')) = '{3}', 'un alumno no cambia los niveles de una clase';
  reset role;
end $$;

-- 5. Una suscripción concede el nivel de SU plan, y el acceso respeta los niveles de cada clase
do $$ begin
  perform public.payments_start_subscription('00000000-0000-4000-8000-0000000000b2', 'I-NIVEL1', 'P-ESENCIAL-2');
  assert (select tier from public.subscriptions where paypal_subscription_id = 'I-NIVEL1') = 1, 'el nivel sale del plan';
  perform public.payments_sync_subscription('I-NIVEL1', null, 'P-ESENCIAL-2', 'active', now() + interval '30 days', now());
  assert (select tier from public.entitlements where external_ref = 'I-NIVEL1') = 1, 'el acceso lleva el nivel';

  perform public.payments_start_subscription('00000000-0000-4000-8000-0000000000b3', 'I-NIVEL3', 'P-PREMIUM-1');
  perform public.payments_sync_subscription('I-NIVEL3', null, 'P-PREMIUM-1', 'active', now() + interval '30 days', now());

  insert into public.entitlements (user_id, scope, source) values ('00000000-0000-4000-8000-0000000000b4', 'all', 'manual');
end $$;

do $$ begin
  -- backend (service role)
  assert not public.payments_has_class_access('00000000-0000-4000-8000-0000000000b2', t.tc('premium')), 'nivel 1 no ve la clase solo premium';
  assert not public.payments_has_class_access('00000000-0000-4000-8000-0000000000b2', t.tc('plus')), 'nivel 1 no ve plus y premium';
  assert public.payments_has_class_access('00000000-0000-4000-8000-0000000000b2', t.tc('todos')), 'nivel 1 ve la de todos los niveles';
  assert public.payments_has_class_access('00000000-0000-4000-8000-0000000000b3', t.tc('premium')), 'nivel 3 ve la solo premium';
  assert public.payments_has_class_access('00000000-0000-4000-8000-0000000000b3', t.tc('plus')), 'nivel 3 ve plus y premium';
  assert public.payments_has_class_access('00000000-0000-4000-8000-0000000000b4', t.tc('premium')), 'acceso manual sin nivel: ve todo';

  -- lo que ve cada persona en la web (can_access_class)
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000b2', true);
  set local role authenticated;
  assert not public.can_access_class(t.tc('premium')), 'web: nivel 1 bloqueado en premium';
  assert public.can_access_class(t.tc('todos')), 'web: nivel 1 ve la de todos';
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000b3', true);
  set local role authenticated;
  assert public.can_access_class(t.tc('premium')) and public.can_access_class(t.tc('plus')), 'web: nivel 3 ve todo';
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000b5', true);
  set local role authenticated;
  assert public.can_access_class(t.tc('premium')), 'el admin ve todo';
  reset role;
end $$;

-- 6. Cancelar conserva el nivel hasta que vence lo pagado
do $$ begin
  perform public.payments_sync_subscription('I-NIVEL3', null, 'P-PREMIUM-1', 'cancelled', null, null);
  assert (select tier from public.entitlements where external_ref = 'I-NIVEL3') = 3, 'sigue con su nivel hasta el vencimiento';
  assert public.payments_has_class_access('00000000-0000-4000-8000-0000000000b3', t.tc('premium')), 'el acceso pagado sigue vigente';
end $$;
