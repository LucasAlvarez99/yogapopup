-- =============================================================================
-- YogaPop Up · Comentarios de la comunidad (Fases 26-27)
--
--   testimonials   un comentario por persona ("Lo que dice nuestra comunidad", sección Sobre nosotros de la home).
--
-- Moderación (Fase 27): el comentario NACE 'pending' y solo se ve en público cuando la gestión lo pasa a 'approved'.
--   pending   recién escrito (o editado por su autor): lo ve solo su autor y la gestión.
--   approved  público: lo ve cualquiera, también sin sesión.
--   hidden    la gestión lo ocultó: lo ve solo su autor y la gestión.
--
-- Quién puede qué (lo decide la base; la interfaz solo ordena lo que se muestra):
--   cualquiera (anon)   lee los aprobados, sin user_id ni estado: nada que identifique a la cuenta.
--   persona con sesión  escribe el SUYO (uno por persona, queda 'pending'), lo edita (vuelve a 'pending') y lo borra.
--                       No puede cambiar su estado: un comentario no se aprueba a sí mismo.
--   gestión (admin y developer)  ve todos, cambia el estado, edita y borra cualquiera. Cada cambio de estado y cada
--                       borrado ajeno queda en audit_log.
-- El profesor NO es gestión (is_staff() es falso para el rol 'profesor').
-- =============================================================================

create table public.testimonials (
  id            uuid primary key default gen_random_uuid(),
  -- Un comentario por persona: no hay forma de inundar la sección. Si se borra la cuenta, se borra el comentario.
  user_id       uuid not null unique default auth.uid() references public.profiles (id) on delete cascade,
  -- Nombre que se muestra, copiado del perfil al escribir/editar: el público no necesita (ni puede) leer profiles.
  author_name   text not null check (char_length(btrim(author_name)) between 1 and 80),
  body          text not null check (char_length(btrim(body)) between 10 and 600),
  rating        smallint check (rating is null or rating between 1 and 5),
  status        text not null default 'pending' check (status in ('pending', 'approved', 'hidden')),
  moderated_by  uuid,
  moderated_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index testimonials_public_idx on public.testimonials (created_at desc) where status = 'approved';
create index testimonials_status_idx on public.testimonials (status, created_at desc);

create trigger testimonials_set_updated_at
  before update on public.testimonials
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Reglas que no se pueden dejar a la interfaz
-- -----------------------------------------------------------------------------
create or replace function public.testimonials_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_staff boolean := coalesce(public.is_staff(), false);
  v_name  text;
begin
  -- Nombre que se muestra: el del perfil de la persona DUEÑA del comentario (nunca lo que mande el cliente).
  select nullif(btrim(p.display_name), '') into v_name from public.profiles p where p.id = new.user_id;

  if tg_op = 'INSERT' then
    new.status := 'pending';                -- nace sin aprobar, escriba quien escriba
    new.moderated_by := null;
    new.moderated_at := null;
    new.author_name := coalesce(v_name, 'Alumno/a');
    new.body := btrim(new.body);
    return new;
  end if;

  -- UPDATE. Sin sesión (backend con service_role) no hay nada que comprobar.
  if v_actor is null then
    return new;
  end if;

  new.body := btrim(new.body);
  if new.status is distinct from old.status then
    if not v_staff then
      raise exception 'only staff can change the status of a testimonial' using errcode = '42501';
    end if;
    new.moderated_by := v_actor;
    new.moderated_at := now();
  elsif (new.body is distinct from old.body or new.rating is distinct from old.rating) and not v_staff then
    -- La persona editó su texto: vuelve a revisión (si no, aprobarían algo y luego lo cambiarían).
    new.status := 'pending';
    new.moderated_by := null;
    new.moderated_at := null;
    new.author_name := coalesce(v_name, 'Alumno/a');
  end if;
  return new;
end;
$$;

create trigger testimonials_before_write
  before insert or update on public.testimonials
  for each row execute function public.testimonials_before_write();

-- Auditoría: cambios de estado y borrados que hace otra persona (la gestión).
create or replace function public.testimonials_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_role  text := (select p.role from public.profiles p where p.id = auth.uid());
begin
  if tg_op = 'UPDATE' then
    if old.status is distinct from new.status then
      insert into public.audit_log (actor_id, actor_role, action, entity_type, entity_id, details)
      values (v_actor, v_role, 'testimonial.moderate', 'testimonial', new.id::text,
              jsonb_build_object('from', old.status, 'to', new.status, 'author', new.author_name));
    end if;
    return new;
  end if;

  if v_actor is distinct from old.user_id then
    insert into public.audit_log (actor_id, actor_role, action, entity_type, entity_id, details)
    values (v_actor, v_role, 'testimonial.delete', 'testimonial', old.id::text,
            jsonb_build_object('status', old.status, 'author', old.author_name));
  end if;
  return old;
end;
$$;

create trigger testimonials_audit_update
  after update on public.testimonials
  for each row execute function public.testimonials_audit();
create trigger testimonials_audit_delete
  after delete on public.testimonials
  for each row execute function public.testimonials_audit();

-- -----------------------------------------------------------------------------
-- RLS + privilegios por columna
-- -----------------------------------------------------------------------------
alter table public.testimonials enable row level security;

-- anon no puede ejecutar is_staff(): por eso su política es aparte.
create policy testimonials_select_public on public.testimonials
  for select to anon
  using (status = 'approved');

create policy testimonials_select on public.testimonials
  for select to authenticated
  using (status = 'approved' or user_id = (select auth.uid()) or public.is_staff());

create policy testimonials_insert on public.testimonials
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy testimonials_update on public.testimonials
  for update to authenticated
  using (user_id = (select auth.uid()) or public.is_staff())
  with check (user_id = (select auth.uid()) or public.is_staff());

create policy testimonials_delete on public.testimonials
  for delete to authenticated
  using (user_id = (select auth.uid()) or public.is_staff());

revoke all on public.testimonials from anon, authenticated;
grant select (id, author_name, body, rating, created_at) on public.testimonials to anon;
grant select on public.testimonials to authenticated;
-- user_id, author_name y los datos de moderación los pone la base: la persona solo manda texto y puntuación.
grant insert (body, rating) on public.testimonials to authenticated;
-- 'status' se concede para que la gestión lo cambie desde el panel; el trigger se lo niega a todos los demás.
grant update (body, rating, status) on public.testimonials to authenticated;
grant delete on public.testimonials to authenticated;
