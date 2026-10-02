-- Pruebas de las tres escalas: user · admin · developer (migración 20261002120000).
-- Regla de oro:  admin = developer SIN subir.  Cada afirmación dice qué se espera y por qué.
-- Requiere el helper t.raises de tests/roles_and_audit.test.sql. Usuarios propios (ids ...0r*).

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-000000000ba1', 'esc-user@test.dev', '{}'),
  ('00000000-0000-4000-8000-000000000ba2', 'esc-admin@test.dev', '{}'),
  ('00000000-0000-4000-8000-000000000ba3', 'esc-dev@test.dev', '{}'),
  ('00000000-0000-4000-8000-000000000ba4', 'esc-dev2@test.dev', '{}');
update public.profiles set role = 'admin' where id = '00000000-0000-4000-8000-000000000ba2';
update public.profiles set role = 'developer' where id in ('00000000-0000-4000-8000-000000000ba3', '00000000-0000-4000-8000-000000000ba4');

-- Una clase publicada y una en borrador, creadas "por el backend" (superusuario de la prueba).
create table t.esc (name text primary key, id uuid);
insert into public.classes (title, video_status, is_published, access_level, duration_seconds) values
  ('esc-publicada', 'ready', true, 'free', 600),
  ('esc-borrador', 'ready', false, 'free', 600);
insert into t.esc select title, id from public.classes where title like 'esc-%';
grant select on t.esc to public;

-- =============================================================================
-- 1. Roles válidos: user, admin, developer. 'owner' (el nombre viejo) ya no existe.
-- =============================================================================
do $$ begin
  perform t.raises($q$ update public.profiles set role = 'owner' where id = '00000000-0000-4000-8000-000000000ba1' $q$, '23514');
  perform t.raises($q$ update public.profiles set role = 'superadmin' where id = '00000000-0000-4000-8000-000000000ba1' $q$, '23514');
  assert not exists (select 1 from public.profiles where role not in ('user', 'admin', 'developer')), 'solo roles válidos';
end $$;

-- =============================================================================
-- 2. Funciones de rol: is_staff = admin|developer · is_developer = solo developer · is_admin = alias de is_staff
-- =============================================================================
do $$ declare r record; begin
  for r in select * from (values
      ('00000000-0000-4000-8000-000000000ba1'::uuid, 'user',      false, false),
      ('00000000-0000-4000-8000-000000000ba2'::uuid, 'admin',     true,  false),
      ('00000000-0000-4000-8000-000000000ba3'::uuid, 'developer', true,  true)) v(id, label, staff, dev) loop
    perform set_config('request.jwt.claim.sub', r.id::text, true);
    set local role authenticated;
    assert public.is_staff() = r.staff, format('is_staff de %s', r.label);
    assert public.is_developer() = r.dev, format('is_developer de %s', r.label);
    -- is_admin() es un ALIAS de is_staff(): verdadero también para developer (queda documentado en la base).
    assert public.is_admin() = r.staff, format('is_admin (alias) de %s', r.label);
    reset role;
  end loop;
  -- Sin sesión: nada es verdadero.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  assert not public.is_staff() and not public.is_developer(), 'sin sesión no hay rol';
  reset role;
end $$;

-- =============================================================================
-- 3. SUBIR: solo developer. El admin no puede crear clases (que nacen con su video)
-- =============================================================================
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ba1', true);
  set local role authenticated;
  perform t.raises($q$ insert into public.classes (title) values ('user intenta') $q$, '42501');
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ba2', true);
  set local role authenticated;
  perform t.raises($q$ insert into public.classes (title) values ('admin intenta') $q$, '42501');
  perform t.raises($q$ insert into public.classes (title, is_published) values ('admin intenta publicada', true) $q$, '42501');
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ba3', true);
  set local role authenticated;
  insert into public.classes (title) values ('esc-del-developer');
  reset role;

  assert not exists (select 1 from public.classes where title in ('user intenta', 'admin intenta', 'admin intenta publicada')),
    'ninguna clase de user/admin quedó creada';
  assert exists (select 1 from public.classes where title = 'esc-del-developer'), 'la del developer sí';
end $$;

-- =============================================================================
-- 4. EDITAR, PUBLICAR/DESPUBLICAR: admin y developer sí; user no. BORRAR: no hay DELETE directo para nadie
--    (el borrado pasa por la Edge Function, que exige admin o developer).
-- =============================================================================
do $$ declare cid uuid := (select id from t.esc where name = 'esc-borrador'); n int; begin
  -- user: no ve el borrador y no puede editar
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ba1', true);
  set local role authenticated;
  assert not exists (select 1 from public.classes where id = cid), 'el user no ve borradores';
  update public.classes set title = 'hackeada' where id = (select id from t.esc where name = 'esc-publicada');
  get diagnostics n = row_count;
  assert n = 0, 'el user no edita (RLS filtra la fila)';
  reset role;

  -- admin y developer: ven el borrador, editan, publican y despublican
  for n in 1..2 loop
    perform set_config('request.jwt.claim.sub',
      case n when 1 then '00000000-0000-4000-8000-000000000ba2' else '00000000-0000-4000-8000-000000000ba3' end, true);
    set local role authenticated;
    assert exists (select 1 from public.classes where id = cid), 'el equipo ve borradores';
    update public.classes set title = 'esc-borrador', description = 'editada ' || n where id = cid;
    update public.classes set is_published = true where id = cid;
    update public.classes set is_published = false where id = cid;
    reset role;
    assert (select description from public.classes where id = cid) = 'editada ' || n, 'la edición se guardó';
  end loop;

  -- Nadie borra filas desde el navegador (ni siquiera el developer): el borrado va por la Edge Function.
  foreach n in array array[1, 2, 3] loop
    perform set_config('request.jwt.claim.sub',
      case n when 1 then '00000000-0000-4000-8000-000000000ba1' when 2 then '00000000-0000-4000-8000-000000000ba2'
        else '00000000-0000-4000-8000-000000000ba3' end, true);
    set local role authenticated;
    perform t.raises($q$ delete from public.classes $q$, '42501');
    reset role;
  end loop;
end $$;

-- El admin tampoco puede tocar los campos que solo escribe el backend (el video y su estado).
do $$ declare cid uuid := (select id from t.esc where name = 'esc-publicada'); begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ba2', true);
  set local role authenticated;
  perform t.raises(format($q$ update public.classes set video_status = 'ready' where id = %L $q$, cid), '42501');
  perform t.raises(format($q$ update public.classes set r2_object_key = 'classes/x/y.mp4' where id = %L $q$, cid), '42501');
  perform t.raises(format($q$ update public.classes set duration_seconds = 1 where id = %L $q$, cid), '42501');
  perform t.raises(format($q$ select r2_object_key from public.classes where id = %L $q$, cid), '42501');   -- ni leerlo
  reset role;
end $$;

-- =============================================================================
-- 5. PRODUCTOS (crear, editar, activar/ocultar, borrar): admin y developer sí; user no
-- =============================================================================
do $$ declare pid uuid; n int; begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ba1', true);
  set local role authenticated;
  perform t.raises($q$ insert into public.products (title, price_cents) values ('user intenta', 100) $q$, '42501');
  reset role;

  for n in 1..2 loop
    perform set_config('request.jwt.claim.sub',
      case n when 1 then '00000000-0000-4000-8000-000000000ba2' else '00000000-0000-4000-8000-000000000ba3' end, true);
    set local role authenticated;
    insert into public.products (title, price_cents, is_active) values ('esc-producto-' || n, 1500, false) returning id into pid;
    update public.products set price_cents = 1600, description = 'editado' where id = pid;
    update public.products set is_active = true where id = pid;
    assert (select count(*) from public.products where id = pid and is_active and price_cents = 1600) = 1, 'creó, editó y activó';
    update public.products set is_active = false where id = pid;
    delete from public.products where id = pid;
    assert not exists (select 1 from public.products where id = pid), 'lo borró';
    reset role;
  end loop;
end $$;

-- =============================================================================
-- 6. IMÁGENES (miniaturas y fotos de producto) son parte de "editar": admin y developer sí; user no
-- =============================================================================
do $$ declare n int; begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ba1', true);
  set local role authenticated;
  perform t.raises($q$ insert into storage.objects (bucket_id, name) values ('product-images', 'esc/user.webp') $q$, '42501');
  perform t.raises($q$ insert into storage.objects (bucket_id, name) values ('class-thumbnails', 'esc/user.webp') $q$, '42501');
  reset role;

  for n in 1..2 loop
    perform set_config('request.jwt.claim.sub',
      case n when 1 then '00000000-0000-4000-8000-000000000ba2' else '00000000-0000-4000-8000-000000000ba3' end, true);
    set local role authenticated;
    insert into storage.objects (bucket_id, name) values ('product-images', 'esc/p' || n || '.webp');
    insert into storage.objects (bucket_id, name) values ('class-thumbnails', 'esc/c' || n || '.webp');
    reset role;
  end loop;
  assert (select count(*) from storage.objects where name like 'esc/%') = 4, 'admin y developer subieron sus 2 imágenes cada uno';
end $$;

-- =============================================================================
-- 7. ROLES Y AUDITORÍA INTERNA: solo developer. El admin no puede ascenderse ni ascender a nadie.
-- =============================================================================
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ba2', true);
  set local role authenticated;
  perform t.raises($q$ select public.set_user_role('00000000-0000-4000-8000-000000000ba2', 'developer') $q$, '42501');   -- ascenderse
  perform t.raises($q$ select public.set_user_role('00000000-0000-4000-8000-000000000ba1', 'admin') $q$, '42501');       -- ascender a otro
  perform t.raises($q$ update public.profiles set role = 'developer' where id = '00000000-0000-4000-8000-000000000ba2' $q$, '42501');
  assert (select count(*) from public.audit_log) = 0, 'el admin no lee el historial interno';
  perform t.raises($q$ select * from public.rate_limits $q$, '42501');
  perform t.raises($q$ select public.rate_limit_hit('x', 5, 60) $q$, '42501');
  reset role;
  assert (select role from public.profiles where id = '00000000-0000-4000-8000-000000000ba2') = 'admin', 'sigue siendo admin';
end $$;

do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ba3', true);
  set local role authenticated;
  perform public.set_user_role('00000000-0000-4000-8000-000000000ba1', 'admin');      -- el developer sí puede
  perform public.set_user_role('00000000-0000-4000-8000-000000000ba1', 'user');
  assert exists (select 1 from public.audit_log), 'el developer lee el historial interno';
  reset role;
  assert exists (
    select 1 from public.audit_log
    where action = 'role.change' and entity_id = '00000000-0000-4000-8000-000000000ba1'
      and actor_id = '00000000-0000-4000-8000-000000000ba3' and actor_role = 'developer'
      and details = '{"from":"user","to":"admin"}'::jsonb), 'el cambio queda auditado con su actor';
end $$;

-- =============================================================================
-- 8. ACCESO A VIDEO: el equipo (admin y developer) ve todo, incluso borradores; el user solo lo publicado
-- =============================================================================
do $$ declare draft uuid := (select id from t.esc where name = 'esc-borrador'); begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ba1', true);
  set local role authenticated;
  assert not public.can_access_class(draft), 'el user no accede al borrador';
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ba2', true);
  set local role authenticated;
  assert public.can_access_class(draft), 'el admin sí (para revisar antes de publicar)';
  reset role;
end $$;

-- =============================================================================
-- 9. Los permisos de ejecución de las funciones renombradas siguen siendo los correctos
-- =============================================================================
do $$ begin
  set local role anon;
  perform t.raises($q$ select public.is_staff() $q$, '42501');
  perform t.raises($q$ select public.is_developer() $q$, '42501');
  perform t.raises($q$ select public.is_admin() $q$, '42501');
  reset role;
  assert to_regprocedure('public.is_owner()') is null, 'is_owner() ya no existe (ahora is_staff())';
end $$;
