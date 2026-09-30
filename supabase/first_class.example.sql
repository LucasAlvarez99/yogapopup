-- PRIMERA CLASE, SIN PANEL (hasta que exista el panel de negocio).
-- Pasos previos, a mano:
--   1. Sube el video al bucket de R2 (con rclone, el dashboard de Cloudflare, o el AWS CLI
--      apuntando al endpoint de R2) con una key del tipo "classes/<uuid>/archivo.mp4".
--   2. Anota esa key y la duración del video en segundos.
-- Luego ejecuta esto en Supabase > SQL Editor (ahí sí se puede escribir la key de R2).
insert into public.classes (
  title, description, level, category, access_level, sort_order,
  r2_object_key, video_status, duration_seconds, is_published
) values (
  'Yoga para principiantes',                        -- título
  'Una práctica suave para empezar.',               -- descripción
  'principiante',                                   -- principiante | intermedio | avanzado | todos
  'Vinyasa',                                        -- categoría
  'free',                                           -- free (cualquier usuario registrado) | restricted (requiere permiso)
  0,                                                -- orden en la videoteca
  'classes/REEMPLAZAR-UUID/REEMPLAZAR-ARCHIVO.mp4', -- key del objeto en R2
  'ready',                                          -- el video ya está subido
  2700,                                             -- duración en segundos (45 min)
  true                                              -- publicada
);
-- Miniatura: súbela al bucket "class-thumbnails" (Storage) y guarda su URL pública:
--   update public.classes set thumbnail_url = 'https://<proyecto>.supabase.co/storage/v1/object/public/class-thumbnails/<archivo>.webp'
--   where title = 'Yoga para principiantes';
