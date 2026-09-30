-- Datos "de antes" para probar la migración 20260930120000: se siembran ANTES de aplicarla
-- (mismo patrón que legacy_admin.sql). Las filas reflejan lo que dejaba la migración a R2
-- sobre una base que ya tenía clases de Bunny.
insert into public.classes (id, title, r2_object_key, video_status, is_published) values
  ('00000000-0000-4000-8000-00000000b001', 'legacy publicada',  '3f2b8c1e-9d4a-4c55-8a1b-0123456789ab', 'ready',      true),
  ('00000000-0000-4000-8000-00000000b002', 'legacy en proceso', '9a8b7c6d-1111-4222-8333-444455556666', 'processing', false),
  ('00000000-0000-4000-8000-00000000b003', 'ya en R2',          'classes/00000000-0000-4000-8000-00000000b003/aaaa.mp4', 'ready', true),
  ('00000000-0000-4000-8000-00000000b004', 'sin video todavía', null, 'pending', false);
