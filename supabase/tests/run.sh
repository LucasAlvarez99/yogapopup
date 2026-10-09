#!/usr/bin/env bash
# Pruebas de base de datos: crea una base temporal, aplica el esquema simulado de Supabase y TODAS las migraciones
# en orden, y ejecuta las pruebas. Requiere PostgreSQL (psql, createdb, dropdb) y las variables PG* habituales.
#   PGHOST=localhost PGUSER=postgres PGPASSWORD=... npm run test:db
set -euo pipefail
cd "$(dirname "$0")/.."
DB="yp_test_$$"
createdb "$DB"
trap 'dropdb --if-exists "$DB" >/dev/null 2>&1 || true' EXIT
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -d "$DB")

"${PSQL[@]}" -f tests/shim.sql
for f in migrations/*.sql; do
  # Antes de la migración de roles se siembra un "admin" del esquema antiguo para probar la conversión a owner.
  if [[ "$f" == *roles_and_audit* ]]; then "${PSQL[@]}" -f tests/legacy_admin.sql; fi
  "${PSQL[@]}" -f "$f"
  echo "  migración aplicada: $(basename "$f")"
done
"${PSQL[@]}" -f tests/roles_and_audit.test.sql
"${PSQL[@]}" -f tests/classes_publish_audit.test.sql
"${PSQL[@]}" -f tests/products.test.sql
"${PSQL[@]}" -f tests/hardening.test.sql
"${PSQL[@]}" -f tests/roles_admin_developer.test.sql
"${PSQL[@]}" -f tests/privacy_consent.test.sql
"${PSQL[@]}" -f tests/product_sizes.test.sql
"${PSQL[@]}" -f tests/profesores_agenda.test.sql
"${PSQL[@]}" -f tests/payments.test.sql

# Limpieza de clases con GUID de Bunny (migración 20260930120000): necesita datos "de antes" sembrados
# ANTES de aplicarla, y otras pruebas cuentan filas de classes, así que va en una base temporal aparte.
DB2="yp_legacy_$$"
createdb "$DB2"
trap 'dropdb --if-exists "$DB" >/dev/null 2>&1 || true; dropdb --if-exists "$DB2" >/dev/null 2>&1 || true' EXIT
PSQL2=(psql -X -q -v ON_ERROR_STOP=1 -d "$DB2")
"${PSQL2[@]}" -f tests/shim.sql
for f in migrations/*.sql; do
  if [[ "$f" == *roles_and_audit* ]]; then "${PSQL2[@]}" -f tests/legacy_admin.sql; fi
  if [[ "$f" == *reset_legacy_bunny_videos* ]]; then "${PSQL2[@]}" -f tests/legacy_bunny.sql; fi
  "${PSQL2[@]}" -f "$f"
  if [[ "$f" == *reset_legacy_bunny_videos* ]]; then break; fi
done
"${PSQL2[@]}" -f tests/legacy_bunny.test.sql
echo "OK · pruebas de base de datos"
