#!/bin/sh
# First Postgres start (empty data directory): the `chat` database and its two roles.
# `chat_app` is the application; `electric` reads the replication journal and only reads.
# The `auth` database exists only in the reference deployment, with a separate auth service.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v chat_password="$CHAT_DB_PASSWORD" -v electric_password="$ELECTRIC_DB_PASSWORD" <<'SQL'
CREATE ROLE chat_app LOGIN PASSWORD :'chat_password';
CREATE ROLE electric LOGIN REPLICATION PASSWORD :'electric_password';
CREATE DATABASE chat OWNER chat_app;
SQL

if [ -n "${AUTH_DB_PASSWORD:-}" ]; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -v auth_password="$AUTH_DB_PASSWORD" <<'SQL'
CREATE ROLE auth_app LOGIN PASSWORD :'auth_password';
CREATE DATABASE auth OWNER auth_app;
SQL
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname chat \
  -f /docker-entrypoint-initdb.d/schema.sql.in
