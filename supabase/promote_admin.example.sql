-- Ejecutar UNA vez en Supabase > SQL Editor, después de que la persona
-- administradora se haya registrado desde la web. NO es una migración.
update public.profiles
set    role = 'admin'
where  id = (select id from auth.users where email = 'REEMPLAZAR@correo.com');
