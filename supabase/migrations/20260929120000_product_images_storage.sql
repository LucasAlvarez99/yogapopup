-- =============================================================================
-- YogaPop Up · Fase 14 · Tienda: imágenes de producto (Supabase Storage)
--
-- Mismo criterio que `class-thumbnails` (20260920120000): bucket PÚBLICO de solo lectura, porque la
-- tienda muestra las fotos sin sesión; escribir, reemplazar o borrar: solo propietario/desarrollador
-- (`is_owner()`, el mismo permiso que ya rige sobre la tabla `products`).
-- Tope de 2 MB y tipos de imagen permitidos, para cuidar el 1 GB del plan gratuito.
-- (`resizeImage` ya reduce y convierte a WebP en el navegador antes de subir.)
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images',
  'product-images',
  true,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy product_images_owner_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'product-images' and public.is_owner());

create policy product_images_owner_update on storage.objects
  for update to authenticated
  using (bucket_id = 'product-images' and public.is_owner())
  with check (bucket_id = 'product-images' and public.is_owner());

create policy product_images_owner_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'product-images' and public.is_owner());

-- Lectura: al ser un bucket público, las URL públicas funcionan sin política. Se permite además
-- listar/leer vía API solo al propietario (necesario para reemplazar con "upsert").
create policy product_images_owner_select on storage.objects
  for select to authenticated
  using (bucket_id = 'product-images' and public.is_owner());
