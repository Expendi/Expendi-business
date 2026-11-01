#!/usr/bin/env bash
# One-time local setup: roles plus dev and test databases. Run as a local
# Postgres superuser. Idempotent. Assumes localhost trust auth (Homebrew
# default); deployed databases get real passwords from Doppler instead.
set -euo pipefail

ADMIN_DB="${PGADMIN_DATABASE:-postgres}"

psql -v ON_ERROR_STOP=1 -d "$ADMIN_DB" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'expendi_business_owner') THEN
    CREATE ROLE expendi_business_owner LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'expendi_business_app') THEN
    CREATE ROLE expendi_business_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'expendi_business_api') THEN
    CREATE ROLE expendi_business_api LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB
      IN ROLE expendi_business_app;
  END IF;
END
$$;
SQL

for db in expendi_business expendi_business_test; do
  if ! psql -d "$ADMIN_DB" -Atc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1; then
    createdb -O expendi_business_owner "$db"
    echo "created database $db"
  fi
done

echo "Local roles and databases are ready."
