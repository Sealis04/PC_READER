#!/bin/sh
# Makes the password stored in an existing Postgres data volume match POSTGRES_PASSWORD from the
# env file. Postgres applies that value only when it creates a new volume, so a re-written env file
# (setup "Replace", new random password) otherwise ends in "password authentication failed".
#
# setup.bat / setup.sh run it on every setup, inside the running db container, fed on stdin:
#   docker compose ... exec -T db sh < scripts/reset-db-password.sh
# Local socket connections in the postgres image need no password, so the old one is not needed.
# The data is kept. The password never appears on a command line.
set -eu

: "${POSTGRES_USER:?}" "${POSTGRES_PASSWORD:?}" "${POSTGRES_DB:?}"

psql -v ON_ERROR_STOP=1 -q -v pw="$POSTGRES_PASSWORD" -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'SQL'
ALTER ROLE CURRENT_USER PASSWORD :'pw';
SQL
echo "Database password now matches the env file."
