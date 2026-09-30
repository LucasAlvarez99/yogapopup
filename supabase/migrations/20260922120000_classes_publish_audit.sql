-- =============================================================================
-- YogaPop Up · Fase 5 (panel de negocio, parte 1) · Auditoría de publicar/despublicar
--
-- Publicar y despublicar ya son posibles desde el cliente (RLS + privilegio por columna
-- sobre is_published, ya vigentes). Lo único que faltaba era que la acción quedara
-- registrada, sea cual sea el canal (panel, edición directa, SQL). Mismo patrón que
-- profiles_audit_role_change: un trigger que audita, no una Edge Function nueva.
-- =============================================================================

create or replace function public.classes_audit_publish_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.is_published is distinct from new.is_published then
    insert into public.audit_log (actor_id, actor_role, action, entity_type, entity_id, details)
    values (
      auth.uid(),
      (select p.role from public.profiles p where p.id = auth.uid()),
      case when new.is_published then 'class.publish' else 'class.unpublish' end,
      'class', new.id::text,
      jsonb_build_object('title', new.title)
    );
  end if;
  return new;
end;
$$;

create trigger classes_audit_publish_change
  after update of is_published on public.classes
  for each row execute function public.classes_audit_publish_change();

revoke execute on function public.classes_audit_publish_change() from public, anon, authenticated;
