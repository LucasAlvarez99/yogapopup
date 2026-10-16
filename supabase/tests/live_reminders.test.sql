-- Fase 31: avisos de clase en vivo del mismo día. Requiere tests/roles_and_audit.test.sql ya aplicado (helper t.raises).
-- Usuarios PROPIOS (e5..e9 con prefijo ...0000000007xx).

insert into auth.users (id, email, raw_user_meta_data, banned_until) values
  ('00000000-0000-4000-8000-000000000701', 'prof-aviso@test.dev', '{}', null),
  ('00000000-0000-4000-8000-000000000702', 'alumna1@test.dev', '{"full_name":"Alumna Uno"}', null),
  ('00000000-0000-4000-8000-000000000703', 'alumna2@test.dev', '{}', null),
  ('00000000-0000-4000-8000-000000000704', 'suspendida@test.dev', '{}', now() + interval '2 days'),
  ('00000000-0000-4000-8000-000000000705', 'otro-dia@test.dev', '{}', null);

do $$ declare
  s_hoy uuid; s_pasada uuid; s_manana uuid; s_oculta uuid;
  tz constant text := 'Europe/Madrid';
  v_today_noon timestamptz;
  r record; n integer; ids uuid[];
begin
  insert into public.teachers (profile_id, public_name) values ('00000000-0000-4000-8000-000000000701', 'Profe Aviso');

  -- "Hoy" al mediodía de Madrid: si ya pasó (la prueba corre de tarde), se usa el final del día para que siga siendo futuro.
  v_today_noon := (((now() at time zone tz)::date + time '12:00') at time zone tz);
  if v_today_noon <= now() + interval '5 minutes' then
    v_today_noon := ((((now() at time zone tz)::date + 1) - interval '1 minute') at time zone tz);
    if v_today_noon <= now() + interval '5 minutes' then
      -- Casi a medianoche: el caso "hoy futuro" no existe a esta hora; se deja pasar sin probar.
      raise notice 'live_reminders: sin ventana "hoy" a esta hora, se omite';
      return;
    end if;
  end if;

  insert into public.live_sessions (teacher_id, title, starts_at, duration_minutes, is_published)
    values ('00000000-0000-4000-8000-000000000701', 'Vinyasa de hoy', v_today_noon, 60, true) returning id into s_hoy;
  insert into public.live_sessions (teacher_id, title, starts_at, duration_minutes, is_published)
    values ('00000000-0000-4000-8000-000000000701', 'Ya pasó', now() - interval '2 hours', 60, true) returning id into s_pasada;
  insert into public.live_sessions (teacher_id, title, starts_at, duration_minutes, is_published)
    values ('00000000-0000-4000-8000-000000000701', 'Mañana', now() + interval '30 hours', 60, true) returning id into s_manana;
  insert into public.live_sessions (teacher_id, title, starts_at, duration_minutes, is_published)
    values ('00000000-0000-4000-8000-000000000701', 'Oculta de hoy', v_today_noon, 60, false) returning id into s_oculta;

  insert into public.live_bookings (session_id, user_id) values
    (s_hoy, '00000000-0000-4000-8000-000000000702'),
    (s_hoy, '00000000-0000-4000-8000-000000000703'),
    (s_hoy, '00000000-0000-4000-8000-000000000704'),   -- suspendida: no se avisa
    (s_pasada, '00000000-0000-4000-8000-000000000702'),  -- ya empezó
    (s_manana, '00000000-0000-4000-8000-000000000705'),  -- otro día
    (s_oculta, '00000000-0000-4000-8000-000000000702');  -- despublicada

  -- 1. Solo las reservas de HOY, que no empezaron, de clases publicadas y de cuentas habilitadas
  select count(*) into n from public.live_reminders_claim(tz, 100);
  assert n = 2, format('avisa solo a las 2 reservas válidas de hoy, fueron %s', n);
  assert (select count(*) from public.live_bookings where reminded_at is not null) = 2, 'quedan marcadas';

  -- 2. No se avisa dos veces
  select count(*) into n from public.live_reminders_claim(tz, 100);
  assert n = 0, 'el segundo barrido no repite avisos';

  -- 3. Release: vuelve a quedar pendiente y se reintenta
  select array_agg(id) into ids from public.live_bookings where reminded_at is not null;
  assert public.live_reminders_release(ids) = 2, 'se devolvieron 2';
  select * into r from public.live_reminders_claim(tz, 1);
  assert r.title = 'Vinyasa de hoy' and r.teacher_name = 'Profe Aviso', 'datos de la clase y del profesor';
  assert r.email in ('alumna1@test.dev', 'alumna2@test.dev'), 'trae el correo de la alumna';
  select count(*) into n from public.live_reminders_claim(tz, 100);
  assert n = 1, 'el límite de 1 dejó la otra reserva para el siguiente barrido';

  -- 4. Validaciones y permisos
  perform t.raises($q$ select * from public.live_reminders_claim('Nowhere/Land', 10) $q$, '22023');
  perform t.raises($q$ select * from public.live_reminders_claim('Europe/Madrid', 0) $q$, '22023');
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000702', true);
  set local role authenticated;
  perform t.raises($q$ select * from public.live_reminders_claim('Europe/Madrid', 10) $q$, '42501');
  perform t.raises($q$ select public.live_reminders_release('{}') $q$, '42501');
  reset role;
  set local role anon;
  perform t.raises($q$ select * from public.live_reminders_claim('Europe/Madrid', 10) $q$, '42501');
  reset role;
end $$;
