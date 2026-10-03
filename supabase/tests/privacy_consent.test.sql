-- Prueba de aceptación de la política de privacidad (migración 20261003120000).
-- Requiere el helper t.raises de tests/roles_and_audit.test.sql. Usuarios propios (ids ...0d*).

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-000000000da1', 'priv-acepta@test.dev',   '{"full_name":"Acepta","privacy_version":"2026-10-03"}'),
  ('00000000-0000-4000-8000-000000000da2', 'priv-no@test.dev',       '{"full_name":"No marcó"}'),
  ('00000000-0000-4000-8000-000000000da3', 'priv-falsa@test.dev',    '{"full_name":"Falsa","privacy_version":"2026-10-03","privacy_accepted_at":"2000-01-01T00:00:00Z","role":"developer"}'),
  ('00000000-0000-4000-8000-000000000da4', 'priv-basura@test.dev',   '{"full_name":"Basura","privacy_version":"x; drop table profiles"}'),
  ('00000000-0000-4000-8000-000000000da5', 'priv-numero@test.dev',   '{"full_name":"Numero","privacy_version":20261003}'),
  ('00000000-0000-4000-8000-000000000da6', 'priv-larga@test.dev',    jsonb_build_object('full_name','Larga','privacy_version', repeat('2', 500))),
  ('00000000-0000-4000-8000-000000000da7', 'priv-vacia@test.dev',    '{"full_name":"Vacia","privacy_version":"   "}'),
  ('00000000-0000-4000-8000-000000000da8', 'priv-otro@test.dev',     '{"full_name":"Otro"}');

-- 1. Marcó la casilla: queda la versión y la hora DEL SERVIDOR (recién ahora, no una fecha puesta por el navegador).
do $$ declare r public.profiles; begin
  select * into r from public.profiles where id = '00000000-0000-4000-8000-000000000da1';
  assert r.privacy_version = '2026-10-03', 'versión guardada';
  assert r.privacy_accepted_at is not null and r.privacy_accepted_at > now() - interval '1 minute' and r.privacy_accepted_at <= now(),
    'la fecha la fija el servidor, en este momento';
  assert r.display_name = 'Acepta', 'el nombre sigue guardándose';
  assert r.role = 'user', 'el rol sigue siendo user';
end $$;

-- 2. No marcó: no consta aceptación (null), pero la cuenta se crea igual.
do $$ declare r public.profiles; begin
  select * into r from public.profiles where id = '00000000-0000-4000-8000-000000000da2';
  assert r.id is not null and r.privacy_version is null and r.privacy_accepted_at is null, 'sin casilla = sin registro';
end $$;

-- 3. No se puede falsear: una fecha propia en la metadata se ignora (no retrocede), y un rol tampoco se cuela.
do $$ declare r public.profiles; begin
  select * into r from public.profiles where id = '00000000-0000-4000-8000-000000000da3';
  assert r.privacy_accepted_at > now() - interval '1 minute', 'la fecha del navegador (año 2000) se ignora: %', r.privacy_accepted_at;
  assert r.role = 'user', 'el rol de la metadata se ignora';
end $$;

-- 4. Versiones inválidas (texto, número, demasiado larga, vacía): no rompen el alta y NO cuentan como aceptación.
do $$ declare uid uuid; begin
  foreach uid in array array[
    '00000000-0000-4000-8000-000000000da4', '00000000-0000-4000-8000-000000000da5',
    '00000000-0000-4000-8000-000000000da6', '00000000-0000-4000-8000-000000000da7']::uuid[] loop
    assert exists (select 1 from public.profiles where profiles.id = uid), 'la cuenta se creó igual';
    assert (select privacy_version from public.profiles where profiles.id = uid) is null, 'versión inválida descartada';
    assert (select privacy_accepted_at from public.profiles where profiles.id = uid) is null, 'y sin fecha de aceptación';
  end loop;
end $$;

-- 5. Nadie edita su aceptación desde el navegador (ni para borrarla ni para cambiarla).
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000da1', true);
  set local role authenticated;
  perform t.raises($q$ update public.profiles set privacy_accepted_at = null where id = '00000000-0000-4000-8000-000000000da1' $q$, '42501');
  perform t.raises($q$ update public.profiles set privacy_accepted_at = now() - interval '5 years' where id = '00000000-0000-4000-8000-000000000da1' $q$, '42501');
  perform t.raises($q$ update public.profiles set privacy_version = '2000-01-01' where id = '00000000-0000-4000-8000-000000000da1' $q$, '42501');
  update public.profiles set display_name = 'Acepta 2' where id = '00000000-0000-4000-8000-000000000da1';   -- lo permitido sigue funcionando
  reset role;
  assert (select privacy_version from public.profiles where id = '00000000-0000-4000-8000-000000000da1') = '2026-10-03', 'intacta';
end $$;

-- 6. Quién puede leerla: la propia persona sí; otra persona no; el equipo (admin/developer) sí, como prueba.
do $$ begin
  update public.profiles set role = 'admin' where id = '00000000-0000-4000-8000-000000000da8';
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000da1', true);
  set local role authenticated;
  assert (select privacy_version from public.profiles where id = '00000000-0000-4000-8000-000000000da1') = '2026-10-03', 've la suya';
  assert not exists (select 1 from public.profiles where id = '00000000-0000-4000-8000-000000000da2'), 'no ve la de otra persona';
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000da8', true);
  set local role authenticated;
  assert (select privacy_version from public.profiles where id = '00000000-0000-4000-8000-000000000da1') = '2026-10-03', 'el equipo la ve como prueba';
  reset role;
end $$;

-- 7. Quien ya estaba registrado (sin metadata) no se rompe: sus campos quedan en null.
do $$ begin
  assert exists (select 1 from public.profiles where privacy_accepted_at is null and privacy_version is null), 'hay cuentas sin aceptación registrada';
end $$;
