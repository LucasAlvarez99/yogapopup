-- Pruebas de la Fase 4: matriz de permisos por rol, cambios de rol y auditoría inmutable.
-- Cada bloque falla con una excepción si algo no se cumple (psql corre con ON_ERROR_STOP).
create schema t;
grant usage on schema t to public;
create function t.raises(q text, expected text) returns void language plpgsql as $$
declare got text;
begin
  begin execute q; got := 'sin_error';
  exception when others then got := sqlstate; end;
  if got <> expected then raise exception 'esperaba SQLSTATE % pero fue % en: %', expected, got, q; end if;
end $$;
grant execute on function t.raises(text, text) to public;

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000000a1', 'user@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000000d1', 'dev@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000000d2', 'dev2@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000000f1', 'evil@test.dev', '{"role":"developer"}');   -- intenta escalar por metadata
update public.profiles set role = 'owner' where id = '00000000-0000-4000-8000-0000000000b1';
update public.profiles set role = 'developer' where id in ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000d2');

-- 1. La migración convirtió al admin de antes en owner, y el registro con metadata maliciosa sigue siendo 'user'.
do $$ begin
  assert (select role from public.profiles where id = '00000000-0000-4000-8000-0000000000e1') = 'owner', 'admin antiguo debe ser owner';
  assert (select role from public.profiles where id = '00000000-0000-4000-8000-0000000000f1') = 'user', 'la metadata no puede asignar rol';
  assert not exists (select 1 from public.profiles where role = 'admin'), 'no debe quedar ningún rol admin';
end $$;
-- Un rol inventado se rechaza
do $$ begin
  perform t.raises($q$ update public.profiles set role = 'admin' where id = '00000000-0000-4000-8000-0000000000a1' $q$, '23514');
end $$;

-- 2. Matriz de funciones de rol
do $$ declare r record; begin
  for r in select * from (values
      ('00000000-0000-4000-8000-0000000000a1'::uuid, 'user', false, false),
      ('00000000-0000-4000-8000-0000000000b1'::uuid, 'owner', true, false),
      ('00000000-0000-4000-8000-0000000000d1'::uuid, 'developer', true, true),
      ('00000000-0000-4000-8000-0000000000e1'::uuid, 'ex-admin', true, false)) v(id, label, o, d) loop
    perform set_config('request.jwt.claim.sub', r.id::text, true);
    set local role authenticated;
    assert public.is_owner() = r.o, format('is_owner de %s', r.label);
    assert public.is_developer() = r.d, format('is_developer de %s', r.label);
    assert public.is_admin() = r.o, format('is_admin (alias) de %s', r.label);
    reset role;
  end loop;
end $$;

-- 3. Clases: el usuario no escribe; owner y developer sí
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', true);
  set local role authenticated;
  perform t.raises($q$ insert into public.classes (title) values ('x') $q$, '42501');
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000b1', true);
  set local role authenticated;
  insert into public.classes (title) values ('creada por owner');
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000d1', true);
  set local role authenticated;
  insert into public.classes (title) values ('creada por developer');
  reset role;
  assert (select count(*) from public.classes) = 2;
end $$;

-- 4. Perfiles: cada uno ve el suyo; owner y developer ven todos; nadie edita roles directamente
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', true);
  set local role authenticated;
  assert (select count(*) from public.profiles) = 1, 'el usuario solo ve su perfil';
  perform t.raises($q$ update public.profiles set role = 'developer' where id = '00000000-0000-4000-8000-0000000000a1' $q$, '42501');
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000b1', true);
  set local role authenticated;
  assert (select count(*) from public.profiles) >= 6, 'el owner ve todos los perfiles';
  perform t.raises($q$ update public.profiles set role = 'developer' where id = '00000000-0000-4000-8000-0000000000b1' $q$, '42501');
  reset role;
end $$;

-- 5. Auditoría: solo el developer la lee; anon no accede
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', true);
  set local role authenticated;
  assert (select count(*) from public.audit_log) = 0, 'el usuario no ve auditoría';
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000b1', true);
  set local role authenticated;
  assert (select count(*) from public.audit_log) = 0, 'el owner no ve auditoría';
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000d1', true);
  set local role authenticated;
  assert (select count(*) from public.audit_log) > 0, 'el developer sí ve auditoría';
  perform t.raises($q$ insert into public.audit_log (action) values ('falso') $q$, '42501');
  reset role;
  set local role anon;
  perform t.raises($q$ select 1 from public.audit_log $q$, '42501');
  reset role;
end $$;

-- 6. set_user_role: solo developer; queda registrado con actor y rol reales
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', true);
  set local role authenticated;
  perform t.raises($q$ select public.set_user_role('00000000-0000-4000-8000-0000000000a1', 'developer') $q$, '42501');
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000b1', true);
  set local role authenticated;
  perform t.raises($q$ select public.set_user_role('00000000-0000-4000-8000-0000000000a1', 'owner') $q$, '42501');
  reset role;
  set local role anon;
  perform t.raises($q$ select public.set_user_role('00000000-0000-4000-8000-0000000000a1', 'owner') $q$, '42501');
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000d1', true);
  set local role authenticated;
  perform public.set_user_role('00000000-0000-4000-8000-0000000000a1', 'owner');
  perform t.raises($q$ select public.set_user_role('00000000-0000-4000-8000-0000000000a1', 'admin') $q$, '22023');
  perform t.raises($q$ select public.set_user_role('00000000-0000-4000-8000-0000000000a1', null) $q$, '22023');
  perform t.raises($q$ select public.set_user_role(gen_random_uuid(), 'owner') $q$, 'P0002');
  reset role;

  assert (select role from public.profiles where id = '00000000-0000-4000-8000-0000000000a1') = 'owner';
  assert exists (
    select 1 from public.audit_log
    where action = 'role.change' and entity_id = '00000000-0000-4000-8000-0000000000a1'
      and actor_id = '00000000-0000-4000-8000-0000000000d1' and actor_role = 'developer'
      and details = '{"from":"user","to":"owner"}'::jsonb), 'el cambio de rol debe quedar auditado con su actor';
  -- devolver a 'user' para no alterar el resto de pruebas
  update public.profiles set role = 'user' where id = '00000000-0000-4000-8000-0000000000a1';
end $$;

-- 7. El último developer no se puede quitar (ni por SQL directo)
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000d1', true);
  set local role authenticated;
  perform public.set_user_role('00000000-0000-4000-8000-0000000000d2', 'user');      -- queda uno: se puede
  perform t.raises($q$ select public.set_user_role('00000000-0000-4000-8000-0000000000d1', 'user') $q$, '23514');
  reset role;
  perform t.raises($q$ update public.profiles set role = 'owner' where id = '00000000-0000-4000-8000-0000000000d1' $q$, '23514');
  assert (select role from public.profiles where id = '00000000-0000-4000-8000-0000000000d1') = 'developer';
end $$;

-- 8. El historial es inmutable, incluso para service_role y para el dueño de la base
do $$ begin
  perform t.raises($q$ update public.audit_log set action = 'editado' $q$, '42501');
  perform t.raises($q$ delete from public.audit_log $q$, '42501');
  perform t.raises($q$ truncate public.audit_log $q$, '42501');
  set local role service_role;
  perform t.raises($q$ update public.audit_log set action = 'editado' $q$, '42501');
  perform t.raises($q$ delete from public.audit_log $q$, '42501');
  reset role;
end $$;

-- 9. audit_write: solo service_role; el rol del actor sale de la base, no del llamador
do $$ declare v bigint; begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000d1', true);
  set local role authenticated;
  perform t.raises($q$ select public.audit_write('00000000-0000-4000-8000-0000000000d1', 'x.forjada') $q$, '42501');
  reset role;
  set local role service_role;
  v := public.audit_write('00000000-0000-4000-8000-0000000000b1', 'class.delete', 'class', 'abc', '{"title":"t"}');
  reset role;
  assert (select actor_role from public.audit_log where id = v) = 'owner', 'el rol se busca en la base';
  assert (select details->>'title' from public.audit_log where id = v) = 't';
  assert (select entity_id from public.audit_log where id = v) = 'abc';
end $$;

-- 10. Borrar un usuario no toca ni bloquea su historial
do $$ begin
  delete from auth.users where id = '00000000-0000-4000-8000-0000000000b1';
  assert exists (select 1 from public.audit_log where actor_id = '00000000-0000-4000-8000-0000000000b1'), 'el historial del usuario borrado se conserva';
end $$;
