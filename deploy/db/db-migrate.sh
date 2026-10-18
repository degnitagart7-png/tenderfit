#!/usr/bin/env bash
#
# Применить supabase/migrations по порядку к новой базе.
#
#   DATABASE_URL='postgres://USER:PASSWORD@HOST:5432/DB?sslmode=require' bash deploy/db/db-migrate.sh [--dry-run]
#
# Миграции написаны для Supabase: роли anon/authenticated/service_role и схемы auth/storage там есть
# «из коробки». В чистой PostgreSQL их нет, поэтому перед миграциями создаются заглушки тех ролей,
# на которые миграции ссылаются в GRANT/ALTER POLICY, если прав на CREATE ROLE хватает;
# не хватает — такие строки упадут, и это видно в выводе (их можно пропустить: RLS-политик в базе 0).
#
set -euo pipefail
: "${DATABASE_URL:?укажите DATABASE_URL}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DRY="${1:-}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "create extension if not exists pgcrypto; create extension if not exists \"uuid-ossp\";"
for role in anon authenticated service_role; do
  psql "$DATABASE_URL" -q -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname = '$role') then create role $role nologin; end if; exception when insufficient_privilege then raise notice 'нет прав создать роль $role'; end \$\$;" || true
done

for file in "$REPO"/supabase/migrations/*.sql; do
  name="$(basename "$file")"
  if [ "$DRY" = "--dry-run" ]; then echo "будет применена: $name"; continue; fi
  echo "→ $name"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$file"
done
echo "Готово."
