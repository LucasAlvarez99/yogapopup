-- =============================================================================
-- YogaPop Up · Limpia las clases que quedaron apuntando a un video de Bunny Stream
--
-- La migración 20260924120000 solo renombró bunny_video_id -> r2_object_key: si la base ya
-- tenía clases cargadas con Bunny, esas filas conservan un GUID de Bunny en r2_object_key,
-- que no existe en R2 (las keys de R2 siempre son "classes/<id_de_clase>/<uuid>.mp4").
-- Esas clases no podrían reproducirse, y si estaban publicadas el catálogo las mostraría rotas.
--
-- Qué hace: a toda clase cuya key NO tenga forma de key de R2 la despublica y la deja lista
-- para volver a subir el video desde el panel (modo "reintentar"): sin key, en 'pending'.
-- El título, la descripción, la miniatura, la duración y el resto de los metadatos se conservan.
--
-- Es idempotente (una segunda ejecución no encuentra nada) y no toca las claves reales de R2.
-- Si la base estaba vacía o ya usaba R2, no hace nada.
--
-- Un único UPDATE: is_published pasa a false en la misma sentencia que video_status, así que
-- nunca se viola classes_published_requires_ready, y el trigger existente audita la
-- despublicación ('class.unpublish').
-- =============================================================================

update public.classes
   set is_published = false,
       video_status = 'pending',
       r2_object_key = null
 where r2_object_key is not null
   and r2_object_key !~ '^classes/';
