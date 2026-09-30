-- =============================================================================
-- YogaPop Up · Fase 13 · Tienda pública: categoría de producto
--
-- El diseño de la tienda (Ropa, Mats, Accesorios, Digital) filtra por categoría, igual que la
-- videoteca. Texto libre y opcional, mismo criterio que `classes.category`. Se agrega acá y no en
-- la migración de la Fase 12 porque esa ya está aplicada: las migraciones nunca se reescriben.
-- =============================================================================

alter table public.products
  add column category text check (category is null or char_length(category) <= 60);

grant insert (category) on public.products to authenticated;
grant update (category) on public.products to authenticated;
