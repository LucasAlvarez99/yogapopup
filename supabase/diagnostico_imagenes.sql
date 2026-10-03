-- =============================================================================
-- Diagnóstico: "un admin no puede subir imágenes" (productos o miniaturas)
-- Supabase → SQL Editor. Es de SOLO LECTURA: no cambia nada. Reemplaza el correo del paso 4.
-- =============================================================================

-- 1) Los buckets existen, y con qué tope/tipos. Esperado: 2 filas, público, 2097152 bytes, jpeg/png/webp.
select id, public, file_size_limit, allowed_mime_types
from storage.buckets
where id in ('product-images', 'class-thumbnails');

-- 2) Las políticas de escritura de Storage. Esperado: 4 por bucket (insert, update, delete, select) y que su condición
--    llame a is_staff() o a su alias is_admin() (las dos valen para admin Y developer). Si dicen is_owner() o
--    is_developer(), o faltan políticas, esa es la causa: la base no está al día con las migraciones (sb:db-push).
select policyname, cmd, qual, with_check
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
  and (policyname like 'product_images%' or policyname like 'class_thumbnails%')
order by policyname;

-- 3) Qué funciones de rol existen. Esperado: is_admin, is_developer, is_staff (y NO is_owner).
select p.proname
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('is_owner', 'is_staff', 'is_admin', 'is_developer')
order by 1;

-- 4) ¿Esta persona pasaría esas políticas? Esperado: puede_subir_imagenes = true para un admin o developer.
--    (Cambia el correo. Se ejecuta dentro de una transacción que se deshace: no deja nada.)
begin;
  select set_config('request.jwt.claim.sub', (select id::text from auth.users where email = 'CORREO-DEL-ADMIN@ejemplo.com'), true);
  set local role authenticated;
  select auth.uid() as usuario, public.is_staff() as puede_subir_imagenes;
rollback;

-- 5) El rol que tiene guardado. Esperado: 'admin' (o 'developer').
select u.email, p.role
from public.profiles p join auth.users u on u.id = p.id
order by p.role, u.email;
