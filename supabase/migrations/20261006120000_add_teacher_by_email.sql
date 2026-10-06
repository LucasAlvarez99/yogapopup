-- =============================================================================
-- Alta de profesores SIN pisar el rol que ya tienen (corrige un descuido de 20261005120000).
--
-- Problema: set_user_role_by_email(correo, 'profesor') cambia el ROL a 'profesor'. Para alguien que ya es admin (Manu,
-- que además da clases) eso le QUITA la gestión. Ser profesor es una fila en `teachers`; el rol es otra cosa.
--
-- add_teacher_by_email(correo, también_admin) — solo developer, auditado:
--   · SIEMPRE da de alta (o reactiva) el perfil de profesor.
--   · Nunca baja de rango: un admin o developer conserva su rol.
--   · también_admin = false: un 'user' pasa a 'profesor'; cualquier otro rol queda igual.
--   · también_admin = true : un 'user' o 'profesor' pasa a 'admin' (profesor Y gestión); admin/developer quedan igual.
-- =============================================================================
create or replace function public.add_teacher_by_email(p_email text, p_also_admin boolean default false)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid;
  cur    text;
  want   text;
begin
  if auth.uid() is null or not public.is_developer() then
    raise exception 'developer role required' using errcode = '42501';
  end if;
  select u.id, p.role into target, cur
  from auth.users u join public.profiles p on p.id = u.id
  where lower(u.email) = lower(btrim(p_email))
  limit 1;
  if target is null then
    raise exception 'user not found' using errcode = 'P0002';
  end if;

  want := case
    when cur in ('admin', 'developer') then cur                       -- nunca se baja de rango
    when p_also_admin then 'admin'
    when cur = 'user' then 'profesor'
    else cur
  end;
  if want <> cur then
    perform public.set_user_role(target, want);                       -- auditado por el trigger de roles
  end if;
  perform public.set_teacher_active(target, true);                    -- crea o reactiva el perfil; auditado
  return want;
end;
$$;

revoke execute on function public.add_teacher_by_email(text, boolean) from public, anon;
grant execute on function public.add_teacher_by_email(text, boolean) to authenticated;
