-- Asignar un rol a una cuenta. Ejecutar en Supabase > SQL Editor, DESPUÉS de que la persona se registre en la web.
-- Roles: 'user' (usuario final) · 'admin' (gestiona clases y productos, NO sube videos) · 'developer' (todo lo del admin + sube videos,
--        cambia roles y ve el historial interno).
--
-- La PRIMERA cuenta de desarrollador se crea así (a mano, una sola vez). A partir de ahí, los desarrolladores
-- cambian roles con:  select public.set_user_role('<id del usuario>', 'admin');   (queda auditado).
-- No se puede quitar el rol al último desarrollador.
update public.profiles
set    role = 'developer'          -- ← cambiar por 'admin' o 'user' según corresponda
where  id = (select id from auth.users where email = 'REEMPLAZAR@correo.com');
