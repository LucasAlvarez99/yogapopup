-- =============================================================================
-- YogaPop Up · Talles de los productos (con stock por talle) y tipo de IVA
--
--   product_variants   un talle de un producto (S, M, L, XL, 2XL…) con su propio stock.
--                      Preparada para sumar colores más adelante (una columna nueva, sin tocar lo existente).
--   save_product_variants()   única vía para escribir talles: atómica, valida y solo la usa el personal de gestión.
--   products.tax_rate_bps     IVA INCLUIDO en el precio, en puntos básicos (2100 = 21 %). El precio guardado
--                             (price_cents) sigue siendo el que paga la persona; este dato solo sirve para
--                             mostrar el precio sin IVA y, más adelante, para facturar.
--
-- Reglas del stock con talles: si un producto tiene talles, MANDA el stock de cada talle y el stock del
-- producto (products.stock) se ignora. NULL = no se controla ese talle; 0 = agotado (misma convención de siempre).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. IVA por producto (el tipo general en España, incluida Ibiza, es el 21 %)
-- -----------------------------------------------------------------------------
alter table public.products
  add column tax_rate_bps integer not null default 2100
    constraint products_tax_rate_bps_chk check (tax_rate_bps between 0 and 2500);

comment on column public.products.tax_rate_bps is
  'IVA incluido en price_cents, en puntos básicos (2100 = 21 %, 1000 = 10 %, 400 = 4 %, 0 = exento). Confirmar los tipos con la gestoría.';

-- El personal de gestión puede fijarlo desde el panel (mismo criterio que el resto de columnas editables).
grant insert (tax_rate_bps) on public.products to authenticated;
grant update (tax_rate_bps) on public.products to authenticated;

-- Un cambio de IVA queda registrado igual que un cambio de precio (afecta a lo que se factura).
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

  if old.tax_rate_bps is distinct from new.tax_rate_bps then
    insert into public.audit_log (actor_id, actor_role, action, entity_type, entity_id, details)
    values (v_actor, v_role, 'product.tax_change', 'product', new.id::text,
            jsonb_build_object('title', new.title, 'from', old.tax_rate_bps, 'to', new.tax_rate_bps));
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

drop trigger if exists products_audit_update on public.products;
create trigger products_audit_update
  after update of price_cents, is_active, tax_rate_bps on public.products
  for each row execute function public.products_audit_change();

-- -----------------------------------------------------------------------------
-- 2. Talles
-- -----------------------------------------------------------------------------
create table public.product_variants (
  id          uuid        primary key default gen_random_uuid(),
  product_id  uuid        not null references public.products (id) on delete cascade,
  size        text        not null check (size = btrim(size) and char_length(size) between 1 and 20),
  stock       integer     check (stock is null or stock between 0 and 1000000),
  sort_order  integer     not null default 0,
  created_at  timestamptz not null default now()
);

-- Un talle no se repite dentro de un producto, sin importar mayúsculas ("m" = "M").
create unique index product_variants_product_size_key on public.product_variants (product_id, lower(size));
create index product_variants_product_idx on public.product_variants (product_id, sort_order);

alter table public.product_variants enable row level security;

-- Lectura: quien puede ver el producto (activo) ve sus talles; el personal de gestión ve todos.
create policy product_variants_select_active on public.product_variants
  for select to anon, authenticated
  using (exists (select 1 from public.products p where p.id = product_id and p.is_active));

create policy product_variants_select_staff on public.product_variants
  for select to authenticated
  using (public.is_staff());

-- Escritura: NINGUNA directa. Todo pasa por save_product_variants() (atómica y validada).
revoke all on public.product_variants from anon, authenticated;
grant select on public.product_variants to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. save_product_variants(): reemplaza los talles de un producto, de forma atómica
--
--    p_variants: [{"size": "M", "stock": 5}, {"size": "L", "stock": null}, ...]  (el orden del arreglo es el orden
--    en pantalla). Los talles que ya existían conservan su id (los carritos y, más adelante, los pedidos lo usan);
--    los que no vienen en la lista se borran. Una lista vacía quita todos los talles del producto.
-- -----------------------------------------------------------------------------
create or replace function public.save_product_variants(p_product_id uuid, p_variants jsonb)
returns setof public.product_variants
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_elem   jsonb;
  v_pos    integer := 0;
  v_size   text;
  v_stock  numeric;
  v_seen   text[] := '{}';
begin
  if auth.uid() is null or not public.is_staff() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_product_id is null or not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
  if p_variants is null or jsonb_typeof(p_variants) <> 'array' then
    raise exception 'variants must be a json array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_variants) > 20 then
    raise exception 'too many sizes (max 20)' using errcode = '22023';
  end if;

  -- 1) Validar TODO antes de escribir nada.
  for v_elem in select value from jsonb_array_elements(p_variants) loop
    -- coalesce: si falta la clave, jsonb_typeof devuelve NULL y la comparación quedaría en NULL (la validación se saltaría)
    if jsonb_typeof(v_elem) is distinct from 'object' or coalesce(jsonb_typeof(v_elem -> 'size'), '') <> 'string' then
      raise exception 'each size needs a text "size"' using errcode = '22023';
    end if;
    v_size := btrim(v_elem ->> 'size');
    if char_length(v_size) not between 1 and 20 then
      raise exception 'size must have 1 to 20 characters' using errcode = '22023';
    end if;
    if v_size ~ '[[:cntrl:]]' then
      raise exception 'size has invalid characters' using errcode = '22023';
    end if;
    if lower(v_size) = any (v_seen) then
      raise exception 'duplicated size: %', v_size using errcode = '22023';
    end if;
    v_seen := v_seen || lower(v_size);

    if v_elem ? 'stock' and jsonb_typeof(v_elem -> 'stock') <> 'null' then
      if jsonb_typeof(v_elem -> 'stock') <> 'number' then
        raise exception 'stock must be a number or null' using errcode = '22023';
      end if;
      v_stock := (v_elem ->> 'stock')::numeric;
      if v_stock <> trunc(v_stock) or v_stock not between 0 and 1000000 then
        raise exception 'stock must be an integer between 0 and 1000000' using errcode = '22023';
      end if;
    end if;
  end loop;

  -- 2) Quitar los talles que ya no están en la lista.
  delete from public.product_variants
  where product_id = p_product_id and lower(size) <> all (v_seen);

  -- 3) Crear o actualizar los demás, en el orden recibido.
  for v_elem in select value from jsonb_array_elements(p_variants) loop
    v_size := btrim(v_elem ->> 'size');
    v_stock := case when v_elem ? 'stock' and jsonb_typeof(v_elem -> 'stock') = 'number'
                    then (v_elem ->> 'stock')::numeric end;
    insert into public.product_variants (product_id, size, stock, sort_order)
    values (p_product_id, v_size, v_stock::integer, v_pos)
    on conflict (product_id, (lower(size)))
    do update set size = excluded.size, stock = excluded.stock, sort_order = excluded.sort_order;
    v_pos := v_pos + 1;
  end loop;

  return query
    select * from public.product_variants where product_id = p_product_id order by sort_order, created_at;
end;
$$;

revoke execute on function public.save_product_variants(uuid, jsonb) from public, anon;
grant execute on function public.save_product_variants(uuid, jsonb) to authenticated;
