-- Invariantes de seguridad de TODO el esquema public. No prueban una función concreta: fallan si una migración futura
-- deja algo abierto por descuido (tabla sin RLS, función expuesta, permiso de escritura a anon...).

-- 1. Toda tabla de public tiene RLS activada.
do $$ declare bad text; begin
  select string_agg(c.relname, ', ') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;
  assert bad is null, format('tablas SIN RLS: %s', bad);
end $$;

-- 2. Toda tabla con RLS tiene al menos una política, salvo las que SOLO usa el backend (service_role) y están pensadas así.
do $$ declare bad text; begin
  select string_agg(c.relname, ', ') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
    and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)
    and c.relname not in ('rate_limits');           -- solo service_role: sin política = nadie más entra
  assert bad is null, format('tablas con RLS pero SIN políticas (nadie las podría leer): %s', bad);
end $$;

-- 3. rate_limits no se toca desde la API: ni anon ni authenticated tienen ningún privilegio.
do $$ begin
  assert not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'rate_limits' and grantee in ('anon', 'authenticated')
  ), 'rate_limits no debe tener privilegios para anon/authenticated';
end $$;

-- 4. anon (sin sesión) NUNCA escribe: ni privilegios de INSERT/UPDATE/DELETE/TRUNCATE sobre tablas ni sobre columnas.
do $$ declare bad text; begin
  select string_agg(distinct table_name || ':' || privilege_type, ', ') into bad
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee = 'anon' and privilege_type <> 'SELECT';
  assert bad is null, format('anon con privilegios de escritura en tablas: %s', bad);
  select string_agg(distinct table_name || '.' || column_name, ', ') into bad
  from information_schema.column_privileges
  where table_schema = 'public' and grantee = 'anon' and privilege_type in ('INSERT', 'UPDATE');
  assert bad is null, format('anon con privilegios de escritura en columnas: %s', bad);
end $$;

-- 5. Ni anon ni authenticated pueden borrar todo ni cambiar la estructura: sin TRUNCATE/REFERENCES/TRIGGER.
do $$ declare bad text; begin
  select string_agg(distinct table_name || ':' || privilege_type, ', ') into bad
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon', 'authenticated') and privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER');
  assert bad is null, format('privilegios peligrosos: %s', bad);
end $$;

-- 6. Funciones SECURITY DEFINER: siempre con search_path fijo (si no, se pueden secuestrar con un esquema propio).
do $$ declare bad text; begin
  select string_agg(p.proname, ', ') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
  assert bad is null, format('SECURITY DEFINER sin search_path fijo: %s', bad);
end $$;

-- 7. Las funciones de trigger no están expuestas en la API (/rpc).
do $$ declare bad text; begin
  select string_agg(p.proname, ', ') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prorettype = 'pg_catalog.trigger'::regtype
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
  assert bad is null, format('funciones de trigger ejecutables por anon/authenticated: %s', bad);
end $$;

-- 8. Lo único que anon puede EJECUTAR es una lista corta y revisada (la agenda pública y un validador sin efectos).
do $$ declare bad text; begin
  select string_agg(p.proname, ', ') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'execute')
    and p.proname not in ('live_agenda', 'teacher_specialties_ok');
  assert bad is null, format('funciones nuevas ejecutables sin sesión (revisar a mano y, si es intencional, agregarlas a esta lista): %s', bad);
end $$;

-- 9. Las funciones que escriben dinero/auditoría (payments_*, audit_write) solo las ejecuta el backend (service_role).
do $$ declare bad text; begin
  select string_agg(p.proname, ', ') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and (p.proname like 'payments\_%' or p.proname = 'audit_write')
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
  assert bad is null, format('funciones de pagos/auditoría ejecutables desde el navegador: %s', bad);
end $$;

-- 10. El historial de auditoría y los eventos de pago no los escribe nadie desde la API.
do $$ begin
  assert not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name in ('audit_log', 'payment_events', 'orders', 'order_items', 'subscriptions', 'entitlements')
      and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT'
  ), 'las tablas de dinero y auditoría son de solo lectura para el navegador';
end $$;
