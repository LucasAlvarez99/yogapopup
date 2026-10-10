-- Pruebas de comentarios y moderación (migración 20261009120000). Usuarios propios (ids ...0e*).
-- Requiere el helper t.raises de tests/shim.sql.

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-000000000e01', 'tm-ana@test.dev',   '{"display_name":"Ana Alumna"}'),
  ('00000000-0000-4000-8000-000000000e02', 'tm-beto@test.dev',  '{"display_name":"Beto"}'),
  ('00000000-0000-4000-8000-000000000e03', 'tm-admin@test.dev', '{"display_name":"Manu"}'),
  ('00000000-0000-4000-8000-000000000e04', 'tm-prof@test.dev',  '{"display_name":"Lucía"}'),
  ('00000000-0000-4000-8000-000000000e05', 'tm-dev@test.dev',   '{"display_name":"Dev"}'),
  ('00000000-0000-4000-8000-000000000e06', 'tm-sinnombre@test.dev', '{}');
update public.profiles set display_name = 'Ana Alumna' where id = '00000000-0000-4000-8000-000000000e01';
update public.profiles set display_name = 'Beto' where id = '00000000-0000-4000-8000-000000000e02';
update public.profiles set display_name = null where id = '00000000-0000-4000-8000-000000000e06';
update public.profiles set role = 'admin'     where id = '00000000-0000-4000-8000-000000000e03';
update public.profiles set role = 'profesor'  where id = '00000000-0000-4000-8000-000000000e04';
update public.profiles set role = 'developer' where id = '00000000-0000-4000-8000-000000000e05';

-- 1. Escribir: queda pendiente, con el nombre del perfil (aunque la persona mande otro) y sin poder aprobarse sola.
do $$ declare v_id uuid; begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e01', true);
  set local role authenticated;
  insert into public.testimonials (body, rating) values ('  Las clases me cambiaron la semana.  ', 5) returning id into v_id;
  assert (select status from public.testimonials where id = v_id) = 'pending', 'nace pendiente';
  assert (select author_name from public.testimonials where id = v_id) = 'Ana Alumna', 'nombre del perfil';
  assert (select body from public.testimonials where id = v_id) = 'Las clases me cambiaron la semana.', 'texto sin espacios de los extremos';
  assert (select user_id from public.testimonials where id = v_id) = '00000000-0000-4000-8000-000000000e01', 'user_id lo pone la base';
  -- no se puede mandar estado, nombre ni dueño propios
  perform t.raises($q$ insert into public.testimonials (body, status) values ('Texto largo suficiente', 'approved') $q$, '42501');
  perform t.raises($q$ insert into public.testimonials (body, author_name) values ('Texto largo suficiente', 'Otro') $q$, '42501');
  perform t.raises($q$ insert into public.testimonials (body, user_id) values ('Texto largo suficiente', '00000000-0000-4000-8000-000000000e02') $q$, '42501');
  -- uno por persona
  perform t.raises($q$ insert into public.testimonials (body) values ('Un segundo comentario valido') $q$, '23505');
  reset role;
end $$;

-- 2. Validaciones de texto y puntuación
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e02', true);
  set local role authenticated;
  perform t.raises($q$ insert into public.testimonials (body) values ('corto') $q$, '23514');
  perform t.raises($q$ insert into public.testimonials (body) values ('          ') $q$, '23514');
  perform t.raises($q$ insert into public.testimonials (body) values (repeat('a', 601)) $q$, '23514');
  perform t.raises($q$ insert into public.testimonials (body, rating) values ('Texto largo suficiente', 6) $q$, '23514');
  perform t.raises($q$ insert into public.testimonials (body, rating) values ('Texto largo suficiente', 0) $q$, '23514');
  reset role;
  -- sin sesión no se escribe
  set local role anon;
  perform t.raises($q$ insert into public.testimonials (body) values ('Texto largo suficiente') $q$, '42501');
  reset role;
end $$;

-- 3. Sin nombre en el perfil se muestra 'Alumno/a' (nunca el correo)
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e06', true);
  set local role authenticated;
  insert into public.testimonials (body) values ('Me encantó la clase de relajación');
  reset role;
  assert (select author_name from public.testimonials where user_id = '00000000-0000-4000-8000-000000000e06') = 'Alumno/a';
  delete from public.testimonials where user_id = '00000000-0000-4000-8000-000000000e06';
end $$;

-- 4. Hasta que se aprueba, nadie más lo ve; el público ve solo lo aprobado y sin datos de la cuenta
do $$ declare v_id uuid; begin
  v_id := (select id from public.testimonials where user_id = '00000000-0000-4000-8000-000000000e01');

  set local role anon;
  assert (select count(*) from public.testimonials) = 0, 'anon no ve pendientes';
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e02', true);
  set local role authenticated;
  assert (select count(*) from public.testimonials) = 0, 'otra persona no ve el pendiente de Ana';
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e01', true);
  set local role authenticated;
  assert (select count(*) from public.testimonials) = 1, 'Ana ve el suyo';
  reset role;

  -- el profesor NO es gestión
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e04', true);
  set local role authenticated;
  assert (select count(*) from public.testimonials) = 0, 'profesor: no ve pendientes ajenos';
  update public.testimonials set status = 'approved' where id = v_id;   -- RLS: no ve la fila, 0 filas
  reset role;
  assert (select status from public.testimonials where id = v_id) = 'pending', 'el profesor no pudo aprobar';
end $$;

-- 5. Moderar: solo la gestión; Ana no se aprueba sola; queda auditado
do $$ declare v_id uuid; begin
  v_id := (select id from public.testimonials where user_id = '00000000-0000-4000-8000-000000000e01');

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e01', true);
  set local role authenticated;
  perform t.raises(format($q$ update public.testimonials set status = 'approved' where id = %L $q$, v_id), '42501');
  reset role;
  assert (select status from public.testimonials where id = v_id) = 'pending';

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e03', true);   -- admin
  set local role authenticated;
  assert (select count(*) from public.testimonials) = 1, 'la gestión ve los pendientes';
  update public.testimonials set status = 'approved' where id = v_id;
  reset role;
  assert (select status from public.testimonials where id = v_id) = 'approved';
  assert (select moderated_by from public.testimonials where id = v_id) = '00000000-0000-4000-8000-000000000e03', 'quién moderó';
  assert exists (select 1 from public.audit_log where action = 'testimonial.moderate' and entity_id = v_id::text
                 and details->>'from' = 'pending' and details->>'to' = 'approved'), 'la aprobación queda auditada';

  -- ahora lo ve cualquiera, con solo las columnas públicas
  set local role anon;
  assert (select count(*) from public.testimonials) = 1, 'anon ve el aprobado';
  assert (select author_name from public.testimonials) = 'Ana Alumna';
  perform t.raises($q$ select user_id from public.testimonials $q$, '42501');
  perform t.raises($q$ select status from public.testimonials $q$, '42501');
  perform t.raises($q$ select moderated_by from public.testimonials $q$, '42501');
  reset role;
end $$;

-- 6. Si Ana edita lo aprobado, vuelve a revisión (y deja de ser público)
do $$ declare v_id uuid; begin
  v_id := (select id from public.testimonials where user_id = '00000000-0000-4000-8000-000000000e01');
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e01', true);
  set local role authenticated;
  update public.testimonials set body = 'Ahora con el texto cambiado por completo' where id = v_id;
  reset role;
  assert (select status from public.testimonials where id = v_id) = 'pending', 'editar vuelve a pendiente';
  assert (select moderated_by from public.testimonials where id = v_id) is null;
  set local role anon;
  assert (select count(*) from public.testimonials) = 0, 'ya no es público';
  reset role;
  -- no puede tocar columnas que no son suyas
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e01', true);
  set local role authenticated;
  perform t.raises(format($q$ update public.testimonials set user_id = '00000000-0000-4000-8000-000000000e02' where id = %L $q$, v_id), '42501');
  perform t.raises(format($q$ update public.testimonials set author_name = 'Otra' where id = %L $q$, v_id), '42501');
  reset role;
end $$;

-- 7. Ocultar, editar y borrar ajenos (gestión); Beto no toca lo de Ana
do $$ declare v_id uuid; begin
  v_id := (select id from public.testimonials where user_id = '00000000-0000-4000-8000-000000000e01');

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e02', true);   -- Beto
  set local role authenticated;
  update public.testimonials set body = 'Intento pisar el comentario de otra persona' where id = v_id;   -- RLS: 0 filas
  delete from public.testimonials where id = v_id;
  reset role;
  assert (select body from public.testimonials where id = v_id) = 'Ahora con el texto cambiado por completo', 'Beto no pudo editar';
  assert exists (select 1 from public.testimonials where id = v_id), 'Beto no pudo borrar';

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e05', true);   -- developer
  set local role authenticated;
  update public.testimonials set status = 'approved' where id = v_id;
  update public.testimonials set status = 'hidden' where id = v_id;
  reset role;
  assert (select status from public.testimonials where id = v_id) = 'hidden';
  set local role anon;
  assert (select count(*) from public.testimonials) = 0, 'oculto: no es público';
  reset role;
  -- el autor lo sigue viendo (y sabe que no está público)
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e01', true);
  set local role authenticated;
  assert (select status from public.testimonials where id = v_id) = 'hidden';
  reset role;

  -- la gestión borra uno ajeno: queda auditado
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e03', true);
  set local role authenticated;
  delete from public.testimonials where id = v_id;
  reset role;
  assert not exists (select 1 from public.testimonials where id = v_id);
  assert exists (select 1 from public.audit_log where action = 'testimonial.delete' and entity_id = v_id::text
                 and details->>'status' = 'hidden'), 'el borrado ajeno queda auditado';
end $$;

-- 8. Borrar el propio comentario: permitido y sin ruido en la auditoría; borrar la cuenta se lleva el comentario
do $$ declare v_id uuid; begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e02', true);
  set local role authenticated;
  insert into public.testimonials (body, rating) values ('Texto de Beto largo suficiente', 4) returning id into v_id;
  delete from public.testimonials where id = v_id;
  reset role;
  assert not exists (select 1 from public.testimonials where user_id = '00000000-0000-4000-8000-000000000e02');
  assert not exists (select 1 from public.audit_log where action = 'testimonial.delete' and entity_id = v_id::text), 'borrar lo propio no se audita';

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e02', true);
  set local role authenticated;
  insert into public.testimonials (body) values ('Otro texto de Beto suficiente');
  reset role;
  delete from public.profiles where id = '00000000-0000-4000-8000-000000000e02';
  assert not exists (select 1 from public.testimonials where user_id = '00000000-0000-4000-8000-000000000e02'), 'cascade al borrar la cuenta';
end $$;
