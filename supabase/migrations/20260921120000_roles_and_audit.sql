-- =============================================================================
-- YogaPop Up · Fase 4 · Tres niveles de acceso + historial de auditoría
--
--   user       usuario final: solo la aplicación pública.
--   owner      propietario: panel de negocio (clases, catálogo, usuarios, entitlements, métricas).
--   developer  desarrollador: TODO lo del propietario + panel técnico (diagnóstico, reconciliación, config).
--
-- Decisiones:
--   * developer es un superconjunto de owner (is_owner() es verdadero para ambos), y todo queda auditado.
--   * Ninguno recibe secretos: eso no depende de la base sino de que las claves solo viven en las Edge Functions.
--   * El rol NO es editable por clientes (privilegio por columna, ya vigente). Solo un developer puede cambiarlo,
--     y únicamente mediante set_user_role(), que deja registro y protege al último developer.
--   * is_admin() sigue existiendo como alias de is_owner(): las políticas RLS anteriores no cambian de significado
--     para quien ya era admin (que pasa a ser owner).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Roles
-- -----------------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;

-- Quien era 'admin' pasa a 'owner' (el panel de negocio que ya usaba).
update public.profiles set role = 'owner' where role = 'admin';

alter table public.profiles
  add constraint profiles_role_check check (role in ('user', 'owner', 'developer'));

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('owner', 'developer')
  );
$$;

create or replace function public.is_developer()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'developer'
  );
$$;

-- Alias por compatibilidad con las políticas y funciones ya existentes.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_owner();
$$;

revoke execute on function public.is_owner(), public.is_developer() from public, anon, authenticated;
grant execute on function public.is_owner(), public.is_developer() to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Historial de auditoría (solo inserción)
-- -----------------------------------------------------------------------------
create table public.audit_log (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  -- Sin clave foránea a propósito: borrar un usuario no debe tocar (ni bloquearse por) su historial.
  actor_id     uuid,
  actor_role   text,
  action       text not null check (char_length(action) between 3 and 80),
  entity_type  text check (entity_type is null or char_length(entity_type) <= 40),
  entity_id    text check (entity_id is null or char_length(entity_id) <= 80),
  details      jsonb not null default '{}'::jsonb check (pg_column_size(details) < 16384)
);

create index audit_log_at_idx     on public.audit_log (at desc);
create index audit_log_actor_idx  on public.audit_log (actor_id, at desc);
create index audit_log_entity_idx on public.audit_log (entity_type, entity_id, at desc);

alter table public.audit_log enable row level security;

-- Lectura: solo desarrolladores (el propietario ve métricas de negocio, no el registro interno).
create policy audit_log_select_developer on public.audit_log
  for select to authenticated
  using (public.is_developer());

revoke all on public.audit_log from anon, authenticated;
grant select on public.audit_log to authenticated;

-- Inmutable: ni siquiera service_role ni un administrador de la base pueden editar o borrar (ni vaciar) el historial.
create or replace function public.audit_log_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_log is append-only' using errcode = '42501';
end;
$$;

create trigger audit_log_no_update_delete
  before update or delete on public.audit_log
  for each row execute function public.audit_log_immutable();

create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function public.audit_log_immutable();

-- Escritura desde el backend. El rol del actor se busca en la base: el llamador no puede inventarlo.
create or replace function public.audit_write(
  p_actor uuid,
  p_action text,
  p_entity_type text default null,
  p_entity_id text default null,
  p_details jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into public.audit_log (actor_id, actor_role, action, entity_type, entity_id, details)
  values (
    p_actor,
    (select p.role from public.profiles p where p.id = p_actor),
    p_action, p_entity_type, p_entity_id, coalesce(p_details, '{}'::jsonb)
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.audit_write(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.audit_write(uuid, text, text, text, jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- 3. Cambios de rol: controlados y auditados
-- -----------------------------------------------------------------------------
-- Protege al último developer, sea cual sea la vía del cambio.
create or replace function public.profiles_protect_last_developer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'developer' and new.role <> 'developer'
     and not exists (select 1 from public.profiles p where p.role = 'developer' and p.id <> old.id) then
    raise exception 'cannot remove the last developer' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger profiles_protect_last_developer
  before update of role on public.profiles
  for each row execute function public.profiles_protect_last_developer();

-- Todo cambio de rol queda registrado (también los hechos desde el editor SQL: ahí el actor es null).
create or replace function public.profiles_audit_role_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role is distinct from new.role then
    insert into public.audit_log (actor_id, actor_role, action, entity_type, entity_id, details)
    values (
      auth.uid(),
      (select p.role from public.profiles p where p.id = auth.uid()),
      'role.change', 'profile', new.id::text,
      jsonb_build_object('from', old.role, 'to', new.role)
    );
  end if;
  return new;
end;
$$;

create trigger profiles_audit_role_change
  after update of role on public.profiles
  for each row execute function public.profiles_audit_role_change();

-- Único camino para que una persona cambie el rol de otra: solo desarrolladores.
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
  if p_role is null or p_role not in ('user', 'owner', 'developer') then
    raise exception 'invalid role' using errcode = '22023';
  end if;
  update public.profiles set role = p_role where id = p_target;
  if not found then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.set_user_role(uuid, text) from public, anon, authenticated;
grant execute on function public.set_user_role(uuid, text) to authenticated;

-- Los triggers no necesitan privilegio de ejecución para los clientes.
revoke execute on function
  public.audit_log_immutable(),
  public.profiles_protect_last_developer(),
  public.profiles_audit_role_change()
  from public, anon, authenticated;
