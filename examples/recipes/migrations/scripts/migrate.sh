#!/bin/sh
# Stand-in migration tool: applies each migrations/*.sql file once, in name
# order, and records it in schema_migrations. Use your real tool instead
# (Prisma, Drizzle, Alembic, Rails, Flyway...). Connection settings come from
# the PG* variables Hack injects.
set -eu
psql -v ON_ERROR_STOP=1 -q -c \
  "create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())"
for file in /migrations/*.sql; do
  version=$(basename "$file" .sql)
  if [ -n "$(psql -tAc "select 1 from schema_migrations where version = '$version'")" ]; then
    continue
  fi
  echo "applying $version"
  psql -v ON_ERROR_STOP=1 -q -1 -f "$file" \
    -c "insert into schema_migrations (version) values ('$version')"
done
echo "migrations up to date"
