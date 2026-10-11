-- =============================================================================
-- YogaPop Up · Comentarios: se publican solos + palabras prohibidas (suspensión de 168 h)
--
-- Cambia la moderación de la migración 20261009120000:
--   ANTES  el comentario nacía 'pending' y la gestión tenía que aprobarlo.
--   AHORA  nace 'approved' (se ve en la home al instante), salvo que tenga una palabra prohibida:
--            · queda 'hidden' (no se publica; lo ven su autora y la gestión), y
--            · la cuenta de la autora se suspende 168 horas (7 días) con auth.users.banned_until:
--              Supabase Auth le impide iniciar sesión y renovar la sesión hasta que pase ese plazo.
--          Cada suspensión queda en audit_log ('user.auto_suspend').
--   La gestión (admin/developer) nunca se suspende sola. Sigue pudiendo ocultar o aprobar a mano desde el panel,
--   y si oculta un comentario, su autora no lo vuelve a publicar editándolo.
--   Mientras una cuenta está suspendida no puede crear ni editar comentarios (aunque conserve un token vivo).
--
-- Palabras prohibidas: tabla public.banned_words (la gestión la lee y la edita; nadie más). Se comparan sin importar
-- mayúsculas, tildes, signos ni letras repetidas ("PUUUTA", "m1erda", "mierdaaa") y como PALABRA COMPLETA, así que
-- "computadora" no dispara a "puta". Las letras separadas por puntos o espacios ("p.u.t.a") no se detectan.
-- Agregar o quitar palabras: ver README.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Lista de palabras prohibidas
-- -----------------------------------------------------------------------------
create table public.banned_words (
  word        text primary key check (char_length(btrim(word)) between 2 and 60),
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);

alter table public.banned_words enable row level security;

create policy banned_words_select on public.banned_words
  for select to authenticated using (public.is_staff());
create policy banned_words_insert on public.banned_words
  for insert to authenticated with check (public.is_staff());
create policy banned_words_delete on public.banned_words
  for delete to authenticated using (public.is_staff());

revoke all on public.banned_words from anon, authenticated;
grant select, delete on public.banned_words to authenticated;
grant insert (word) on public.banned_words to authenticated;

-- Punto de partida: insultos claros. Se evitaron palabras que también son nombres o cosas comunes ("concha", "foro",
-- "cono") para no suspender a alguien por error. Se completa a gusto desde el SQL Editor (ver README).
insert into public.banned_words (word) values
  ('puta'), ('puto'), ('putas'), ('putos'), ('hijo de puta'), ('hijos de puta'), ('hijoputa'), ('hijodeputa'), ('hijueputa'),
  ('hdp'), ('mierda'), ('pelotudo'), ('pelotuda'), ('pelotudos'), ('conchudo'), ('conchuda'), ('ctm'),
  ('la concha de tu madre'), ('concha de tu madre'), ('pija'), ('pijas'), ('pajero'), ('pajera'),
  ('idiota'), ('idiotas'), ('imbecil'), ('imbeciles'), ('estupido'), ('estupida'), ('estupidos'),
  ('retrasado'), ('retrasada'), ('mogolico'), ('mogolica'), ('subnormal'),
  ('maricon'), ('maricones'), ('trolo'), ('sudaca'), ('malparido'), ('malparida'), ('gonorrea'),
  ('fuck'), ('fucking'), ('fucker'), ('motherfucker'), ('shit'), ('bitch'), ('asshole'), ('cunt'), ('bastard')
on conflict (word) do nothing;

-- -----------------------------------------------------------------------------
-- 2. Funciones de apoyo (solo las usa el trigger: ni la API ni el navegador las ejecutan)
-- -----------------------------------------------------------------------------
-- Pasa a minúsculas, saca tildes, cambia números/símbolos usados como letras (0→o 1→i 3→e 4→a 5→s 7→t @→a $→s), deja
-- solo letras y dígitos separados por un espacio y junta las letras repetidas ("mierdaaa" → "mierda").
create or replace function public.moderation_normalize(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(regexp_replace(
    regexp_replace(
      translate(
        translate(lower(coalesce(p, '')), 'áàäâãéèëêíìïîóòöôõúùüûñ', 'aaaaaeeeeiiiiooooouuuun'),
        '013457@$', 'oieastas'),
      '[^a-z0-9]+', ' ', 'g'),
    '([a-z0-9])\1+', '\1', 'g'));
$$;

-- ¿El texto contiene alguna palabra (o frase) prohibida, como palabra completa?
create or replace function public.contains_banned_word(p text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.banned_words w
    where char_length(public.moderation_normalize(w.word)) >= 2
      and (' ' || public.moderation_normalize(p) || ' ') like ('% ' || public.moderation_normalize(w.word) || ' %')
  );
$$;

-- Suspende la cuenta 168 horas. Devuelve hasta cuándo, o null si no se suspendió (la gestión no se suspende).
create or replace function public.moderation_suspend_user(p_user uuid, p_reason text, p_source text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_until timestamptz := now() + interval '168 hours';
  v_role  text := (select p.role from public.profiles p where p.id = p_user);
begin
  if v_role in ('admin', 'developer') then return null; end if;
  update auth.users u set banned_until = greatest(coalesce(u.banned_until, v_until), v_until) where u.id = p_user;
  insert into public.audit_log (actor_id, actor_role, action, entity_type, entity_id, details)
  values (p_user, v_role, 'user.auto_suspend', 'user', p_user::text,
          jsonb_build_object('reason', p_reason, 'source', p_source, 'hours', 168, 'until', v_until));
  return v_until;
end;
$$;

revoke execute on function public.moderation_normalize(text), public.contains_banned_word(text),
  public.moderation_suspend_user(uuid, text, text) from public, anon, authenticated;

-- ¿Hasta cuándo está suspendida MI cuenta? (null = no lo está). Lo usa la web para explicar qué pasó; nunca expone a otras cuentas.
create or replace function public.my_suspension()
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select u.banned_until from auth.users u where u.id = auth.uid() and u.banned_until > now();
$$;

revoke execute on function public.my_suspension() from public, anon;
grant execute on function public.my_suspension() to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Reglas del comentario (reemplaza el trigger de la migración 20261009120000)
-- -----------------------------------------------------------------------------
create or replace function public.testimonials_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := auth.uid();
  v_staff   boolean := coalesce(public.is_staff(), false);
  v_name    text;
  v_flagged boolean;
begin
  -- Cuenta suspendida: no escribe ni edita, aunque todavía tenga un token vivo (la gestión queda afuera).
  if v_actor is not null and not v_staff
     and exists (select 1 from auth.users u where u.id = v_actor and u.banned_until > now()) then
    raise exception 'account suspended' using errcode = 'YP001';
  end if;

  -- Nombre que se muestra: el del perfil de la persona DUEÑA del comentario (nunca lo que mande el cliente).
  select nullif(btrim(p.display_name), '') into v_name from public.profiles p where p.id = new.user_id;

  if tg_op = 'INSERT' then
    new.body := btrim(new.body);
    new.author_name := coalesce(v_name, 'Alumno/a');
    new.moderated_by := null;
    new.moderated_at := null;
    v_flagged := public.contains_banned_word(new.body);
    new.status := case when v_flagged then 'hidden' else 'approved' end;   -- el estado lo decide la base, escriba quien escriba
    if v_flagged then perform public.moderation_suspend_user(new.user_id, 'banned_word', 'testimonial'); end if;
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
    -- La persona editó su texto: se vuelve a revisar con la misma lista.
    new.author_name := coalesce(v_name, 'Alumno/a');
    v_flagged := public.contains_banned_word(new.body);
    if v_flagged then perform public.moderation_suspend_user(new.user_id, 'banned_word', 'testimonial'); end if;
    if v_flagged or (old.status = 'hidden' and old.moderated_by is not null) then
      new.status := 'hidden';             -- con palabra prohibida, o la gestión lo había ocultado: editarlo no lo publica
    else
      new.status := 'approved';
      new.moderated_by := null;
      new.moderated_at := null;
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.testimonials_before_write() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Lo que estaba esperando aprobación se publica ahora (salvo lo que tenga una palabra prohibida: queda oculto)
-- -----------------------------------------------------------------------------
update public.testimonials t
   set status = case when public.contains_banned_word(t.body) then 'hidden' else 'approved' end
 where t.status = 'pending';
