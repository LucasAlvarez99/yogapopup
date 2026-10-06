-- =============================================================================
-- YogaPop Up · Profesores y agenda de clases en vivo (Fases 28-30)
--
-- Escala de usuarios:  user · profesor · admin · developer
--   user       usuario final: reserva clases en vivo.
--   profesor   da clases: edita SU perfil público (foto, bio) y gestiona SU agenda (clases en vivo y alumnos anotados).
--              NO es personal de gestión: no entra en is_staff(), así que no toca productos ni el catálogo de videos.
--   admin      (Manu, dueño) todo lo de gestión + edita el perfil y la agenda de cualquier profesor.
--   developer  todo lo del admin + sube videos + da de alta/baja profesores y cambia roles (siempre auditado).
--
-- Un profesor es una FILA en public.teachers, no solo un rol: Manu es admin Y da clases, así que `teachers` es independiente
-- del rol. is_teacher() = tiene una fila activa. El rol 'profesor' es la forma de dar de alta a alguien que SOLO enseña.
--
-- Qué se expone sin sesión (anon): el perfil público de los profesores activos y la agenda publicada (con cupos). Nunca
-- correos ni quién se anotó: eso solo lo ve el propio profesor y la gestión, por funciones que no devuelven correos.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Rol 'profesor'
-- -----------------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('user', 'profesor', 'admin', 'developer'));

-- -----------------------------------------------------------------------------
-- 2. Perfil público del profesor
-- -----------------------------------------------------------------------------
create table public.teachers (
  profile_id   uuid primary key references public.profiles (id) on delete cascade,
  public_name  text not null check (char_length(btrim(public_name)) between 1 and 80),
  bio          text check (bio is null or char_length(bio) <= 600),
  photo_url    text check (photo_url is null or char_length(photo_url) <= 500),
  specialties  text[] not null default '{}' check (cardinality(specialties) <= 8),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger teachers_set_updated_at
  before update on public.teachers
  for each row execute function public.set_updated_at();

create or replace function public.is_teacher()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.teachers t
    where t.profile_id = auth.uid() and t.is_active
  );
$$;
comment on function public.is_teacher() is
  'Tiene perfil de profesor activo (da clases). Independiente del rol: un admin también puede ser profesor.';

alter table public.teachers enable row level security;

-- Lectura: profesores activos para todos (la home los muestra sin sesión); el propio profesor ve el suyo aunque esté inactivo.
create policy teachers_select_public on public.teachers
  for select to anon
  using (is_active);          -- anon no puede ejecutar is_staff(): por eso es una política aparte

create policy teachers_select_own on public.teachers
  for select to authenticated
  using (is_active or profile_id = (select auth.uid()) or public.is_staff());

-- Edición: el propio profesor (solo su fila) o la gestión. Las columnas editables se limitan con GRANT (is_active solo
-- cambia por set_teacher_active(), que audita).
create policy teachers_update on public.teachers
  for update to authenticated
  using (profile_id = (select auth.uid()) or public.is_staff())
  with check (profile_id = (select auth.uid()) or public.is_staff());

revoke all on public.teachers from anon, authenticated;
grant select on public.teachers to anon, authenticated;
grant update (public_name, bio, photo_url, specialties) on public.teachers to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Clases en vivo (la agenda)
-- -----------------------------------------------------------------------------
create table public.live_sessions (
  id                uuid primary key default gen_random_uuid(),
  teacher_id        uuid not null references public.teachers (profile_id) on delete cascade,
  title             text not null check (char_length(btrim(title)) between 1 and 100),
  level             text not null default 'todos' check (level in ('principiante', 'intermedio', 'avanzado', 'todos')),
  mode              text not null default 'live' check (mode in ('live', 'virtual')),
  starts_at         timestamptz not null,
  duration_minutes  integer not null default 60 check (duration_minutes between 15 and 240),
  capacity          integer check (capacity is null or capacity between 1 and 500),   -- null = sin cupo
  is_published      boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index live_sessions_teacher_idx on public.live_sessions (teacher_id, starts_at);
create index live_sessions_starts_idx  on public.live_sessions (starts_at) where is_published;

create trigger live_sessions_set_updated_at
  before update on public.live_sessions
  for each row execute function public.set_updated_at();

alter table public.live_sessions enable row level security;

-- Sin lectura pública directa de la tabla: la agenda pública sale de live_agenda() (con cupos, sin datos de alumnos).
create policy live_sessions_select on public.live_sessions
  for select to authenticated
  using (teacher_id = (select auth.uid()) or public.is_staff());

create policy live_sessions_insert on public.live_sessions
  for insert to authenticated
  with check ((teacher_id = (select auth.uid()) and public.is_teacher()) or public.is_staff());

create policy live_sessions_update on public.live_sessions
  for update to authenticated
  using (teacher_id = (select auth.uid()) or public.is_staff())
  with check (teacher_id = (select auth.uid()) or public.is_staff());

create policy live_sessions_delete on public.live_sessions
  for delete to authenticated
  using (teacher_id = (select auth.uid()) or public.is_staff());

revoke all on public.live_sessions from anon, authenticated;
grant select, delete on public.live_sessions to authenticated;
grant insert (teacher_id, title, level, mode, starts_at, duration_minutes, capacity, is_published)
  on public.live_sessions to authenticated;
grant update (title, level, mode, starts_at, duration_minutes, capacity, is_published)
  on public.live_sessions to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Reservas
--    Nadie inserta ni borra reservas directamente: book_live_session() controla el cupo (con bloqueo de fila, para que dos
--    personas no ocupen el último lugar a la vez) y cancel_live_booking() solo cancela antes de que empiece la clase.
-- -----------------------------------------------------------------------------
create table public.live_bookings (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.live_sessions (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (session_id, user_id)
);
create index live_bookings_user_idx on public.live_bookings (user_id, created_at desc);

alter table public.live_bookings enable row level security;

create policy live_bookings_select on public.live_bookings
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.is_staff()
    or exists (select 1 from public.live_sessions s where s.id = session_id and s.teacher_id = (select auth.uid()))
  );

revoke all on public.live_bookings from anon, authenticated;
grant select on public.live_bookings to authenticated;

create or replace function public.book_live_session(p_session uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.live_sessions;
  taken integer;
begin
  if auth.uid() is null then
    raise exception 'login required' using errcode = '42501';
  end if;
  select * into s from public.live_sessions where id = p_session for update;   -- serializa las reservas de esta clase
  if not found or not s.is_published then
    raise exception 'session not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.teachers t where t.profile_id = s.teacher_id and t.is_active) then
    raise exception 'session not found' using errcode = 'P0002';
  end if;
  if s.starts_at <= now() then
    raise exception 'session already started' using errcode = '22023';
  end if;
  if exists (select 1 from public.live_bookings b where b.session_id = p_session and b.user_id = auth.uid()) then
    return 'already_booked';
  end if;
  select count(*) into taken from public.live_bookings b where b.session_id = p_session;
  if s.capacity is not null and taken >= s.capacity then
    raise exception 'session full' using errcode = '23514';
  end if;
  insert into public.live_bookings (session_id, user_id) values (p_session, auth.uid());
  return 'booked';
end;
$$;

create or replace function public.cancel_live_booking(p_session uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'login required' using errcode = '42501';
  end if;
  delete from public.live_bookings b
  using public.live_sessions s
  where b.session_id = p_session and b.user_id = auth.uid()
    and s.id = b.session_id and s.starts_at > now();
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Lecturas con datos agregados
-- -----------------------------------------------------------------------------
-- Agenda pública: sesiones publicadas de profesores activos, con cupos ocupados y si la persona ya está anotada.
create or replace function public.live_agenda(p_teacher uuid, p_from timestamptz, p_to timestamptz)
returns table (
  id uuid, teacher_id uuid, title text, level text, mode text, starts_at timestamptz,
  duration_minutes integer, capacity integer, booked integer, mine boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.teacher_id, s.title, s.level, s.mode, s.starts_at, s.duration_minutes, s.capacity,
         (select count(*)::int from public.live_bookings b where b.session_id = s.id),
         coalesce(exists (select 1 from public.live_bookings b where b.session_id = s.id and b.user_id = auth.uid()), false)
  from public.live_sessions s
  join public.teachers t on t.profile_id = s.teacher_id and t.is_active
  where s.is_published
    and s.starts_at >= greatest(p_from, now())
    and s.starts_at < least(p_to, p_from + interval '92 days')      -- tope: una consulta no puede pedir años de agenda
    and (p_teacher is null or s.teacher_id = p_teacher)
  order by s.starts_at;
$$;

-- Agenda del profesor: sus clases con los alumnos anotados (solo nombre: nunca correos). El propio profesor o la gestión.
create or replace function public.teacher_agenda(p_teacher uuid, p_from timestamptz, p_to timestamptz)
returns table (
  id uuid, title text, level text, mode text, starts_at timestamptz, duration_minutes integer,
  capacity integer, is_published boolean, students jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not (p_teacher = auth.uid() or public.is_staff()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
  select s.id, s.title, s.level, s.mode, s.starts_at, s.duration_minutes, s.capacity, s.is_published,
         coalesce((
           select jsonb_agg(jsonb_build_object('id', b.user_id, 'name', coalesce(nullif(btrim(p.display_name), ''), 'Alumno/a'),
                                               'booked_at', b.created_at) order by b.created_at)
           from public.live_bookings b join public.profiles p on p.id = b.user_id
           where b.session_id = s.id
         ), '[]'::jsonb)
  from public.live_sessions s
  where s.teacher_id = p_teacher
    and s.starts_at >= p_from and s.starts_at < least(p_to, p_from + interval '366 days')
  order by s.starts_at;
end;
$$;

-- "Mis próximas clases" de quien reserva.
create or replace function public.my_live_bookings()
returns table (
  session_id uuid, title text, level text, mode text, starts_at timestamptz, duration_minutes integer, teacher_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.title, s.level, s.mode, s.starts_at, s.duration_minutes, t.public_name
  from public.live_bookings b
  join public.live_sessions s on s.id = b.session_id
  join public.teachers t on t.profile_id = s.teacher_id
  where b.user_id = auth.uid() and s.starts_at > now() - interval '1 hour'
  order by s.starts_at;
$$;

-- -----------------------------------------------------------------------------
-- 6. Alta y baja de profesores (solo developer, auditado)
-- -----------------------------------------------------------------------------
create or replace function public.set_teacher_active(p_target uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  nm text;
begin
  if auth.uid() is null or not public.is_developer() then
    raise exception 'developer role required' using errcode = '42501';
  end if;
  select coalesce(nullif(btrim(display_name), ''), 'Profesor/a') into nm from public.profiles where id = p_target;
  if not found then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  insert into public.teachers (profile_id, public_name, is_active) values (p_target, nm, p_active)
  on conflict (profile_id) do update set is_active = excluded.is_active;
  insert into public.audit_log (actor_id, actor_role, action, entity_type, entity_id, details)
  values (auth.uid(), 'developer', 'teacher.set_active', 'profile', p_target::text, jsonb_build_object('active', p_active));
end;
$$;

-- set_user_role: ahora con 'profesor'. Pasar a 'profesor' da de alta el perfil; volver a 'user' lo da de baja.
create or replace function public.set_user_role(p_target uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_developer() then
    raise exception 'developer role required' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('user', 'profesor', 'admin', 'developer') then
    raise exception 'invalid role' using errcode = '22023';
  end if;
  update public.profiles set role = p_role where id = p_target;
  if not found then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  if p_role = 'profesor' then
    perform public.set_teacher_active(p_target, true);
  elsif p_role = 'user' then
    update public.teachers set is_active = false where profile_id = p_target and is_active;
  end if;
end;
$$;

-- El panel del developer busca a la persona por correo (el correo vive en auth.users, que el navegador no lee).
create or replace function public.set_user_role_by_email(p_email text, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid;
begin
  if auth.uid() is null or not public.is_developer() then
    raise exception 'developer role required' using errcode = '42501';
  end if;
  select u.id into target from auth.users u where lower(u.email) = lower(btrim(p_email)) limit 1;
  if target is null then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  perform public.set_user_role(target, p_role);
end;
$$;

-- Privilegios: nada para anon salvo lo público; los triggers y helpers no se exponen.
revoke execute on function
  public.book_live_session(uuid), public.cancel_live_booking(uuid), public.teacher_agenda(uuid, timestamptz, timestamptz),
  public.my_live_bookings(), public.set_teacher_active(uuid, boolean), public.set_user_role_by_email(text, text),
  public.is_teacher()
  from public, anon;
grant execute on function
  public.book_live_session(uuid), public.cancel_live_booking(uuid), public.teacher_agenda(uuid, timestamptz, timestamptz),
  public.my_live_bookings(), public.set_teacher_active(uuid, boolean), public.set_user_role_by_email(text, text),
  public.is_teacher()
  to authenticated;
revoke execute on function public.live_agenda(uuid, timestamptz, timestamptz) from public;
grant execute on function public.live_agenda(uuid, timestamptz, timestamptz) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 7. Fotos de perfil (Storage): bucket público de lectura; cada profesor escribe SOLO en su carpeta <uid>/…;
--    la gestión escribe en cualquiera (Manu cambia la foto de quien haga falta).
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('teacher-photos', 'teacher-photos', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy teacher_photos_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'teacher-photos'
    and (public.is_staff() or (public.is_teacher() and split_part(name, '/', 1) = (select auth.uid())::text)));

create policy teacher_photos_update on storage.objects
  for update to authenticated
  using (bucket_id = 'teacher-photos'
    and (public.is_staff() or (public.is_teacher() and split_part(name, '/', 1) = (select auth.uid())::text)))
  with check (bucket_id = 'teacher-photos'
    and (public.is_staff() or (public.is_teacher() and split_part(name, '/', 1) = (select auth.uid())::text)));

create policy teacher_photos_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'teacher-photos'
    and (public.is_staff() or (public.is_teacher() and split_part(name, '/', 1) = (select auth.uid())::text)));

create policy teacher_photos_select on storage.objects
  for select to authenticated
  using (bucket_id = 'teacher-photos'
    and (public.is_staff() or (public.is_teacher() and split_part(name, '/', 1) = (select auth.uid())::text)));
