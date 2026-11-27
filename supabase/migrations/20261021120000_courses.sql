-- =============================================================================
-- YogaPop Up · Cursos (serie de videos)
--
--   Un CURSO es una fila de public.classes con kind = 'course': no tiene video propio (video_status = 'ready' y sin key de R2,
--   para que precio, carrito, nivel mínimo y accesos funcionen igual que en un video suelto sin tocar los pagos).
--   Sus VIDEOS son filas normales de classes con course_id apuntando al curso (cantidad ilimitada; se pueden sumar más después).
--   El orden dentro del curso es sort_order (el menor va primero).
--
--   Acceso (una sola regla, can_access_class): un video de un curso se ve si se tiene acceso al CURSO:
--     * curso gratis, o
--     * suscripción con nivel suficiente para el curso (classes.min_tier del curso), o
--     * compra del curso suelto (entitlement scope 'class' con class_id = id del curso; 30 días como cualquier clase suelta).
--   El nivel, el acceso y el precio de un video de curso NO se usan: manda el curso.
--   Los cursos se compran por el mismo carrito (type 'class' con el id del curso): payments_create_order no cambia.
-- =============================================================================

-- 1. Columnas y restricciones
alter table public.classes
  add column kind text not null default 'video'
    constraint classes_kind_chk check (kind in ('video', 'course')),
  add column course_id uuid references public.classes (id) on delete restrict;

alter table public.classes
  add constraint classes_course_shape_chk check (
    (kind = 'course' and course_id is null and r2_object_key is null and video_status = 'ready')
    or kind = 'video'
  );

create index classes_course_idx on public.classes (course_id, sort_order, created_at) where course_id is not null;

comment on column public.classes.kind is
  '''video'' = una clase con su propio video; ''course'' = serie de videos (sin video propio, sus videos tienen course_id).';
comment on column public.classes.course_id is
  'Curso al que pertenece este video (null = video suelto). Un curso con videos no se puede borrar: primero se borran sus videos.';

-- El padre de un video tiene que ser un curso, y un curso no puede estar dentro de otro.
create or replace function public.classes_check_course_parent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.course_id is not null then
    if new.kind <> 'video' then
      raise exception 'a course cannot belong to another course' using errcode = '23514';
    end if;
    if not exists (select 1 from public.classes p where p.id = new.course_id and p.kind = 'course') then
      raise exception 'course_id must point to a course' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger classes_check_course_parent
  before insert or update of course_id, kind on public.classes
  for each row execute function public.classes_check_course_parent();

revoke execute on function public.classes_check_course_parent() from public, anon, authenticated;

-- Lectura pública de las dos columnas (el catálogo las necesita; la key de R2 sigue restringida).
grant select (kind, course_id) on public.classes to anon, authenticated;

-- 2. Regla de acceso: un video de curso hereda el acceso del curso.
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
      left join public.classes p on p.id = c.course_id
      where c.id = p_class_id
        and c.is_published
        and c.video_status = 'ready'
        and (c.course_id is null or p.is_published)
        and auth.uid() is not null
        and (
          coalesce(p.access_level, c.access_level) = 'free'
          or exists (
            select 1 from public.entitlements e
            where e.user_id = auth.uid()
              and (e.expires_at is null or e.expires_at > now())
              and (
                (e.scope = 'all' and (e.tier is null or e.tier >= coalesce(p.min_tier, c.min_tier)))
                or (e.scope = 'class' and e.class_id = coalesce(p.id, c.id))
              )
          )
        )
    );
$$;

-- 3. Crear un curso (solo developer, como crear una clase). Nace sin publicar. Queda auditado.
create or replace function public.create_course(
  p_title        text,
  p_description  text,
  p_category     text,
  p_level        text,
  p_access_level text,
  p_min_tier     smallint,
  p_sort_order   integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null or not public.is_developer() then
    raise exception 'developer role required' using errcode = '42501';
  end if;

  insert into public.classes (title, description, category, level, access_level, min_tier, sort_order,
                              kind, video_status, is_published, created_by)
  values (btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''), nullif(btrim(coalesce(p_category, '')), ''),
          coalesce(p_level, 'todos'), coalesce(p_access_level, 'free'), coalesce(p_min_tier, 1), coalesce(p_sort_order, 0),
          'course', 'ready', false, auth.uid())
  returning id into v_id;

  insert into public.audit_log (actor_id, actor_role, action, entity_type, entity_id, details)
  values (auth.uid(), (select p.role from public.profiles p where p.id = auth.uid()),
          'course.create', 'class', v_id::text, jsonb_build_object('title', btrim(p_title)));
  return v_id;
end;
$$;

revoke execute on function public.create_course(text, text, text, text, text, smallint, integer) from public, anon;
grant execute on function public.create_course(text, text, text, text, text, smallint, integer) to authenticated;
