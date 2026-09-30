-- Pruebas de la migración 20260930120000 (limpieza de clases con GUID de Bunny). Los datos los
-- sembró legacy_bunny.sql antes de aplicarla.

do $$ begin
  -- Las clases con key de Bunny quedan despublicadas, sin key y listas para resubir el video.
  assert (select is_published = false and video_status = 'pending' and r2_object_key is null
            from public.classes where id = '00000000-0000-4000-8000-00000000b001'),
    'una clase publicada con GUID de Bunny debe quedar despublicada, pending y sin key';
  assert (select is_published = false and video_status = 'pending' and r2_object_key is null
            from public.classes where id = '00000000-0000-4000-8000-00000000b002'),
    'una clase en "processing" con GUID de Bunny debe quedar pending y sin key';

  -- Se conservan los metadatos.
  assert (select title from public.classes where id = '00000000-0000-4000-8000-00000000b001') = 'legacy publicada',
    'el título no debe cambiar';

  -- La despublicación quedó auditada por el trigger existente.
  assert exists (select 1 from public.audit_log
                  where action = 'class.unpublish' and entity_id = '00000000-0000-4000-8000-00000000b001'),
    'la despublicación de una clase legacy debe quedar en el historial de auditoría';

  -- Una clase que ya estaba en R2 NO se toca.
  assert (select is_published and video_status = 'ready'
                 and r2_object_key = 'classes/00000000-0000-4000-8000-00000000b003/aaaa.mp4'
            from public.classes where id = '00000000-0000-4000-8000-00000000b003'),
    'una clase con key real de R2 debe quedar intacta';

  -- Una clase sin video tampoco.
  assert (select video_status = 'pending' and r2_object_key is null and not is_published
            from public.classes where id = '00000000-0000-4000-8000-00000000b004'),
    'una clase sin video debe quedar como estaba';
end $$;

-- Idempotencia: volver a correr el UPDATE de la migración no cambia nada.
do $$ declare n int; begin
  with r as (
    update public.classes set is_published = false, video_status = 'pending', r2_object_key = null
     where r2_object_key is not null and r2_object_key !~ '^classes/' returning 1)
  select count(*) into n from r;
  assert n = 0, 'la limpieza debe ser idempotente';
end $$;
