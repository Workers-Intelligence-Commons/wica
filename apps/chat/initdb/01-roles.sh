#!/bin/sh
# Premier démarrage de Postgres (répertoire de données vide) : la base `chat` et ses deux rôles.
# `chat_app` est l'application ; `electric` lit le journal de réplication et ne fait que lire.
# La base `auth` n'existe que dans le déploiement de référence, avec un service d'auth séparé.
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
