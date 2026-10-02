-- =============================================================================
-- YogaPop Up · Blindaje de las Fases 0-16
--
-- Las migraciones anteriores NO se tocan (ya están aplicadas): todo lo nuevo va acá.
--
--   1. Límite de frecuencia compartido (rate_limits + rate_limit_hit), para las Edge Functions.
--   2. save_progress(): valida la clase y acota el progreso aunque la duración sea desconocida.
--   3. Topes y formato en la base (precio, stock, duración, URLs de imagen): la validación del navegador
--      no es una barrera, la base sí.
--   4. Auditoría de lo que mueve plata: cambios de precio, activar/ocultar y borrar productos.
--
-- Los CHECK nuevos se crean NOT VALID: se exigen para toda fila nueva o editada, pero no impiden aplicar la
-- migración si en producción ya hubiera una fila fuera de rango. Para exigirlo también a lo viejo:
--   alter table public.<tabla> validate constraint <nombre>;
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Límite de frecuencia
-- -----------------------------------------------------------------------------
create table public.rate_limits (
  key           text        not null check (char_length(key) between 1 and 200),
  window_start  timestamptz not null,
  hits          integer     not null default 0,
  primary key (key, window_start)
);
create index rate_limits_window_idx on public.rate_limits (window_start);

-- RLS sin ninguna política: ningún cliente (anon/authenticated) lee ni escribe. Solo la service role.
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated;

-- Ventana fija: devuelve true si, contando esta, la clave lleva <= p_max peticiones en la ventana actual.
create or replace function public.rate_limit_hit(p_key text, p_max integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start timestamptz;
  v_hits  integer;
begin
  if p_key is null or char_length(p_key) not between 1 and 200 then
    raise exception 'invalid_key' using errcode = '22023';
  end if;
  if p_max is null or p_max not between 1 and 100000 then
    raise exception 'invalid_max' using errcode = '22023';
  end if;
  if p_window_seconds is null or p_window_seconds not between 1 and 86400 then
    raise exception 'invalid_window' using errcode = '22023';
  end if;

  v_start := to_timestamp(floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds);

  insert into public.rate_limits as rl (key, window_start, hits)
  values (p_key, v_start, 1)
  on conflict (key, window_start) do update set hits = rl.hits + 1
  returning rl.hits into v_hits;

  -- Limpieza oportunista (~2 % de las llamadas): la tabla no crece sin límite ni necesita un cron.
  if random() < 0.02 then
    delete from public.rate_limits where window_start < now() - interval '1 day';
  end if;

  return v_hits <= p_max;
end;
$$;

revoke execute on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;

-- -----------------------------------------------------------------------------
-- 2. save_progress(): mismas reglas de siempre + validación de la clase y tope sin duración
--    (misma firma y mismo tipo de retorno: los privilegios de ejecución se conservan)
-- -----------------------------------------------------------------------------
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
  if p_class_id is null or p_seconds is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if not public.can_access_class(p_class_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- can_access_class() es verdadero para el propietario aunque la clase no exista: sin esta comprobación
  -- el INSERT fallaba más abajo con un error de clave foránea poco claro.
  select c.duration_seconds into v_duration from public.classes c where c.id = p_class_id;
  if not found then
    raise exception 'class_not_found' using errcode = 'P0002';
  end if;

  -- Sin duración conocida el valor ya no queda libre: tope de 24 h (misma cota que la duración de una clase).
  v_seconds := greatest(0, least(p_seconds, coalesce(v_duration, 86400)));

  insert into public.video_progress as vp
    (user_id, class_id, progress_seconds, completed, last_watched_at)
  values
    (v_uid, p_class_id, v_seconds,
     coalesce(v_duration is not null and v_duration > 0 and v_seconds >= v_duration * 0.95, false),
     now())
  on conflict (user_id, class_id) do update
    set progress_seconds = excluded.progress_seconds,
        completed        = vp.completed or excluded.completed,   -- una vez completada, queda completada
        last_watched_at  = now()
  returning * into v_row;

  return v_row;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Topes y formato en la base
-- -----------------------------------------------------------------------------
-- Mismos topes que el formulario del panel (js/lib/product-form.js: MAX_PRICE_CENTS / MAX_STOCK).
alter table public.products
  add constraint products_price_max_chk check (price_cents <= 99999999) not valid;
alter table public.products
  add constraint products_stock_max_chk check (stock is null or stock <= 1000000) not valid;

alter table public.classes
  add constraint classes_duration_max_chk check (duration_seconds is null or duration_seconds <= 86400) not valid;

-- Las imágenes se muestran con <img src>: solo https (o localhost, para desarrollo con el CLI de Supabase).
-- Descarta de raíz esquemas como javascript:, data: o http: de un sitio ajeno.
alter table public.products
  add constraint products_image_url_chk check (
    image_url is null or (
      char_length(image_url) <= 2048
      and image_url ~* '^(https://|http://(localhost|127\.0\.0\.1)(:[0-9]+)?/)'
    )
  ) not valid;
alter table public.classes
  add constraint classes_thumbnail_url_chk check (
    thumbnail_url is null or (
      char_length(thumbnail_url) <= 2048
      and thumbnail_url ~* '^(https://|http://(localhost|127\.0\.0\.1)(:[0-9]+)?/)'
    )
  ) not valid;

-- -----------------------------------------------------------------------------
-- 4. Auditoría de productos (lo que mueve plata queda registrado, sea cual sea el canal)
--    Mismo patrón que classes_audit_publish_change. El stock no se audita: cambia con cada ajuste de inventario.
-- -----------------------------------------------------------------------------
create or replace function public.products_audit_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_role  text := (select p.role from public.profiles p where p.id = auth.uid());
begin
  if tg_op = 'DELETE' then
    insert into public.audit_log (actor_id, actor_role, action, entity_type, entity_id, details)
    values (v_actor, v_role, 'product.delete', 'product', old.id::text,
            jsonb_build_object('title', old.title, 'price_cents', old.price_cents, 'was_active', old.is_active));
    return old;
  end if;

  if old.price_cents is distinct from new.price_cents then
    insert into public.audit_log (actor_id, actor_role, action, entity_type, entity_id, details)
    values (v_actor, v_role, 'product.price_change', 'product', new.id::text,
            jsonb_build_object('title', new.title, 'from', old.price_cents, 'to', new.price_cents));
  end if;

  if old.is_active is distinct from new.is_active then
    insert into public.audit_log (actor_id, actor_role, action, entity_type, entity_id, details)
    values (v_actor, v_role,
            case when new.is_active then 'product.activate' else 'product.deactivate' end,
            'product', new.id::text, jsonb_build_object('title', new.title));
  end if;
  return new;
end;
$$;

create trigger products_audit_update
  after update of price_cents, is_active on public.products
  for each row execute function public.products_audit_change();

create trigger products_audit_delete
  after delete on public.products
  for each row execute function public.products_audit_change();

revoke execute on function public.products_audit_change() from public, anon, authenticated;
