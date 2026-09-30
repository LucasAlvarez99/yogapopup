-- Pruebas de la Fase 5 (parte 1): publicar/despublicar desde el cliente y su auditoría.
-- Requiere el esquema de tests/roles_and_audit.test.sql ya aplicado en la misma base (usa el mismo helper t.raises).

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000000c1', 'owner2@test.dev', '{}');
update public.profiles set role = 'owner' where id = '00000000-0000-4000-8000-0000000000c1';

-- 1. Una clase sin video listo no se puede publicar (constraint ya vigente), y sin video
--    "publicar" ni siquiera es una opción real: se prueba igual para no depender de eso.
do $$ declare cid uuid; begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000c1', true);
  set local role authenticated;
  insert into public.classes (title) values ('clase sin video listo') returning id into cid;
  perform t.raises(format($q$ update public.classes set is_published = true where id = %L $q$, cid), '23514');
  reset role;
end $$;

-- 2. Publicar y despublicar una clase con video listo (solo el backend puede dejar video_status
--    en 'ready', así que se fuerza aquí como si ya hubiera pasado por R2).
do $$ declare cid uuid; begin
  insert into public.classes (title, video_status) values ('clase lista', 'ready') returning id into cid;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000c1', true);
  set local role authenticated;
  update public.classes set is_published = true where id = cid;
  reset role;
  assert exists (
    select 1 from public.audit_log
    where action = 'class.publish' and entity_type = 'class' and entity_id = cid::text
      and actor_id = '00000000-0000-4000-8000-0000000000c1' and actor_role = 'owner'
      and details = jsonb_build_object('title', 'clase lista')
  ), 'publicar debe quedar auditado con su actor';

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000c1', true);
  set local role authenticated;
  update public.classes set is_published = false where id = cid;
  reset role;
  assert exists (
    select 1 from public.audit_log
    where action = 'class.unpublish' and entity_type = 'class' and entity_id = cid::text
  ), 'despublicar debe quedar auditado';
end $$;

-- 3. Editar otro campo (sin tocar is_published) no genera entrada de auditoría de publicación.
do $$ declare cid uuid; n int; begin
  insert into public.classes (title, video_status) values ('otra clase', 'ready') returning id into cid;
  select count(*) into n from public.audit_log where entity_type = 'class' and entity_id = cid::text;
  update public.classes set title = 'otra clase (editada)' where id = cid;
  assert (select count(*) from public.audit_log where entity_type = 'class' and entity_id = cid::text) = n,
    'editar título sin tocar is_published no debe auditar publicación';
end $$;

-- 4. Un usuario común no puede publicar ni despublicar: la fila no le es visible para UPDATE
--    (política USING de classes_update_admin), así que el UPDATE no toca ninguna fila -
--    no lanza excepción, pero tampoco cambia nada ni queda auditado.
do $$ declare cid uuid; begin
  insert into public.classes (title, video_status) values ('clase de otro', 'ready') returning id into cid;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', true);
  set local role authenticated;
  update public.classes set is_published = true where id = cid;
  reset role;
  assert (select is_published from public.classes where id = cid) = false,
    'un usuario común no puede publicar: la fila no le es visible para escritura';
  assert not exists (
    select 1 from public.audit_log where entity_type = 'class' and entity_id = cid::text and action = 'class.publish'
  ), 'tampoco debe quedar auditado un cambio que no ocurrió';
end $$;
