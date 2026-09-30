-- Asignar un rol a una cuenta. Ejecutar en Supabase > SQL Editor, DESPUÉS de que la persona se registre en la web.
-- Roles: 'user' (usuario final) · 'owner' (propietario: panel de negocio) · 'developer' (desarrollador: panel técnico + negocio).
--
-- La PRIMERA cuenta de desarrollador se crea así (a mano, una sola vez). A partir de ahí, los desarrolladores
-- cambian roles con:  select public.set_user_role('<id del usuario>', 'owner');   (queda auditado).
-- No se puede quitar el rol al último desarrollador.
update public.profiles
set    role = 'developer'          -- ← cambiar por 'owner' o 'user' según corresponda
where  id = (select id from auth.users where email = 'REEMPLAZAR@correo.com');
