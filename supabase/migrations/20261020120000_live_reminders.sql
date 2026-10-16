-- =============================================================================
-- YogaPop Up · Fase 31 · Aviso por correo de la clase en vivo del mismo día
--
--   Una tarea programada (Supabase cron → Edge Function live-reminders) avisa a cada alumno anotado en una clase que
--   empieza HOY (en la zona horaria del negocio) y todavía no empezó. Cada reserva se avisa UNA sola vez:
--     live_bookings.reminded_at   cuándo se la reservó para avisar (null = todavía no se avisó)
--   El "reclamo" es atómico (update ... skip locked): si el cron corre dos veces a la vez, nadie recibe dos correos.
--   Si el envío falla, la Edge Function devuelve la reserva (release) y el próximo barrido la reintenta.
--   No se avisa a cuentas suspendidas (banned_until) ni a clases despublicadas.
-- =============================================================================

alter table public.live_bookings add column reminded_at timestamptz;
create index live_bookings_pending_reminder_idx on public.live_bookings (session_id) where reminded_at is null;

create function public.live_reminders_claim(p_tz text, p_limit integer)
returns table (
  booking_id        uuid,
  user_id           uuid,
  email             text,
  display_name      text,
  session_id        uuid,
  title             text,
  starts_at         timestamptz,
  duration_minutes  integer,
  mode              text,
  teacher_name      text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_tz is null or not exists (select 1 from pg_catalog.pg_timezone_names n where n.name = p_tz) then
    raise exception 'invalid_timezone' using errcode = '22023';
  end if;
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;

  return query
  with due as (
    select b.id
      from public.live_bookings b
      join public.live_sessions s on s.id = b.session_id
      join auth.users u on u.id = b.user_id
     where b.reminded_at is null
       and s.is_published
       and s.starts_at > now()
       and (s.starts_at at time zone p_tz)::date = (now() at time zone p_tz)::date
       and (u.banned_until is null or u.banned_until <= now())
     order by s.starts_at, b.created_at
     limit p_limit
       for update of b skip locked
  ),
  claimed as (
    update public.live_bookings b
       set reminded_at = now()
      from due
     where b.id = due.id
    returning b.id, b.user_id, b.session_id
  )
  select c.id, c.user_id, u.email::text, p.display_name, s.id, s.title, s.starts_at, s.duration_minutes, s.mode,
         coalesce(t.public_name, tp.display_name)
    from claimed c
    join public.live_sessions s on s.id = c.session_id
    join auth.users u on u.id = c.user_id
    left join public.profiles p on p.id = c.user_id
    left join public.teachers t on t.profile_id = s.teacher_id
    left join public.profiles tp on tp.id = s.teacher_id
   order by s.starts_at, c.id;
end;
$$;

-- Devuelve reservas que no se pudieron avisar (el próximo barrido las reintenta).
create function public.live_reminders_release(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  update public.live_bookings set reminded_at = null where id = any (coalesce(p_ids, '{}'));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.live_reminders_claim(text, integer), public.live_reminders_release(uuid[])
  from public, anon, authenticated;
grant execute on function public.live_reminders_claim(text, integer), public.live_reminders_release(uuid[]) to service_role;
