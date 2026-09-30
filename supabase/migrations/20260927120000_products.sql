-- =============================================================================
-- YogaPop Up · Fase 12 · Tienda: modelo de datos de productos
--
-- Mismo patrón que `classes` (Fase 0): RLS en todo, solo el propietario/desarrollador
-- escribe, cualquiera lee lo activo. El precio se guarda en céntimos de euro (entero,
-- nunca float) para no arrastrar errores de redondeo en el carrito ni en los pagos.
--
-- A propósito NO tiene una columna de proveedor de pago: eso se decide recién al pagar
-- (Fase 17 en adelante), no en el catálogo.
-- =============================================================================

create table public.products (
  id            uuid primary key default gen_random_uuid(),
  title         text not null check (char_length(title) between 1 and 150),
  description   text check (description is null or char_length(description) <= 5000),
  image_url     text,
  price_cents   integer not null check (price_cents >= 0),        -- EUR, sin decimales (ej. 1999 = 19,99 €)
  -- null = no se controla stock (por ejemplo, un producto digital o "a pedido").
  stock         integer check (stock is null or stock >= 0),
  sort_order    integer not null default 0,
  is_active     boolean not null default false,
  created_by    uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index products_catalog_idx on public.products (is_active, sort_order, created_at desc);

create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

alter table public.products enable row level security;

-- Lectura: cualquiera ve los productos activos (sin sesión, igual que el catálogo de clases);
-- el propietario/desarrollador ve además los inactivos (para poder editarlos antes de publicarlos).
create policy products_select_active on public.products
  for select to anon, authenticated
  using (is_active);

create policy products_select_admin on public.products
  for select to authenticated
  using (public.is_owner());

create policy products_insert_admin on public.products
  for insert to authenticated
  with check (public.is_owner());

create policy products_update_admin on public.products
  for update to authenticated
  using (public.is_owner())
  with check (public.is_owner());

-- A diferencia de `classes` (que se borra vía Edge Function porque primero hay que limpiar el
-- video en R2), un producto no tiene un recurso externo que coordinar: se puede borrar directo
-- por RLS. La imagen en Storage queda como huérfana (mismo trade-off que las miniaturas de clases).
create policy products_delete_admin on public.products
  for delete to authenticated
  using (public.is_owner());

revoke all on public.products from anon, authenticated;

grant select on public.products to anon, authenticated;

grant insert (title, description, image_url, price_cents, stock, sort_order, is_active)
  on public.products to authenticated;
grant update (title, description, image_url, price_cents, stock, sort_order, is_active)
  on public.products to authenticated;
grant delete on public.products to authenticated;
