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
echo "OK · pruebas de base de datos"
