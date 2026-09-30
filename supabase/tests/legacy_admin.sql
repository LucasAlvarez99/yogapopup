-- Datos "de antes" de la migración de roles: una persona que ya era 'admin' (rol antiguo) debe pasar a 'owner'.
insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000e1', 'legacy-admin@test.dev');
update public.profiles set role = 'admin' where id = '00000000-0000-4000-8000-0000000000e1';
