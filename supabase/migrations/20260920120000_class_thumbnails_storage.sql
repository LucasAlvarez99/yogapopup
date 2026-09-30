-- =============================================================================
-- YogaPop Up · Miniaturas de las clases (Supabase Storage)
--
-- Bucket PÚBLICO de solo lectura: las miniaturas no son sensibles y la home las muestra
-- sin sesión. (No se usan las miniaturas de Bunny porque el Pull Zone exige token.)
-- Escribir, reemplazar o borrar: solo administradores.
-- Se limita el tamaño (2 MB) y el tipo de archivo para cuidar el 1 GB del plan gratuito.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'class-thumbnails',
  'class-thumbnails',
  true,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy class_thumbnails_admin_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'class-thumbnails' and public.is_admin());

create policy class_thumbnails_admin_update on storage.objects
  for update to authenticated
  using (bucket_id = 'class-thumbnails' and public.is_admin())
  with check (bucket_id = 'class-thumbnails' and public.is_admin());

create policy class_thumbnails_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'class-thumbnails' and public.is_admin());

-- Lectura: al ser un bucket público, las URL públicas funcionan sin política. Se permite además
-- listar/leer vía API solo a administradores (necesario para reemplazar con "upsert").
create policy class_thumbnails_admin_select on storage.objects
  for select to authenticated
  using (bucket_id = 'class-thumbnails' and public.is_admin());
