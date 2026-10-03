-- =============================================================================
-- YogaPop Up · Prueba de aceptación de la política de privacidad (RGPD)
--
-- El RGPD obliga a poder DEMOSTRAR que la persona aceptó (art. 7.1) y qué texto vio. Hasta ahora el registro solo
-- exigía marcar la casilla en el navegador, sin dejar rastro. Ahora el perfil guarda:
--   privacy_accepted_at  cuándo (hora del SERVIDOR: el navegador no puede fijarla ni retrocederla)
--   privacy_version      qué versión de la política (AAAA-MM-DD, la de js/lib/legal.js)
--
-- Cómo llega: el frontend manda `privacy_version` en la metadata del registro SOLO si se marcó la casilla; el trigger
-- handle_new_user() la valida y fija la fecha. Cualquier otra cosa en la metadata (una fecha propia, un rol…) se ignora.
-- Quien se registró antes de esta migración queda con ambos campos en null (no consta aceptación).
-- =============================================================================

alter table public.profiles
  add column privacy_accepted_at timestamptz,
  add column privacy_version text check (privacy_version is null or privacy_version ~ '^\d{4}-\d{2}-\d{2}$');

comment on column public.profiles.privacy_accepted_at is
  'Hora (del servidor) en que la persona aceptó la política de privacidad al registrarse. Null = no consta.';
comment on column public.profiles.privacy_version is
  'Versión (AAAA-MM-DD) de la política que aceptó. Ver PRIVACY_VERSION en js/lib/legal.js.';

-- Los permisos por columna de la Fase 0 ya cubren esto sin tocar nada: authenticated solo puede UPDATE de
-- display_name, así que estas dos columnas no las puede editar nadie desde el navegador (ni siquiera el propio usuario).

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version text := nullif(trim(new.raw_user_meta_data ->> 'privacy_version'), '');
begin
  -- Solo una versión con formato válido cuenta como aceptación; si no, queda sin registrar (nunca falla el alta).
  if v_version is not null and v_version !~ '^\d{4}-\d{2}-\d{2}$' then
    v_version := null;
  end if;

  insert into public.profiles (id, display_name, privacy_accepted_at, privacy_version)
  values (
    new.id,
    left(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), 80),
    case when v_version is not null then now() end,
    v_version
  );
  return new;
end;
$$;
