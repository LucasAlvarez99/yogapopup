-- Pruebas de profesores y agenda (migración 20261005120000). Escala: user · profesor · admin · developer.
-- Usuarios propios (ids ...0c*). Requiere el helper t.raises de tests/roles_and_audit.test.sql.

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-000000000c01', 'prof-user@test.dev',  '{"display_name":"Ana Alumna"}'),
  ('00000000-0000-4000-8000-000000000c02', 'prof-lucia@test.dev', '{"display_name":"Lucía"}'),
  ('00000000-0000-4000-8000-000000000c03', 'prof-sofia@test.dev', '{"display_name":"Sofía"}'),
  ('00000000-0000-4000-8000-000000000c04', 'prof-manu@test.dev',  '{"display_name":"Manu"}'),
  ('00000000-0000-4000-8000-000000000c05', 'prof-dev@test.dev',   '{"display_name":"Dev"}'),
  ('00000000-0000-4000-8000-000000000c06', 'prof-user2@test.dev', '{"display_name":"Beto Alumno"}');
update public.profiles set display_name = 'Ana Alumna' where id = '00000000-0000-4000-8000-000000000c01';
update public.profiles set display_name = 'Beto Alumno' where id = '00000000-0000-4000-8000-000000000c06';
update public.profiles set display_name = 'Lucía' where id = '00000000-0000-4000-8000-000000000c02';
update public.profiles set display_name = 'Sofía' where id = '00000000-0000-4000-8000-000000000c03';
update public.profiles set display_name = 'Manu' where id = '00000000-0000-4000-8000-000000000c04';
update public.profiles set role = 'admin'     where id = '00000000-0000-4000-8000-000000000c04';
update public.profiles set role = 'developer' where id = '00000000-0000-4000-8000-000000000c05';

-- 1. El rol 'profesor' existe; 'sub_admin' (el nombre descartado) no.
do $$ begin
  perform t.raises($q$ update public.profiles set role = 'sub_admin' where id = '00000000-0000-4000-8000-000000000c01' $q$, '23514');
  update public.profiles set role = 'profesor' where id = '00000000-0000-4000-8000-000000000c06';
  update public.profiles set role = 'user' where id = '00000000-0000-4000-8000-000000000c06';
end $$;

-- 2. Alta de profesores: solo developer. El admin (Manu) NO da de alta ni cambia roles.
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c04', true);
  set local role authenticated;
  perform t.raises($q$ select public.set_user_role('00000000-0000-4000-8000-000000000c02', 'profesor') $q$, '42501');
  perform t.raises($q$ select public.set_teacher_active('00000000-0000-4000-8000-000000000c02', true) $q$, '42501');
  perform t.raises($q$ select public.set_user_role_by_email('prof-lucia@test.dev', 'profesor') $q$, '42501');
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c01', true);
  set local role authenticated;
  perform t.raises($q$ select public.set_user_role('00000000-0000-4000-8000-000000000c01', 'profesor') $q$, '42501');
  reset role;

  -- developer: da de alta a Lucía por correo (rol profesor) y a Sofía por id; Manu (admin) también enseña.
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c05', true);
  set local role authenticated;
  perform public.set_user_role_by_email('PROF-LUCIA@test.dev', 'profesor');   -- sin importar mayúsculas
  perform public.set_user_role('00000000-0000-4000-8000-000000000c03', 'profesor');
  perform public.set_teacher_active('00000000-0000-4000-8000-000000000c04', true);
  perform t.raises($q$ select public.set_user_role('00000000-0000-4000-8000-000000000c02', 'sub_admin') $q$, '22023');
  perform t.raises($q$ select public.set_user_role_by_email('nadie@test.dev', 'profesor') $q$, 'P0002');
  reset role;
  assert (select role from public.profiles where id = '00000000-0000-4000-8000-000000000c02') = 'profesor';
  assert (select count(*) from public.teachers where is_active
          and profile_id in ('00000000-0000-4000-8000-000000000c02','00000000-0000-4000-8000-000000000c03','00000000-0000-4000-8000-000000000c04')) = 3,
    'tres profesores activos (dos con rol profesor, uno admin)';
  assert (select public_name from public.teachers where profile_id = '00000000-0000-4000-8000-000000000c02') = 'Lucía';
  assert exists (select 1 from public.audit_log where action = 'teacher.set_active'
                 and entity_id = '00000000-0000-4000-8000-000000000c02'), 'el alta queda auditada';
  assert exists (select 1 from public.audit_log where action = 'role.change'
                 and entity_id = '00000000-0000-4000-8000-000000000c02' and details->>'to' = 'profesor'), 'el cambio de rol queda auditado';
end $$;

-- 3. El profesor NO es personal de gestión.
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c02', true);
  set local role authenticated;
  assert public.is_teacher() and not public.is_staff() and not public.is_developer(), 'profesor: enseña, no gestiona';
  perform t.raises($q$ insert into public.products (title, price_cents) values ('x', 100) $q$, '42501');
  perform t.raises($q$ update public.profiles set role = 'admin' where id = '00000000-0000-4000-8000-000000000c02' $q$, '42501');
  reset role;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c01', true);
  assert not public.is_teacher(), 'un user no es profesor';
  reset role;
end $$;

-- 4. Perfil público: anon ve activos; cada profesor edita SOLO el suyo y SOLO sus campos; Manu edita cualquiera.
do $$ declare n int; begin
  set local role anon;
  perform set_config('request.jwt.claim.sub', '', true);
  select count(*) into n from public.teachers where profile_id::text like '00000000-0000-4000-8000-000000000c%';
  assert n = 3, 'anon ve los 3 profesores activos';
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c02', true);
  set local role authenticated;
  update public.teachers set bio = 'Vinyasa y respiración', photo_url = 'https://x.test/lucia.webp' where profile_id = '00000000-0000-4000-8000-000000000c02';
  get diagnostics n = row_count; assert n = 1, 'edita su propio perfil';
  update public.teachers set bio = 'hackeada' where profile_id = '00000000-0000-4000-8000-000000000c03';
  get diagnostics n = row_count; assert n = 0, 'no edita el perfil de otra persona';
  perform t.raises($q$ update public.teachers set is_active = false where profile_id = '00000000-0000-4000-8000-000000000c02' $q$, '42501');
  perform t.raises($q$ insert into public.teachers (profile_id, public_name) values ('00000000-0000-4000-8000-000000000c01', 'x') $q$, '42501');
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c04', true);
  set local role authenticated;
  update public.teachers set photo_url = 'https://x.test/sofia.webp' where profile_id = '00000000-0000-4000-8000-000000000c03';
  get diagnostics n = row_count; assert n = 1, 'Manu (admin) cambia la foto de cualquier profesor';
  reset role;
end $$;

-- 5. Agenda: cada profesor crea la suya; nadie crea para otro (salvo la gestión); anon no lee la tabla.
create table t.ses (name text primary key, id uuid);
grant all on t.ses to public;
do $$ declare n int; sid uuid; begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c02', true);
  set local role authenticated;
  insert into public.live_sessions (teacher_id, title, level, starts_at, capacity)
    values ('00000000-0000-4000-8000-000000000c02', 'Vinyasa Flow', 'intermedio', now() + interval '2 days', 2) returning id into sid;
  insert into t.ses values ('lucia-vinyasa', sid);
  perform t.raises($q$ insert into public.live_sessions (teacher_id, title, starts_at)
    values ('00000000-0000-4000-8000-000000000c03', 'a nombre de Sofía', now() + interval '3 days') $q$, '42501');
  perform t.raises($q$ insert into public.live_sessions (teacher_id, title, starts_at, duration_minutes)
    values ('00000000-0000-4000-8000-000000000c02', 'dura 1 minuto', now() + interval '3 days', 1) $q$, '23514');
  update public.live_sessions set title = 'Vinyasa Flow (editada)' where id = sid;
  get diagnostics n = row_count; assert n = 1;
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c03', true);
  set local role authenticated;
  insert into public.live_sessions (teacher_id, title, level, starts_at)
    values ('00000000-0000-4000-8000-000000000c03', 'Yoga Relax', 'todos', now() + interval '3 days') returning id into sid;
  insert into t.ses values ('sofia-relax', sid);
  insert into public.live_sessions (teacher_id, title, starts_at, is_published)
    values ('00000000-0000-4000-8000-000000000c03', 'Borrador', now() + interval '4 days', false) returning id into sid;
  insert into t.ses values ('sofia-borrador', sid);
  update public.live_sessions set title = 'pisada' where id = (select id from t.ses where name = 'lucia-vinyasa');
  get diagnostics n = row_count; assert n = 0, 'Sofía no edita la clase de Lucía';
  delete from public.live_sessions where id = (select id from t.ses where name = 'lucia-vinyasa');
  get diagnostics n = row_count; assert n = 0, 'Sofía no borra la clase de Lucía';
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c01', true);
  set local role authenticated;
  perform t.raises($q$ insert into public.live_sessions (teacher_id, title, starts_at)
    values ('00000000-0000-4000-8000-000000000c01', 'user se hace pasar', now() + interval '3 days') $q$, '42501');
  reset role;

  set local role anon;
  perform set_config('request.jwt.claim.sub', '', true);
  perform t.raises($q$ select * from public.live_sessions $q$, '42501');
  reset role;
end $$;

-- 6. Agenda pública (live_agenda): publicadas, de profesores activos, con cupos; sin sesión también.
do $$ declare n int; begin
  set local role anon;
  perform set_config('request.jwt.claim.sub', '', true);
  select count(*) into n from public.live_agenda(null, now(), now() + interval '30 days') where title in ('Vinyasa Flow (editada)', 'Yoga Relax', 'Borrador');
  assert n = 2, 'anon ve 2 clases publicadas (el borrador no)';
  assert (select count(*) from public.live_agenda('00000000-0000-4000-8000-000000000c03', now(), now() + interval '30 days')
          where title <> 'Borrador') = 1, 'filtra por profesor';
  assert (select bool_or(mine) from public.live_agenda(null, now(), now() + interval '30 days')) is not true, 'anon no tiene reservas';
  reset role;
end $$;

-- 7. Reservas: cupo, repetidas, pasadas, cancelación; nadie escribe la tabla directamente.
do $$ declare r text; lucia uuid; relax uuid; past uuid; begin
  select id into lucia from t.ses where name = 'lucia-vinyasa';
  select id into relax from t.ses where name = 'sofia-relax';
  insert into public.live_sessions (teacher_id, title, starts_at) values ('00000000-0000-4000-8000-000000000c02', 'Ya empezó', now() - interval '1 hour') returning id into past;

  set local role anon;
  perform set_config('request.jwt.claim.sub', '', true);
  perform t.raises(format($q$ select public.book_live_session(%L) $q$, lucia), '42501');
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c01', true);
  set local role authenticated;
  assert public.book_live_session(lucia) = 'booked';
  assert public.book_live_session(lucia) = 'already_booked', 'reservar dos veces no duplica';
  perform t.raises(format($q$ select public.book_live_session(%L) $q$, past), '22023');
  perform t.raises(format($q$ select public.book_live_session(%L) $q$, (select id from t.ses where name = 'sofia-borrador')), 'P0002');
  perform t.raises(format($q$ select public.book_live_session(%L) $q$, gen_random_uuid()), 'P0002');
  perform t.raises(format($q$ insert into public.live_bookings (session_id, user_id) values (%L, auth.uid()) $q$, relax), '42501');
  perform t.raises(format($q$ delete from public.live_bookings where session_id = %L $q$, lucia), '42501');
  assert (select mine from public.live_agenda(null, now(), now() + interval '30 days') where id = lucia), 'la agenda marca mi reserva';
  reset role;

  -- Cupo 2: Ana ya está; entra Beto y la tercera persona (Sofía, como alumna) queda afuera.
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c06', true);
  set local role authenticated;
  assert public.book_live_session(lucia) = 'booked';
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c03', true);
  set local role authenticated;
  perform t.raises(format($q$ select public.book_live_session(%L) $q$, lucia), '23514');
  reset role;
  assert (select booked from public.live_agenda(null, now(), now() + interval '30 days') where id = lucia) = 2;

  -- Cancelar libera el lugar; no se puede cancelar una clase que ya empezó.
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c06', true);
  set local role authenticated;
  perform public.cancel_live_booking(lucia);
  reset role;
  assert (select count(*) from public.live_bookings where session_id = lucia) = 1;
  insert into public.live_bookings (session_id, user_id) values (past, '00000000-0000-4000-8000-000000000c01');
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c01', true);
  set local role authenticated;
  perform public.cancel_live_booking(past);
  reset role;
  assert (select count(*) from public.live_bookings where session_id = past) = 1, 'una clase empezada no se cancela';
end $$;

-- 8. Quién ve qué: reservas propias, alumnos del profesor, nunca correos.
do $$ declare n int; lucia uuid; rec record; begin
  select id into lucia from t.ses where name = 'lucia-vinyasa';

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c06', true);
  set local role authenticated;
  select count(*) into n from public.live_bookings; assert n = 0, 'Beto canceló: no ve reservas ajenas';
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c01', true);
  set local role authenticated;
  select count(*) into n from public.live_bookings; assert n = 2, 'Ana ve solo las suyas (Vinyasa y la de prueba)';
  assert (select count(*) from public.my_live_bookings()) >= 1;
  perform t.raises($q$ select * from public.teacher_agenda('00000000-0000-4000-8000-000000000c02', now(), now() + interval '30 days') $q$, '42501');
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c02', true);
  set local role authenticated;
  select * into rec from public.teacher_agenda('00000000-0000-4000-8000-000000000c02', now(), now() + interval '30 days') where id = lucia;
  assert jsonb_array_length(rec.students) = 1 and rec.students->0->>'name' = 'Ana Alumna', 'Lucía ve a sus alumnos por nombre';
  assert position('@' in rec.students::text) = 0, 'sin correos';
  select count(*) into n from public.live_bookings; assert n = 2, 've las reservas de SUS clases (Vinyasa y la que ya empezó)';
  assert not exists (select 1 from public.live_bookings where session_id = (select id from t.ses where name = 'sofia-relax')), 'ninguna de otra profesora';
  perform t.raises($q$ select * from public.teacher_agenda('00000000-0000-4000-8000-000000000c03', now(), now() + interval '30 days') $q$, '42501');
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c04', true);
  set local role authenticated;
  select count(*) into n from public.teacher_agenda('00000000-0000-4000-8000-000000000c02', now(), now() + interval '30 days'); assert n >= 1, 'Manu ve la agenda de cualquiera';
  reset role;
end $$;

-- 9. Fotos (Storage): cada profesor en su carpeta; Manu en cualquiera; un user en ninguna.
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c02', true);
  set local role authenticated;
  insert into storage.objects (bucket_id, name) values ('teacher-photos', '00000000-0000-4000-8000-000000000c02/perfil.webp');
  perform t.raises($q$ insert into storage.objects (bucket_id, name) values ('teacher-photos', '00000000-0000-4000-8000-000000000c03/perfil.webp') $q$, '42501');
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c04', true);
  set local role authenticated;
  insert into storage.objects (bucket_id, name) values ('teacher-photos', '00000000-0000-4000-8000-000000000c03/perfil.webp');
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c01', true);
  set local role authenticated;
  perform t.raises($q$ insert into storage.objects (bucket_id, name) values ('teacher-photos', '00000000-0000-4000-8000-000000000c01/perfil.webp') $q$, '42501');
  reset role;
end $$;

-- 10. Baja: volver a 'user' desactiva el perfil; sus clases dejan de verse y no se puede reservar.
do $$ declare lucia uuid; begin
  select id into lucia from t.ses where name = 'lucia-vinyasa';
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c05', true);
  set local role authenticated;
  perform public.set_user_role('00000000-0000-4000-8000-000000000c02', 'user');
  reset role;
  assert not (select is_active from public.teachers where profile_id = '00000000-0000-4000-8000-000000000c02');
  set local role anon;
  perform set_config('request.jwt.claim.sub', '', true);
  assert not exists (select 1 from public.teachers where profile_id = '00000000-0000-4000-8000-000000000c02'), 'anon ya no ve a Lucía';
  assert not exists (select 1 from public.live_agenda(null, now(), now() + interval '30 days') where id = lucia), 'ni su agenda';
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c06', true);
  set local role authenticated;
  perform t.raises(format($q$ select public.book_live_session(%L) $q$, lucia), 'P0002');
  reset role;
end $$;

-- 11. Alta por correo SIN pisar el rol: Manuela es profesora Y admin; un admin nunca baja de rango.
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-000000000c07', 'prof-manuela@test.dev', '{"display_name":"Manuela"}'),
  ('00000000-0000-4000-8000-000000000c08', 'prof-nueva@test.dev',   '{"display_name":"Nueva"}'),
  ('00000000-0000-4000-8000-000000000c09', 'prof-adm@test.dev',     '{"display_name":"Admin Previa"}');
update public.profiles set display_name = 'Manuela' where id = '00000000-0000-4000-8000-000000000c07';
update public.profiles set display_name = 'Nueva' where id = '00000000-0000-4000-8000-000000000c08';
update public.profiles set display_name = 'Admin Previa', role = 'admin' where id = '00000000-0000-4000-8000-000000000c09';
update public.profiles set role = 'profesor' where id = '00000000-0000-4000-8000-000000000c07';   -- el estado en que quedó antes: solo profesora

do $$ declare r text; begin
  -- solo developer
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c04', true);
  set local role authenticated;
  perform t.raises($q$ select public.add_teacher_by_email('prof-manuela@test.dev', true) $q$, '42501');
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c05', true);
  set local role authenticated;
  perform t.raises($q$ select public.add_teacher_by_email('nadie@test.dev', true) $q$, 'P0002');

  -- Manuela: profesora + admin
  assert public.add_teacher_by_email('PROF-MANUELA@test.dev', true) = 'admin';
  -- una persona nueva, solo profesora
  assert public.add_teacher_by_email('prof-nueva@test.dev', false) = 'profesor';
  -- un admin que ya existe: alta como profesor SIN que baje de rango (el descuido original)
  assert public.add_teacher_by_email('prof-adm@test.dev', false) = 'admin', 'un admin no baja a profesor';
  -- un developer tampoco baja, ni con también_admin
  assert public.add_teacher_by_email('prof-dev@test.dev', true) = 'developer';
  -- repetir no rompe nada
  assert public.add_teacher_by_email('prof-manuela@test.dev', true) = 'admin';
  reset role;

  assert (select role from public.profiles where id = '00000000-0000-4000-8000-000000000c07') = 'admin';
  assert (select role from public.profiles where id = '00000000-0000-4000-8000-000000000c08') = 'profesor';
  assert (select role from public.profiles where id = '00000000-0000-4000-8000-000000000c09') = 'admin';
  assert (select role from public.profiles where id = '00000000-0000-4000-8000-000000000c05') = 'developer';
  assert (select count(*) from public.teachers where is_active and profile_id in (
            '00000000-0000-4000-8000-000000000c07','00000000-0000-4000-8000-000000000c08',
            '00000000-0000-4000-8000-000000000c09','00000000-0000-4000-8000-000000000c05')) = 4, 'las cuatro quedan como profesoras activas';

  -- Manuela ahora SÍ es gestión Y profesora: ve el panel completo y su agenda, y puede editar el perfil de otra profesora.
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c07', true);
  set local role authenticated;
  assert public.is_staff() and public.is_teacher(), 'admin + profesora';
  insert into public.live_sessions (teacher_id, title, starts_at) values ('00000000-0000-4000-8000-000000000c07', 'Hatha Yoga', now() + interval '5 days');
  update public.teachers set bio = 'editada por Manuela' where profile_id = '00000000-0000-4000-8000-000000000c08';
  get diagnostics r = row_count; assert r::int = 1, 'como admin edita el perfil de otra profesora';
  reset role;
  assert exists (select 1 from public.audit_log where action = 'role.change' and entity_id = '00000000-0000-4000-8000-000000000c07' and details->>'to' = 'admin');
end $$;

-- 12. Lo que un profesor escribe en su perfil público está acotado EN LA BASE (no solo en el formulario).
do $$ declare n int; begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000c03', true);
  set local role authenticated;
  perform t.raises($q$ update public.teachers set photo_url = 'javascript:alert(1)' where profile_id = '00000000-0000-4000-8000-000000000c03' $q$, '23514');
  perform t.raises($q$ update public.teachers set photo_url = 'http://sin-cifrar.test/a.jpg' where profile_id = '00000000-0000-4000-8000-000000000c03' $q$, '23514');
  perform t.raises($q$ update public.teachers set photo_url = 'data:image/png;base64,AAAA' where profile_id = '00000000-0000-4000-8000-000000000c03' $q$, '23514');
  perform t.raises($q$ update public.teachers set photo_url = 'https://x.test/con espacio.jpg' where profile_id = '00000000-0000-4000-8000-000000000c03' $q$, '23514');
  update public.teachers set photo_url = 'https://x.test/ok.webp', specialties = array['Vinyasa', 'Hatha'] where profile_id = '00000000-0000-4000-8000-000000000c03';
  get diagnostics n = row_count; assert n = 1, 'https y especialidades normales se aceptan';
  update public.teachers set photo_url = null where profile_id = '00000000-0000-4000-8000-000000000c03';
  get diagnostics n = row_count; assert n = 1, 'quitar la foto se puede';
  perform t.raises($q$ update public.teachers set specialties = array[repeat('x', 31)] where profile_id = '00000000-0000-4000-8000-000000000c03' $q$, '23514');
  perform t.raises($q$ update public.teachers set specialties = array['ok', '   '] where profile_id = '00000000-0000-4000-8000-000000000c03' $q$, '23514');
  reset role;
end $$;
