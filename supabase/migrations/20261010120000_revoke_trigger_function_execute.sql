-- =============================================================================
-- YogaPop Up · Las funciones de trigger no se llaman por la API
--
-- Supabase da EXECUTE a anon/authenticated sobre toda función nueva del esquema public. Una función de trigger no se puede
-- ejecutar a mano (Postgres lo impide), así que no era explotable, pero tampoco tiene por qué estar expuesta en la API REST
-- (/rpc/...). Esta migración quita ese permiso a TODAS las funciones de trigger de public (las de comentarios, Fases 26-27,
-- se habían quedado con él) y es idempotente: se puede volver a correr.
--
-- Los triggers siguen funcionando: Postgres no comprueba EXECUTE al dispararlos.
-- =============================================================================
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prorettype = 'pg_catalog.trigger'::regtype
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;
