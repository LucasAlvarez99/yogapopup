-- =============================================================================
-- YogaPop Up · Tres escalas de usuario: user · admin · developer
--
--   user       usuario final: solo la aplicación pública.
--   admin      gestión del contenido: editar, publicar/despublicar y BORRAR clases; crear, editar, activar/ocultar
--              y borrar productos. NO sube videos (ni crea clases nuevas, que nacen con su video).
--   developer  TODO lo del admin + subir videos + cambiar roles de otras personas + leer el historial interno.
--
-- Esto reemplaza al rol 'owner' (propietario) de la Fase 4: quien era 'owner' pasa a 'admin'. La diferencia real
-- respecto de antes es una sola: subir videos pasa a ser exclusivo del developer.
--
-- Cómo se garantiza "el admin no sube", en TRES capas (no basta con esconder un botón):
--   1. Edge Function admin-create-upload: exige developer (única vía para obtener una URL de subida a R2).
--   2. Esta base: solo el developer puede INSERTAR en public.classes (una clase nace con su video).
--   3. El panel oculta las acciones de subida al admin (comodidad; no es una barrera).
--
-- Nombres de funciones:
--   is_staff()      admin O developer  (antes is_owner(): mismo cuerpo conceptual, nombre que no confunde con el rol)
--   is_developer()  solo developer     (sin cambios)
--   is_admin()      ALIAS HISTÓRICO de is_staff(): verdadero también para developer. Lo usan las políticas más
--                   antiguas (clases, perfiles, miniaturas). En código nuevo usar is_staff().
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Roles: owner -> admin
--    (los triggers de auditoría dejan registrado cada cambio de rol; el actor es null porque lo hace la migración)
-- -----------------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;

update public.profiles set role = 'admin' where role = 'owner';

alter table public.profiles
  add constraint profiles_role_check check (role in ('user', 'admin', 'developer'));

-- -----------------------------------------------------------------------------
-- 2. Funciones de rol
--    ALTER ... RENAME conserva los privilegios y las políticas RLS que ya dependen de la función (products,
--    product-images): no hace falta recrearlas.
-- -----------------------------------------------------------------------------
alter function public.is_owner() rename to is_staff;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('admin', 'developer')
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_staff();
$$;

comment on function public.is_staff() is
  'Personal de gestión: rol admin O developer.';
comment on function public.is_admin() is
  'ALIAS HISTÓRICO de is_staff(): es verdadero también para developer, NO significa "role = admin". Usar is_staff() en código nuevo.';
comment on function public.is_developer() is
  'Solo el rol developer: subir videos, cambiar roles y leer el historial interno.';

-- -----------------------------------------------------------------------------
-- 3. Subir = solo developer. Una clase nace junto con su video (admin-create-upload), así que crear filas en
--    public.classes desde el navegador queda reservado al developer. Editar y borrar siguen siendo de la gestión.
-- -----------------------------------------------------------------------------
drop policy if exists classes_insert_admin on public.classes;

create policy classes_insert_developer on public.classes
  for insert to authenticated
  with check (public.is_developer());

-- -----------------------------------------------------------------------------
-- 4. Cambio de roles: solo developer, con los valores nuevos
-- -----------------------------------------------------------------------------
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
  if p_role is null or p_role not in ('user', 'admin', 'developer') then
    raise exception 'invalid role' using errcode = '22023';
  end if;
  update public.profiles set role = p_role where id = p_target;
  if not found then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
end;
$$;
