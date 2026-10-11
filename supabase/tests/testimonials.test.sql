-- Pruebas de comentarios, publicación automática y palabras prohibidas (migraciones 20261009120000 y 20261011120000).
-- Usuarios propios (ids ...0e*). Requiere el helper t.raises de tests/shim.sql.

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-000000000e01', 'tm-ana@test.dev',   '{"display_name":"Ana Alumna"}'),
  ('00000000-0000-4000-8000-000000000e02', 'tm-beto@test.dev',  '{"display_name":"Beto"}'),
  ('00000000-0000-4000-8000-000000000e03', 'tm-admin@test.dev', '{"display_name":"Manu"}'),
  ('00000000-0000-4000-8000-000000000e04', 'tm-prof@test.dev',  '{"display_name":"Lucía"}'),
  ('00000000-0000-4000-8000-000000000e05', 'tm-dev@test.dev',   '{"display_name":"Dev"}'),
  ('00000000-0000-4000-8000-000000000e06', 'tm-sinnombre@test.dev', '{}'),
  ('00000000-0000-4000-8000-000000000e07', 'tm-cata@test.dev',  '{"display_name":"Cata"}'),
  ('00000000-0000-4000-8000-000000000e08', 'tm-dani@test.dev',  '{"display_name":"Dani"}');
update public.profiles set display_name = 'Ana Alumna' where id = '00000000-0000-4000-8000-000000000e01';
update public.profiles set display_name = 'Beto' where id = '00000000-0000-4000-8000-000000000e02';
update public.profiles set display_name = null where id = '00000000-0000-4000-8000-000000000e06';
update public.profiles set role = 'admin'     where id = '00000000-0000-4000-8000-000000000e03';
update public.profiles set role = 'profesor'  where id = '00000000-0000-4000-8000-000000000e04';
update public.profiles set role = 'developer' where id = '00000000-0000-4000-8000-000000000e05';

-- 1. Escribir: se publica solo (sin aprobación), con el nombre del perfil aunque la persona mande otro.
do $$ declare v_id uuid; begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e01', true);
  set local role authenticated;
  insert into public.testimonials (body, rating) values ('  Las clases me cambiaron la semana.  ', 5) returning id into v_id;
  assert (select status from public.testimonials where id = v_id) = 'approved', 'nace publicado';
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
  assert (select banned_until from auth.users where id = '00000000-0000-4000-8000-000000000e01') is null, 'un comentario normal no suspende a nadie';
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

-- 4. Lo publicado lo ve cualquiera, pero sin datos de la cuenta; nadie más puede cambiarle el estado
do $$ declare v_id uuid; begin
  v_id := (select id from public.testimonials where user_id = '00000000-0000-4000-8000-000000000e01');

  set local role anon;
  assert (select count(*) from public.testimonials) = 1, 'anon ve el comentario publicado';
  assert (select author_name from public.testimonials) = 'Ana Alumna';
  perform t.raises($q$ select user_id from public.testimonials $q$, '42501');
  perform t.raises($q$ select status from public.testimonials $q$, '42501');
  perform t.raises($q$ select moderated_by from public.testimonials $q$, '42501');
  reset role;

  -- el profesor NO es gestión: ve lo público pero no lo puede ocultar (la RLS no le deja tocar la fila)
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e04', true);
  set local role authenticated;
  assert (select count(*) from public.testimonials) = 1;
  update public.testimonials set status = 'hidden' where id = v_id;   -- RLS: 0 filas
  reset role;
  assert (select status from public.testimonials where id = v_id) = 'approved', 'el profesor no pudo ocultarlo';
end $$;

-- 5. Moderar a mano: solo la gestión; Ana no cambia su estado; queda auditado; si la gestión lo oculta, editar no lo republica
do $$ declare v_id uuid; begin
  v_id := (select id from public.testimonials where user_id = '00000000-0000-4000-8000-000000000e01');

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e01', true);
  set local role authenticated;
  perform t.raises(format($q$ update public.testimonials set status = 'hidden' where id = %L $q$, v_id), '42501');
  reset role;
  assert (select status from public.testimonials where id = v_id) = 'approved';

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e03', true);   -- admin
  set local role authenticated;
  update public.testimonials set status = 'hidden' where id = v_id;
  reset role;
  assert (select status from public.testimonials where id = v_id) = 'hidden';
  assert (select moderated_by from public.testimonials where id = v_id) = '00000000-0000-4000-8000-000000000e03', 'quién moderó';
  assert exists (select 1 from public.audit_log where action = 'testimonial.moderate' and entity_id = v_id::text
                 and details->>'from' = 'approved' and details->>'to' = 'hidden'), 'ocultarlo queda auditado';
  set local role anon;
  assert (select count(*) from public.testimonials) = 0, 'oculto: no es público';
  reset role;

  -- su autora lo sigue viendo y, aunque lo corrija bien, no se republica solo: lo ocultó la gestión
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e01', true);
  set local role authenticated;
  assert (select status from public.testimonials where id = v_id) = 'hidden';
  update public.testimonials set body = 'Las clases me cambiaron mucho la semana' where id = v_id;
  reset role;
  assert (select status from public.testimonials where id = v_id) = 'hidden', 'lo ocultó la gestión: editarlo no lo publica';
  assert (select banned_until from auth.users where id = '00000000-0000-4000-8000-000000000e01') is null;

  -- la gestión lo vuelve a publicar
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e03', true);
  set local role authenticated;
  update public.testimonials set status = 'approved' where id = v_id;
  reset role;
  assert (select status from public.testimonials where id = v_id) = 'approved';
  set local role anon;
  assert (select count(*) from public.testimonials) = 1, 'aprobado a mano: vuelve a ser público';
  reset role;
end $$;

-- 6. Si Ana edita un comentario publicado con un texto limpio, sigue publicado (sin pasar por nadie)
do $$ declare v_id uuid; begin
  v_id := (select id from public.testimonials where user_id = '00000000-0000-4000-8000-000000000e01');
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e01', true);
  set local role authenticated;
  update public.testimonials set body = 'Ahora con el texto cambiado por completo' where id = v_id;
  reset role;
  assert (select status from public.testimonials where id = v_id) = 'approved', 'editar con texto limpio: sigue publicado';
  assert (select moderated_by from public.testimonials where id = v_id) is null, 'ya no figura moderado por nadie';
  set local role anon;
  assert (select count(*) from public.testimonials) = 1 and (select body from public.testimonials) = 'Ahora con el texto cambiado por completo', 'el cambio se ve al instante';
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
  update public.testimonials set status = 'hidden' where id = v_id;
  reset role;
  assert (select status from public.testimonials where id = v_id) = 'hidden';

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

-- 9. La lista de palabras prohibidas: sin importar mayúsculas, tildes, números/símbolos por letras ni letras repetidas;
--    solo palabras completas (nada de falsos positivos con palabras que las contienen ni con nombres propios)
do $$ begin
  assert public.contains_banned_word('Sos una PUTA'), 'mayúsculas';
  assert public.contains_banned_word('Qué imbécil'), 'tilde';
  assert public.contains_banned_word('que m1erda de clase'), 'número por letra';
  assert public.contains_banned_word('mierdaaa'), 'letras repetidas';
  assert public.contains_banned_word('PUUUUTA'), 'letras repetidas en mayúsculas';
  assert public.contains_banned_word('hdp!!!'), 'con signos';
  assert public.contains_banned_word('hijo   de   puta'), 'frase con espacios de más';
  assert public.contains_banned_word('La concha de tu madre'), 'frase';
  assert public.contains_banned_word('what the f u c k') = false, 'letras sueltas no se detectan (límite conocido)';
  assert public.contains_banned_word('what the fuck'), 'inglés';
  assert not public.contains_banned_word('Me encantó la clase, muchas gracias'), 'texto normal';
  assert not public.contains_banned_word('Una computadora y el disputado puesto'), 'no dispara dentro de otra palabra';
  assert not public.contains_banned_word('Concha es una profe genial'), 'nombre propio';
  assert not public.contains_banned_word('Participé en el foro del cono'), 'palabras parecidas';
  assert not public.contains_banned_word(''), 'vacío';
  assert not public.contains_banned_word(null), 'nulo';
end $$;

-- 10. Insulto al escribir: no se publica y la cuenta se suspende 168 horas; mientras dura no puede escribir ni editar
do $$ declare v_id uuid; begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e07', true);   -- Cata
  set local role authenticated;
  insert into public.testimonials (body) values ('Esta clase es una mierda total') returning id into v_id;
  reset role;
  assert (select status from public.testimonials where id = v_id) = 'hidden', 'con palabra prohibida queda oculto';
  set local role anon;
  assert (select count(*) from public.testimonials where body like '%mierda%') = 0, 'y no se ve en público';
  reset role;
  assert (select banned_until from auth.users where id = '00000000-0000-4000-8000-000000000e07')
         between now() + interval '167 hours' and now() + interval '169 hours', 'suspendida 168 horas';
  assert exists (select 1 from public.audit_log where action = 'user.auto_suspend' and entity_id = '00000000-0000-4000-8000-000000000e07'
                 and (details->>'hours')::int = 168 and details->>'reason' = 'banned_word'), 'la suspensión queda auditada';

  -- suspendida: ni edita (aunque conserve un token vivo)
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e07', true);
  set local role authenticated;
  assert (select status from public.testimonials where id = v_id) = 'hidden', 'ella sí ve el suyo';
  perform t.raises(format($q$ update public.testimonials set body = 'Ahora lo escribo bien y con respeto' where id = %L $q$, v_id), 'YP001');
  reset role;

  -- pasó la suspensión: corrige su texto y se publica sola
  update auth.users set banned_until = now() - interval '1 second' where id = '00000000-0000-4000-8000-000000000e07';
  set local role authenticated;
  update public.testimonials set body = 'Ahora lo escribo bien y con respeto' where id = v_id;
  reset role;
  assert (select status from public.testimonials where id = v_id) = 'approved', 'cumplida la suspensión, el texto limpio se publica';
end $$;

-- 11. Insulto al editar un comentario ya publicado: deja de ser público y se suspende la cuenta
do $$ declare v_id uuid; begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e08', true);   -- Dani
  set local role authenticated;
  insert into public.testimonials (body) values ('Me gustó mucho la clase de hoy') returning id into v_id;
  reset role;
  assert (select status from public.testimonials where id = v_id) = 'approved';
  set local role anon;
  assert (select count(*) from public.testimonials where body like '%gustó%') = 1;
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e08', true);
  set local role authenticated;
  update public.testimonials set body = 'Qué pelotudo el profe, no sirve' where id = v_id;
  reset role;
  assert (select status from public.testimonials where id = v_id) = 'hidden', 'editar con insulto: deja de ser público';
  assert (select banned_until from auth.users where id = '00000000-0000-4000-8000-000000000e08') > now() + interval '167 hours', 'y se suspende';
  set local role anon;
  assert (select count(*) from public.testimonials where body like '%pelotudo%') = 0;
  reset role;
end $$;

-- 12. La gestión no se suspende sola: su comentario con insulto queda oculto, sin suspensión
do $$ declare v_id uuid; begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e03', true);   -- admin
  set local role authenticated;
  insert into public.testimonials (body) values ('Prueba del filtro: esto es una mierda') returning id into v_id;
  reset role;
  assert (select status from public.testimonials where id = v_id) = 'hidden';
  assert (select banned_until from auth.users where id = '00000000-0000-4000-8000-000000000e03') is null, 'la gestión no se suspende';
  assert not exists (select 1 from public.audit_log where action = 'user.auto_suspend' and entity_id = '00000000-0000-4000-8000-000000000e03');
  delete from public.testimonials where id = v_id;
end $$;

-- 13. La lista la ve y la edita solo la gestión; las funciones de apoyo no se ejecutan desde la API
do $$ declare v_n int; begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e01', true);   -- alumna
  set local role authenticated;
  assert (select count(*) from public.banned_words) = 0, 'una alumna no ve la lista';
  perform t.raises($q$ insert into public.banned_words (word) values ('algo') $q$, '42501');
  perform t.raises($q$ select public.contains_banned_word('x') $q$, '42501');
  perform t.raises($q$ select public.moderation_suspend_user('00000000-0000-4000-8000-000000000e01', 'x', 'x') $q$, '42501');
  reset role;
  set local role anon;
  perform t.raises($q$ select * from public.banned_words $q$, '42501');
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e03', true);   -- admin
  set local role authenticated;
  v_n := (select count(*) from public.banned_words);
  assert v_n > 30, 'la gestión ve la lista';
  insert into public.banned_words (word) values ('Palabra Rara');
  reset role;
  assert public.contains_banned_word('esto dice palabra RARA acá'), 'una palabra agregada se aplica en el acto';
  set local role authenticated;
  delete from public.banned_words where word = 'Palabra Rara';
  reset role;
  assert not public.contains_banned_word('esto dice palabra RARA acá'), 'y al quitarla deja de aplicarse';
end $$;

-- 14. my_suspension(): cada cuenta ve solo la SUYA; sin sesión no se ejecuta
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e08', true);   -- Dani, suspendida en la sección 11
  set local role authenticated;
  assert public.my_suspension() > now() + interval '167 hours', 'Dani ve hasta cuándo está suspendida';
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e01', true);   -- Ana, nunca suspendida
  set local role authenticated;
  assert public.my_suspension() is null, 'Ana no está suspendida';
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000e07', true);   -- Cata, ya cumplió la suspensión
  set local role authenticated;
  assert public.my_suspension() is null, 'vencida: ya no figura suspendida';
  reset role;
  set local role anon;
  perform t.raises($q$ select public.my_suspension() $q$, '42501');
  reset role;
end $$;
