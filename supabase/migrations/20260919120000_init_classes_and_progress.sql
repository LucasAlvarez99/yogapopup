-- =============================================================================
-- YogaPop Up · Fase 2 · Modelo de datos
-- Tablas: profiles, classes, entitlements, video_progress
--
-- Principios:
--   * RLS activado en TODAS las tablas.
--   * Los privilegios se otorgan explícitamente (columna por columna donde
--     importa). Supabase da privilegios amplios por defecto a anon/authenticated,
--     así que primero se revocan.
--   * Bunny (bunny_video_id / bunny_library_id) NO es legible desde el navegador.
--     Solo lo lee y escribe el backend (Edge Functions con service_role).
--   * El acceso a una clase se decide en UN solo lugar: public.can_access_class().
--     Para sumar premium / cursos / suscripciones se extiende esa función y la
--     tabla entitlements, sin tocar el resto.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Utilidades
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- profiles  (1 fila por usuario de auth.users)
-- -----------------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text check (display_name is null or char_length(display_name) <= 80),
  role          text not null default 'user' check (role in ('user', 'admin')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Crea el perfil al registrarse. El rol SIEMPRE es 'user': nunca se lee de
-- raw_user_meta_data, que el propio usuario controla en el registro.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), 80)
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ¿El usuario actual es admin? (se usa en políticas RLS y en funciones)
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  );
$$;

-- -----------------------------------------------------------------------------
-- classes
-- -----------------------------------------------------------------------------
create table public.classes (
  id                uuid primary key default gen_random_uuid(),
  title             text not null check (char_length(title) between 1 and 150),
  description       text check (description is null or char_length(description) <= 5000),
  thumbnail_url     text,
  duration_seconds  integer check (duration_seconds is null or duration_seconds >= 0),
  level             text not null default 'todos'
                    check (level in ('principiante', 'intermedio', 'avanzado', 'todos')),
  category          text check (category is null or char_length(category) <= 60),

  -- Bunny Stream (solo backend)
  bunny_video_id    text,
  bunny_library_id  text,
  video_status      text not null default 'pending'
                    check (video_status in ('pending', 'uploading', 'processing', 'ready', 'failed')),

  -- Acceso: 'free' = cualquier usuario registrado; 'restricted' = requiere entitlement.
  access_level      text not null default 'free' check (access_level in ('free', 'restricted')),

  sort_order        integer not null default 0,
  is_published      boolean not null default false,
  published_at      timestamptz,
  created_by        uuid default auth.uid() references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- No se puede publicar una clase cuyo video todavía no está listo en Bunny.
  constraint classes_published_requires_ready
    check (not is_published or video_status = 'ready')
);

create unique index classes_bunny_video_id_key
  on public.classes (bunny_video_id) where bunny_video_id is not null;
create index classes_catalog_idx  on public.classes (is_published, sort_order, created_at desc);
create index classes_category_idx on public.classes (category);

create or replace function public.classes_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  if new.is_published then
    if tg_op = 'INSERT' or not old.is_published then
      new.published_at := coalesce(new.published_at, now());
    end if;
  else
    new.published_at := null;
  end if;
  return new;
end;
$$;

create trigger classes_before_write
  before insert or update on public.classes
  for each row execute function public.classes_before_write();

-- -----------------------------------------------------------------------------
-- entitlements  (derechos de acceso; vacía al inicio, lista para premium/cursos)
--   scope = 'all'   -> acceso a todo el contenido restringido (plan/suscripción)
--   scope = 'class' -> acceso a una clase puntual
--   A futuro: scope = 'course' + course_id, sin cambiar el resto.
-- -----------------------------------------------------------------------------
create table public.entitlements (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  scope         text not null check (scope in ('all', 'class')),
  class_id      uuid references public.classes (id) on delete cascade,
  plan          text,
  source        text not null default 'manual',
  external_ref  text,
  granted_at    timestamptz not null default now(),
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  constraint entitlements_scope_class_chk check ((scope = 'class') = (class_id is not null))
);

create index entitlements_user_idx on public.entitlements (user_id);

-- -----------------------------------------------------------------------------
-- Regla de acceso (única fuente de verdad)
-- -----------------------------------------------------------------------------
create or replace function public.can_access_class(p_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.is_admin()
    or exists (
      select 1
      from public.classes c
      where c.id = p_class_id
        and c.is_published
        and c.video_status = 'ready'
        and auth.uid() is not null
        and (
          c.access_level = 'free'
          or exists (
            select 1 from public.entitlements e
            where e.user_id = auth.uid()
              and (e.expires_at is null or e.expires_at > now())
              and (e.scope = 'all' or (e.scope = 'class' and e.class_id = c.id))
          )
        )
    );
$$;

-- -----------------------------------------------------------------------------
-- video_progress  (una fila por usuario y clase)
-- La escritura pasa SOLO por public.save_progress(): valida permisos, limita el
-- valor a la duración y calcula "completed" en el servidor.
-- -----------------------------------------------------------------------------
create table public.video_progress (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  class_id          uuid not null references public.classes (id) on delete cascade,
  progress_seconds  integer not null default 0 check (progress_seconds >= 0),
  completed         boolean not null default false,
  last_watched_at   timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint video_progress_user_class_key unique (user_id, class_id)
);

create index video_progress_recent_idx on public.video_progress (user_id, last_watched_at desc);

create trigger video_progress_set_updated_at
  before update on public.video_progress
  for each row execute function public.set_updated_at();

create or replace function public.save_progress(p_class_id uuid, p_seconds integer)
returns public.video_progress
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_duration  integer;
  v_seconds   integer;
  v_row       public.video_progress;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_seconds is null then
    raise exception 'invalid_seconds' using errcode = '22023';
  end if;
  if not public.can_access_class(p_class_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select c.duration_seconds into v_duration from public.classes c where c.id = p_class_id;
  v_seconds := greatest(0, least(p_seconds, coalesce(v_duration, p_seconds)));

  insert into public.video_progress as vp
    (user_id, class_id, progress_seconds, completed, last_watched_at)
  values
    (v_uid, p_class_id, v_seconds,
     coalesce(v_duration is not null and v_seconds >= v_duration * 0.95, false),
     now())
  on conflict (user_id, class_id) do update
    set progress_seconds = excluded.progress_seconds,
        completed        = vp.completed or excluded.completed,   -- una vez completada, queda completada
        last_watched_at  = now()
  returning * into v_row;

  return v_row;
end;
$$;

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table public.profiles       enable row level security;
alter table public.classes        enable row level security;
alter table public.entitlements   enable row level security;
alter table public.video_progress enable row level security;

-- profiles: cada uno ve y edita el suyo; el admin ve todos.
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or public.is_admin());

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- classes: el catálogo (metadatos) es visible para clases publicadas, también sin
-- login (sirve para mostrarlo en la home). El VIDEO nunca depende de esto: se
-- autoriza en el backend con can_access_class(). El admin ve y gestiona todo.
create policy classes_select_published on public.classes
  for select to anon, authenticated
  using (is_published);

create policy classes_select_admin on public.classes
  for select to authenticated
  using (public.is_admin());

create policy classes_insert_admin on public.classes
  for insert to authenticated
  with check (public.is_admin());

create policy classes_update_admin on public.classes
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- entitlements: el usuario ve los suyos; el admin ve todos. Solo escribe el backend.
create policy entitlements_select on public.entitlements
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

-- video_progress: solo lectura de lo propio. Escribe únicamente save_progress().
create policy video_progress_select_own on public.video_progress
  for select to authenticated
  using (user_id = (select auth.uid()));

-- =============================================================================
-- Privilegios (deny by default)
-- =============================================================================
revoke all on public.profiles, public.classes, public.entitlements, public.video_progress
  from anon, authenticated;

-- profiles
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;      -- 'role' NO editable

-- classes: lectura de columnas públicas (sin bunny_*)
grant select (
  id, title, description, thumbnail_url, duration_seconds, level, category,
  access_level, sort_order, is_published, published_at, video_status,
  created_at, updated_at
) on public.classes to anon, authenticated;

-- classes: el admin crea/edita metadatos desde el panel. Los campos de Bunny,
-- duration_seconds y video_status los escribe solo el backend (service_role).
-- No hay DELETE para clientes: borrar pasa por una Edge Function que también
-- elimina el video en Bunny.
grant insert (title, description, thumbnail_url, level, category, access_level, sort_order, is_published)
  on public.classes to authenticated;
grant update (title, description, thumbnail_url, level, category, access_level, sort_order, is_published)
  on public.classes to authenticated;

grant select on public.entitlements   to authenticated;
grant select on public.video_progress to authenticated;

-- Funciones: nada ejecutable por defecto.
revoke execute on function
  public.set_updated_at(),
  public.handle_new_user(),
  public.classes_before_write(),
  public.is_admin(),
  public.can_access_class(uuid),
  public.save_progress(uuid, integer)
  from public, anon, authenticated;

grant execute on function public.is_admin()                        to authenticated;
grant execute on function public.can_access_class(uuid)            to authenticated;
grant execute on function public.save_progress(uuid, integer)      to authenticated;
