-- Pruebas del blindaje de las Fases 0-16 (migración 20261001120000) y del núcleo de la Fase 0 que no tenía
-- pruebas contra el SQL real: can_access_class() y save_progress(). Las pruebas de Deno usan una RÉPLICA en memoria
-- de esas reglas; estas son las que prueban las reglas de verdad, con PostgreSQL y los roles de Supabase.
-- Requiere el esquema de tests/roles_and_audit.test.sql (helper t.raises). Usuarios PROPIOS, como en las otras pruebas.

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000000c5', 'alumna@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000000c6', 'alumno2@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000000c7', 'owner-hard@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000000c8', 'dev-hard@test.dev', '{}');
update public.profiles set role = 'owner' where id = '00000000-0000-4000-8000-0000000000c7';
update public.profiles set role = 'developer' where id = '00000000-0000-4000-8000-0000000000c8';

-- Clases de prueba (las inserta el superusuario de la prueba; los CHECK de la base siguen vigentes).
create table t.h (name text primary key, id uuid);
insert into public.classes (title, video_status, is_published, access_level, duration_seconds) values
  ('h-free', 'ready', true, 'free', 1000),
  ('h-restricted', 'ready', true, 'restricted', 1000),
  ('h-restricted2', 'ready', true, 'restricted', 1000),
  ('h-draft', 'ready', false, 'free', 1000),
  ('h-nodur', 'ready', true, 'free', null);
insert into t.h select title, id from public.classes where title like 'h-%';
create function t.cid(n text) returns uuid language sql as $$ select id from t.h where name = n $$;
grant execute on function t.cid(text) to public;
grant select on t.h to public;

-- =============================================================================
-- A. can_access_class(): la matriz real
-- =============================================================================
-- A1. Sin sesión (anon) no puede ni ejecutarla.
do $$ begin
  set local role anon;
  perform t.raises($q$ select public.can_access_class(t.cid('h-free')) $q$, '42501');
  reset role;
end $$;

-- A2. Usuario común.
do $$
declare u constant uuid := '00000000-0000-4000-8000-0000000000c5';
begin
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
  assert public.can_access_class(t.cid('h-free')), 'una clase gratis publicada y lista es accesible';
  assert not public.can_access_class(t.cid('h-draft')), 'una clase NO publicada no es accesible para un usuario común';
  assert not public.can_access_class(t.cid('h-restricted')), 'una clase restringida sin entitlement NO es accesible';
  assert not public.can_access_class(gen_random_uuid()), 'una clase inexistente no es accesible';
  reset role;

  -- Entitlement de OTRA clase: no sirve.
  insert into public.entitlements (user_id, scope, class_id) values (u, 'class', t.cid('h-restricted2'));
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
  assert not public.can_access_class(t.cid('h-restricted')), 'el entitlement de otra clase no abre esta';
  assert public.can_access_class(t.cid('h-restricted2')), 'el entitlement de la clase sí la abre';
  reset role;

  -- Entitlement de alcance "all", primero vencido, luego vigente.
  insert into public.entitlements (user_id, scope, expires_at) values (u, 'all', now() - interval '1 minute');
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
  assert not public.can_access_class(t.cid('h-restricted')), 'un entitlement VENCIDO no abre nada';
  reset role;
  update public.entitlements set expires_at = now() + interval '1 day' where user_id = u and scope = 'all';
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
  assert public.can_access_class(t.cid('h-restricted')), 'un entitlement "all" vigente abre el contenido restringido';
  assert not public.can_access_class(t.cid('h-draft')), 'ni siquiera "all" abre una clase no publicada';
  reset role;
  update public.entitlements set expires_at = null where user_id = u and scope = 'all';
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
  assert public.can_access_class(t.cid('h-restricted')), 'sin vencimiento (null) sigue vigente';
  reset role;
end $$;

-- A3. Otro usuario no hereda el acceso de la anterior.
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000c6', true);
  set local role authenticated;
  assert not public.can_access_class(t.cid('h-restricted')), 'el entitlement es personal';
  assert not public.can_access_class(t.cid('h-restricted2')), 'el entitlement es personal';
  assert public.can_access_class(t.cid('h-free')), 'lo gratis sí';
  reset role;
end $$;

-- A4. Propietario y desarrollador acceden a todo (incluido borradores).
do $$ declare u uuid; begin
  foreach u in array array['00000000-0000-4000-8000-0000000000c7', '00000000-0000-4000-8000-0000000000c8']::uuid[] loop
    perform set_config('request.jwt.claim.sub', u::text, true);
    set local role authenticated;
    assert public.can_access_class(t.cid('h-draft')), 'el equipo ve borradores';
    assert public.can_access_class(t.cid('h-restricted')), 'el equipo ve lo restringido';
    reset role;
  end loop;
end $$;

-- A5. Un usuario no puede darse entitlements: ni insertar, ni editar, ni borrar.
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000c6', true);
  set local role authenticated;
  perform t.raises($q$ insert into public.entitlements (user_id, scope) values ('00000000-0000-4000-8000-0000000000c6', 'all') $q$, '42501');
  perform t.raises($q$ update public.entitlements set expires_at = null $q$, '42501');
  perform t.raises($q$ delete from public.entitlements $q$, '42501');
  assert (select count(*) from public.entitlements) = 0, 've solo los suyos (ninguno)';
  reset role;
end $$;

-- =============================================================================
-- B. save_progress()
-- =============================================================================
-- B1. Sin sesión.
do $$ begin
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
  perform t.raises($q$ select public.save_progress(t.cid('h-free'), 10) $q$, '42501');
  reset role;
  set local role authenticated;
  perform t.raises($q$ select public.save_progress(t.cid('h-free'), 10) $q$, '28000');
  reset role;
end $$;

-- B2. Entradas inválidas y sin acceso.
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000c6', true);
  set local role authenticated;
  perform t.raises($q$ select public.save_progress(null, 10) $q$, '22023');
  perform t.raises($q$ select public.save_progress(t.cid('h-free'), null) $q$, '22023');
  perform t.raises($q$ select public.save_progress(t.cid('h-restricted'), 10) $q$, '42501');   -- sin acceso
  perform t.raises($q$ select public.save_progress(t.cid('h-draft'), 10) $q$, '42501');        -- borrador
  perform t.raises($q$ select public.save_progress(gen_random_uuid(), 10) $q$, '42501');       -- inexistente
  reset role;
  assert not exists (select 1 from public.video_progress where user_id = '00000000-0000-4000-8000-0000000000c6'),
    'ningún intento fallido deja filas';
end $$;

-- B3. Acota a la duración, calcula "completada" (95 %) y la deja sticky.
do $$
declare r public.video_progress;
begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000c5', true);
  set local role authenticated;

  r := public.save_progress(t.cid('h-free'), 100);
  assert r.progress_seconds = 100 and not r.completed, 'avance normal';
  r := public.save_progress(t.cid('h-free'), -50);
  assert r.progress_seconds = 0, 'un valor negativo se acota a 0';
  r := public.save_progress(t.cid('h-free'), 999999);
  assert r.progress_seconds = 1000, 'no pasa de la duración';
  assert r.completed, 'al llegar al final queda completada';
  r := public.save_progress(t.cid('h-free'), 10);
  assert r.progress_seconds = 10 and r.completed, 'una vez completada, queda completada aunque se vuelva a empezar';

  r := public.save_progress(t.cid('h-restricted2'), 949);
  assert not r.completed, '94,9 % todavía no cuenta como terminada';
  r := public.save_progress(t.cid('h-restricted2'), 950);
  assert r.completed, '95 % exacto sí';
  reset role;

  assert (select count(*) from public.video_progress where user_id = '00000000-0000-4000-8000-0000000000c5') = 2,
    'una fila por usuario y clase (upsert, sin duplicados)';
end $$;

-- B4. Sin duración conocida: tope de 24 h (antes quedaba libre) y nunca "completada".
do $$ declare r public.video_progress; begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000c5', true);
  set local role authenticated;
  r := public.save_progress(t.cid('h-nodur'), 2000000000);
  assert r.progress_seconds = 86400, 'sin duración, tope de 24 h: %', r.progress_seconds;
  assert not r.completed, 'sin duración no se puede saber si terminó';
  reset role;
end $$;

-- B5. El propietario sobre una clase que no existe: error claro, no una violación de clave foránea.
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000c7', true);
  set local role authenticated;
  perform t.raises($q$ select public.save_progress(gen_random_uuid(), 10) $q$, 'P0002');
  reset role;
end $$;

-- B6. El progreso es privado y solo se escribe por la función.
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000c6', true);
  set local role authenticated;
  assert (select count(*) from public.video_progress) = 0, 'otro usuario no ve el progreso ajeno';
  perform t.raises($q$ insert into public.video_progress (user_id, class_id, progress_seconds) values ('00000000-0000-4000-8000-0000000000c6', t.cid('h-free'), 5) $q$, '42501');
  perform t.raises($q$ update public.video_progress set progress_seconds = 0 $q$, '42501');
  perform t.raises($q$ delete from public.video_progress $q$, '42501');
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000c7', true);
  set local role authenticated;
  assert (select count(*) from public.video_progress) = 0, 'ni siquiera el propietario lee el progreso de los alumnos';
  reset role;
end $$;

-- =============================================================================
-- C. rate_limit_hit()
-- =============================================================================
do $$ declare i int; ok boolean; begin
  set local role service_role;
  for i in 1..3 loop
    assert public.rate_limit_hit('rl:a', 3, 60), 'las primeras 3 pasan (intento %)', i;
  end loop;
  assert not public.rate_limit_hit('rl:a', 3, 60), 'la 4.ª se corta';
  assert not public.rate_limit_hit('rl:a', 3, 60), 'y las siguientes también';
  assert public.rate_limit_hit('rl:b', 3, 60), 'otra clave tiene su propio cupo';
  reset role;
end $$;

-- Al cambiar la ventana el cupo se renueva.
do $$ begin
  set local role service_role;
  assert public.rate_limit_hit('rl:win', 1, 1);
  assert not public.rate_limit_hit('rl:win', 1, 1);
  perform pg_sleep(1.2);
  assert public.rate_limit_hit('rl:win', 1, 1), 'ventana nueva = cupo nuevo';
  reset role;
end $$;

-- Argumentos inválidos.
do $$ begin
  set local role service_role;
  perform t.raises($q$ select public.rate_limit_hit('', 5, 60) $q$, '22023');
  perform t.raises($q$ select public.rate_limit_hit(null, 5, 60) $q$, '22023');
  perform t.raises($q$ select public.rate_limit_hit(repeat('x', 201), 5, 60) $q$, '22023');
  perform t.raises($q$ select public.rate_limit_hit('k', 0, 60) $q$, '22023');
  perform t.raises($q$ select public.rate_limit_hit('k', 5, 0) $q$, '22023');
  perform t.raises($q$ select public.rate_limit_hit('k', 5, 86401) $q$, '22023');
  reset role;
end $$;

-- Ningún cliente puede usarla ni tocar la tabla (un usuario no puede "limpiarse" el contador).
do $$ begin
  set local role anon;
  perform t.raises($q$ select public.rate_limit_hit('k', 5, 60) $q$, '42501');
  perform t.raises($q$ select * from public.rate_limits $q$, '42501');
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000c8', true);   -- ni el desarrollador, desde el navegador
  set local role authenticated;
  perform t.raises($q$ select public.rate_limit_hit('k', 5, 60) $q$, '42501');
  perform t.raises($q$ select * from public.rate_limits $q$, '42501');
  perform t.raises($q$ delete from public.rate_limits $q$, '42501');
  perform t.raises($q$ insert into public.rate_limits (key, window_start, hits) values ('x', now(), 0) $q$, '42501');
  reset role;
end $$;

-- =============================================================================
-- D. Topes y formato (productos y clases)
-- =============================================================================
do $$ begin
  insert into public.products (title, price_cents) values ('tope ok', 99999999);
  perform t.raises($q$ insert into public.products (title, price_cents) values ('caro', 100000000) $q$, '23514');
  perform t.raises($q$ insert into public.products (title, price_cents) values ('caro', 2147483647) $q$, '23514');
  insert into public.products (title, price_cents, stock) values ('stock ok', 1, 1000000);
  perform t.raises($q$ insert into public.products (title, price_cents, stock) values ('stock', 1, 1000001) $q$, '23514');

  insert into public.products (title, price_cents, image_url) values
    ('img https', 1, 'https://abc.supabase.co/storage/v1/object/public/product-images/x/y.webp'),
    ('img local', 1, 'http://127.0.0.1:54321/storage/v1/object/public/product-images/x/y.webp'),
    ('img localhost', 1, 'http://localhost:54321/a.png'),
    ('img null', 1, null);
  perform t.raises($q$ insert into public.products (title, price_cents, image_url) values ('x', 1, 'javascript:alert(1)') $q$, '23514');
  perform t.raises($q$ insert into public.products (title, price_cents, image_url) values ('x', 1, 'data:text/html,<script>1</script>') $q$, '23514');
  perform t.raises($q$ insert into public.products (title, price_cents, image_url) values ('x', 1, 'http://sitio-ajeno.com/p.png') $q$, '23514');
  perform t.raises($q$ insert into public.products (title, price_cents, image_url) values ('x', 1, 'http://localhost.evil.com/p.png') $q$, '23514');
  perform t.raises($q$ insert into public.products (title, price_cents, image_url) values ('x', 1, 'https://' || repeat('a', 2100)) $q$, '23514');

  perform t.raises($q$ insert into public.classes (title, thumbnail_url) values ('x', 'javascript:alert(1)') $q$, '23514');
  perform t.raises($q$ insert into public.classes (title, thumbnail_url) values ('x', 'http://sitio-ajeno.com/p.png') $q$, '23514');
  insert into public.classes (title, thumbnail_url) values ('thumb ok', 'https://abc.supabase.co/storage/v1/object/public/class-thumbnails/x/y.webp');

  perform t.raises($q$ insert into public.classes (title, duration_seconds) values ('x', 86401) $q$, '23514');
  perform t.raises($q$ insert into public.classes (title, duration_seconds) values ('x', -1) $q$, '23514');
  insert into public.classes (title, duration_seconds) values ('dur ok', 86400);
end $$;

-- El propietario también está sujeto a los topes (la barrera es la base, no el formulario).
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000c7', true);
  set local role authenticated;
  perform t.raises($q$ insert into public.products (title, price_cents) values ('desde el panel', 2000000000) $q$, '23514');
  perform t.raises($q$ insert into public.products (title, price_cents, image_url) values ('desde el panel', 100, 'javascript:alert(1)') $q$, '23514');
  reset role;
end $$;

-- =============================================================================
-- E. Auditoría de productos
-- =============================================================================
do $$
declare pid uuid; n int;
begin
  insert into public.products (title, price_cents, stock, is_active) values ('Mat auditado', 3000, 10, false) returning id into pid;
  select count(*) into n from public.audit_log where entity_type = 'product' and entity_id = pid::text;
  assert n = 0, 'crear no se audita (no es un cambio de datos sensibles)';

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000c7', true);
  set local role authenticated;
  update public.products set price_cents = 3500 where id = pid;
  update public.products set is_active = true where id = pid;
  update public.products set stock = 9, title = 'Mat auditado v2' where id = pid;     -- no audita
  update public.products set price_cents = 3500, is_active = true where id = pid;     -- mismos valores: no audita
  update public.products set is_active = false where id = pid;
  reset role;

  assert (select count(*) from public.audit_log where entity_id = pid::text and action = 'product.price_change') = 1, 'un cambio de precio';
  assert (select details ->> 'from' from public.audit_log where entity_id = pid::text and action = 'product.price_change') = '3000', 'precio anterior';
  assert (select details ->> 'to' from public.audit_log where entity_id = pid::text and action = 'product.price_change') = '3500', 'precio nuevo';
  assert (select actor_id from public.audit_log where entity_id = pid::text and action = 'product.price_change') = '00000000-0000-4000-8000-0000000000c7', 'queda quién lo hizo';
  assert (select actor_role from public.audit_log where entity_id = pid::text and action = 'product.price_change') = 'owner', 'y con qué rol';
  assert (select count(*) from public.audit_log where entity_id = pid::text and action = 'product.activate') = 1, 'activar';
  assert (select count(*) from public.audit_log where entity_id = pid::text and action = 'product.deactivate') = 1, 'ocultar';
  assert (select count(*) from public.audit_log where entity_id = pid::text) = 3, 'ni stock, ni título, ni updates sin cambio de valor';

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000c7', true);
  set local role authenticated;
  delete from public.products where id = pid;
  reset role;
  assert (select count(*) from public.audit_log where entity_id = pid::text and action = 'product.delete') = 1, 'borrar queda registrado';
  assert (select details ->> 'title' from public.audit_log where entity_id = pid::text and action = 'product.delete') = 'Mat auditado v2', 'con el título de ese momento';

  -- El historial de productos lo ve solo el desarrollador (misma regla que el resto del audit_log).
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000c7', true);
  set local role authenticated;
  assert not exists (select 1 from public.audit_log where entity_type = 'product'), 'el propietario no lee el historial interno';
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000c8', true);
  set local role authenticated;
  assert exists (select 1 from public.audit_log where entity_type = 'product'), 'el desarrollador sí';
  reset role;
end $$;

-- Un usuario común que "edita" un producto (0 filas afectadas por RLS) no deja rastro falso en la auditoría.
do $$ declare pid uuid; begin
  insert into public.products (title, price_cents, is_active) values ('Intocable', 1000, true) returning id into pid;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000c5', true);
  set local role authenticated;
  update public.products set price_cents = 1 where id = pid;
  delete from public.products where id = pid;
  reset role;
  assert not exists (select 1 from public.audit_log where entity_id = pid::text), 'lo que no ocurrió no se audita';
end $$;
