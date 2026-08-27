#!/usr/bin/env bash
# Install the isolated TrustMe primary host. Run locally as root.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ops/lib.sh
source "$SCRIPT_DIR/lib.sh"

require_root
mkdir -p /etc/trustme
if [[ ! -e /etc/trustme/trustme.env ]]; then
  install -o root -g root -m 0640 "$SCRIPT_DIR/env/trustme.env.example" \
    /etc/trustme/trustme.env
fi
load_trustme_env
TRUSTME_PG_VERSION="${TRUSTME_PG_VERSION:-}"
TRUSTME_PG_PORT="${TRUSTME_PG_PORT:-}"
TRUSTME_REDIS_PORT="${TRUSTME_REDIS_PORT:-}"
API_PORT="${API_PORT:-}"
TRUSTME_ADMIN_PORT="${TRUSTME_ADMIN_PORT:-}"
TRUSTME_PG_DATABASE="${TRUSTME_PG_DATABASE:-trustme}"
TRUSTME_PG_ROLE="${TRUSTME_PG_ROLE:-trustme}"
TRUSTME_PG_PASSWORD="${TRUSTME_PG_PASSWORD:-}"
require_value TRUSTME_PG_VERSION
require_value TRUSTME_PG_PASSWORD
require_value TRUSTME_REDIS_PASSWORD
require_value TRUSTME_API_HOST
require_value TRUSTME_ADMIN_HOST
[[ "$TRUSTME_PG_PORT" == "$TRUSTME_EXPECTED_PG_PORT" ]] || { printf 'TRUSTME_PG_PORT must be %s\n' "$TRUSTME_EXPECTED_PG_PORT" >&2; exit 1; }
[[ "$TRUSTME_REDIS_PORT" == "$TRUSTME_EXPECTED_REDIS_PORT" ]] || { printf 'TRUSTME_REDIS_PORT must be %s\n' "$TRUSTME_EXPECTED_REDIS_PORT" >&2; exit 1; }
[[ "$API_PORT" == "$TRUSTME_EXPECTED_API_PORT" ]] || { printf 'API_PORT must be %s\n' "$TRUSTME_EXPECTED_API_PORT" >&2; exit 1; }
[[ "$TRUSTME_ADMIN_PORT" == "$TRUSTME_EXPECTED_ADMIN_PORT" ]] || { printf 'TRUSTME_ADMIN_PORT must be %s\n' "$TRUSTME_EXPECTED_ADMIN_PORT" >&2; exit 1; }
valid_identifier "$TRUSTME_PG_DATABASE" || { printf 'invalid database name\n' >&2; exit 1; }
valid_identifier "$TRUSTME_PG_ROLE" || { printf 'invalid role name\n' >&2; exit 1; }
MARKER_PATH="${FAILOVER_MARKER_PATH:-/etc/trustme/FAILED_OVER}"
PGPASS_FILE="${TRUSTME_PGPASS_FILE:-/etc/trustme/pgpass}"

# Re-runs explicitly permit only the TrustMe-owned resources that this script
# creates. A fresh install still fails on any unrelated listener or resource.
"$SCRIPT_DIR/preflight.sh" --allow-existing

if ! getent passwd trustme >/dev/null; then
  useradd --system --home-dir /opt/trustme --shell /usr/sbin/nologin \
    --user-group trustme
else
  usermod --shell /usr/sbin/nologin trustme
fi
install -d -o trustme -g trustme -m 0750 /opt/trustme/releases /opt/trustme/shared
if [[ -d /opt/trustme/current && ! -L /opt/trustme/current ]]; then
  printf '/opt/trustme/current exists but is not a symlink\n' >&2
  exit 1
fi
chown root:trustme /etc/trustme
chmod 0751 /etc/trustme
chown root:trustme /etc/trustme/trustme.env
chmod 0640 /etc/trustme/trustme.env
install -d -o root -g trustme -m 0751 "$(dirname "$MARKER_PATH")"
install -d -m 0751 "$(dirname "$PGPASS_FILE")"
if [[ ! -e "$PGPASS_FILE" ]]; then
  install -o postgres -g postgres -m 0600 /dev/null "$PGPASS_FILE"
else
  chown postgres:postgres "$PGPASS_FILE"
  chmod 0600 "$PGPASS_FILE"
fi

install_trustme_ops

if ! pg_lsclusters --no-header | awk '$2 == "trustme" { found = 1 } END { exit !found }'; then
  pg_createcluster "$TRUSTME_PG_VERSION" trustme --port "$TRUSTME_PG_PORT" --start
fi
pg_conftool "$TRUSTME_PG_VERSION" trustme set listen_addresses "'127.0.0.1'"
pg_conftool "$TRUSTME_PG_VERSION" trustme set wal_level replica
pg_conftool "$TRUSTME_PG_VERSION" trustme set max_wal_senders 4
pg_conftool "$TRUSTME_PG_VERSION" trustme set max_replication_slots 2

if ! sudo -u postgres psql -p "$TRUSTME_PG_PORT" -d postgres -Atqc \
  "select 1 from pg_roles where rolname = '${TRUSTME_PG_ROLE}'" | grep -q 1; then
  escaped_password="${TRUSTME_PG_PASSWORD//\'/\'\'}"
  {
    printf "\\set trustme_password '%s'\n" "$escaped_password"
    printf 'create role "%s" login password :' "$TRUSTME_PG_ROLE"
    printf "'trustme_password';\n"
  } | sudo -u postgres psql -p "$TRUSTME_PG_PORT" -d postgres -v ON_ERROR_STOP=1
  unset escaped_password
else
  escaped_password="${TRUSTME_PG_PASSWORD//\'/\'\'}"
  {
    printf "\\set trustme_password '%s'\n" "$escaped_password"
    printf 'alter role "%s" password :' "$TRUSTME_PG_ROLE"
    printf "'trustme_password';\n"
  } | sudo -u postgres psql -p "$TRUSTME_PG_PORT" -d postgres -v ON_ERROR_STOP=1
  unset escaped_password
fi
if ! sudo -u postgres psql -p "$TRUSTME_PG_PORT" -d postgres -Atqc \
  "select 1 from pg_database where datname = '${TRUSTME_PG_DATABASE}'" | grep -q 1; then
  sudo -u postgres createdb -p "$TRUSTME_PG_PORT" -O "$TRUSTME_PG_ROLE" \
    "$TRUSTME_PG_DATABASE"
fi
PG_HBA="$(pg_conftool "$TRUSTME_PG_VERSION" trustme show hba_file |
  sed -n "s/^hba_file = '\\(.*\\)'$/\\1/p")"
[[ -n "$PG_HBA" && -f "$PG_HBA" ]] || {
  printf 'could not locate TrustMe pg_hba.conf\n' >&2
  exit 1
}
grep -Fqx "host replication ${TRUSTME_PG_ROLE} 127.0.0.1/32 scram-sha-256" "$PG_HBA" ||
  printf '%s\n' "host replication ${TRUSTME_PG_ROLE} 127.0.0.1/32 scram-sha-256" >> "$PG_HBA"
systemctl restart "$(pg_service_name)"

REDIS_DATA_DIR="${TRUSTME_REDIS_DATA_DIR:-/var/lib/trustme-redis}"
install -d -o trustme -g trustme -m 0700 "$REDIS_DATA_DIR"
umask 0077
{
  printf 'bind 127.0.0.1\nport %s\nprotected-mode yes\n' "$TRUSTME_REDIS_PORT"
  printf 'dir %s\nappendonly yes\nrequirepass %s\n' "$REDIS_DATA_DIR" "$TRUSTME_REDIS_PASSWORD"
} > /etc/trustme/redis.conf
chown trustme:trustme /etc/trustme/redis.conf
chmod 0640 /etc/trustme/redis.conf

install_trustme_units "$(pg_service_name)"
systemctl daemon-reload
systemctl enable trustme-redis.service trustme-api.service trustme-admin.service \
  trustme-worker.service
install_trustme_nginx_vhost

printf 'TrustMe primary installation complete. Fill /etc/trustme/trustme.env before deployment.\n'
