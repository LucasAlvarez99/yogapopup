-- =============================================================================
-- YogaPop Up · Migra el almacenamiento de video de Bunny Stream a Cloudflare R2
--
-- R2 es un bucket, no transcodifica: una sola key por clase alcanza (no hace falta
-- un "library id" como en Bunny). bunny_video_id / bunny_library_id se reemplazan
-- por una única columna r2_object_key. Ningún privilegio cambia: la key, igual que
-- antes bunny_video_id, solo la lee/escribe el backend (service_role); no está en
-- el grant de columnas públicas de la migración inicial.
-- =============================================================================

drop index if exists public.classes_bunny_video_id_key;

alter table public.classes
  rename column bunny_video_id to r2_object_key;

alter table public.classes
  drop column bunny_library_id;

create unique index classes_r2_object_key_key
  on public.classes (r2_object_key) where r2_object_key is not null;
