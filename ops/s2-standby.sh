#!/usr/bin/env bash
# Configure Server 2 as the isolated TrustMe warm standby. Run locally as root.
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
TRUSTME_PRIMARY_HOST="${TRUSTME_PRIMARY_HOST:-}"
TRUSTME_SSH_USER="${TRUSTME_SSH_USER:-}"
TRUSTME_SSH_KEY="${TRUSTME_SSH_KEY:-}"
TRUSTME_REPLICATION_ROLE="${TRUSTME_REPLICATION_ROLE:-}"
TRUSTME_REPLICATION_PASSWORD="${TRUSTME_REPLICATION_PASSWORD:-}"
TRUSTME_REPLICATION_SLOT="${TRUSTME_REPLICATION_SLOT:-}"
TRUSTME_PG_PORT="${TRUSTME_PG_PORT:-}"
TRUSTME_REDIS_PORT="${TRUSTME_REDIS_PORT:-}"
TRUSTME_API_PORT="${TRUSTME_API_PORT:-}"
TRUSTME_ADMIN_PORT="${TRUSTME_ADMIN_PORT:-}"
for variable in TRUSTME_PRIMARY_HOST TRUSTME_SSH_USER TRUSTME_SSH_KEY \
  TRUSTME_REPLICATION_ROLE TRUSTME_REPLICATION_PASSWORD TRUSTME_REPLICATION_SLOT \
  TRUSTME_PG_VERSION; do
  require_value "$variable"
done
require_value TRUSTME_REDIS_PASSWORD
[[ "$TRUSTME_PG_PORT" == "$TRUSTME_EXPECTED_PG_PORT" ]] || { printf 'TRUSTME_PG_PORT must be %s\n' "$TRUSTME_EXPECTED_PG_PORT" >&2; exit 1; }
[[ "$TRUSTME_REDIS_PORT" == "$TRUSTME_EXPECTED_REDIS_PORT" ]] || { printf 'TRUSTME_REDIS_PORT must be %s\n' "$TRUSTME_EXPECTED_REDIS_PORT" >&2; exit 1; }
[[ "$TRUSTME_API_PORT" == "$TRUSTME_EXPECTED_API_PORT" ]] || { printf 'TRUSTME_API_PORT must be %s\n' "$TRUSTME_EXPECTED_API_PORT" >&2; exit 1; }
[[ "$TRUSTME_ADMIN_PORT" == "$TRUSTME_EXPECTED_ADMIN_PORT" ]] || { printf 'TRUSTME_ADMIN_PORT must be %s\n' "$TRUSTME_EXPECTED_ADMIN_PORT" >&2; exit 1; }
valid_identifier "$TRUSTME_REPLICATION_ROLE" ||
  { printf 'invalid replication role name\n' >&2; exit 1; }
valid_identifier "$TRUSTME_REPLICATION_SLOT" ||
  { printf 'invalid replication slot name\n' >&2; exit 1; }
MARKER_PATH="${FAILOVER_MARKER_PATH:-/etc/trustme/FAILED_OVER}"
PGPASS_FILE="${TRUSTME_PGPASS_FILE:-/etc/trustme/pgpass}"

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

install_trustme_ops

if ! pg_lsclusters --no-header | awk '$2 == "trustme" { found = 1 } END { exit !found }'; then
  pg_createcluster "$TRUSTME_PG_VERSION" trustme --port "$TRUSTME_PG_PORT" --start
fi
pg_conftool "$TRUSTME_PG_VERSION" trustme set listen_addresses 127.0.0.1
pg_conftool "$TRUSTME_PG_VERSION" trustme set hot_standby on
PG_DATA="$(pg_conftool "$TRUSTME_PG_VERSION" trustme show data_directory)"
systemctl stop "$(pg_service_name)" || true

install -d -o postgres -g postgres -m 0700 /var/lib/postgresql
install -d -m 0751 "$(dirname "$PGPASS_FILE")"
if [[ -e "$PG_DATA/PG_VERSION" && ! -e "$PG_DATA/standby.signal" ]]; then
  mv "$PG_DATA" "${PG_DATA}.before-trustme-$(date +%Y%m%d%H%M%S)"
  install -d -o postgres -g postgres -m 0700 "$PG_DATA"
fi

TUNNEL_PORT="${TRUSTME_REPLICATION_TUNNEL_PORT:-}"
[[ "$TUNNEL_PORT" == "$TRUSTME_EXPECTED_REPLICATION_TUNNEL_PORT" ]] ||
  { printf 'TRUSTME_REPLICATION_TUNNEL_PORT must be %s\n' "$TRUSTME_EXPECTED_REPLICATION_TUNNEL_PORT" >&2; exit 1; }
cat > /etc/systemd/system/trustme-pg-replication-tunnel.service <<EOF
[Unit]
Description=TrustMe PostgreSQL replication tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/ssh -i ${TRUSTME_SSH_KEY} -N -T \\
  -o BatchMode=yes -o ExitOnForwardFailure=yes \\
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \\
  -o StrictHostKeyChecking=accept-new \\
  -L 127.0.0.1:${TUNNEL_PORT}:127.0.0.1:${TRUSTME_PG_PORT} \\
  ${TRUSTME_SSH_USER}@${TRUSTME_PRIMARY_HOST}
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 /etc/systemd/system/trustme-pg-replication-tunnel.service
systemctl daemon-reload
systemctl enable --now trustme-pg-replication-tunnel.service

printf '127.0.0.1:%s:*:%s:%s\n' "$TUNNEL_PORT" "$TRUSTME_REPLICATION_ROLE" \
  "$TRUSTME_REPLICATION_PASSWORD" | install -o postgres -g postgres -m 0600 \
  /dev/stdin "$PGPASS_FILE"

remote_ssh=(ssh -i "$TRUSTME_SSH_KEY" -o BatchMode=yes
  -o StrictHostKeyChecking=accept-new "${TRUSTME_SSH_USER}@${TRUSTME_PRIMARY_HOST}")
escaped_replication_password="${TRUSTME_REPLICATION_PASSWORD//\'/\'\'}"
{
  printf "\\set trustme_replication_password '%s'\n" "$escaped_replication_password"
  printf 'do $$ begin if not exists (select 1 from pg_roles where rolname = '
  printf "'%s') then create role \"%s\" replication login password :" \
    "$TRUSTME_REPLICATION_ROLE" "$TRUSTME_REPLICATION_ROLE"
  printf '%s\n' "'trustme_replication_password'; end if; end \$\$;"
} | "${remote_ssh[@]}" "sudo -u postgres psql -p ${TRUSTME_PG_PORT} -d postgres -v ON_ERROR_STOP=1"
unset escaped_replication_password
"${remote_ssh[@]}" "sudo -u postgres psql -p ${TRUSTME_PG_PORT} -d postgres -v ON_ERROR_STOP=1 -c \"select pg_create_physical_replication_slot('${TRUSTME_REPLICATION_SLOT}') where not exists (select 1 from pg_replication_slots where slot_name = '${TRUSTME_REPLICATION_SLOT}')\""

if [[ ! -e "$PG_DATA/standby.signal" ]]; then
  sudo -u postgres env PGPASSFILE="$PGPASS_FILE" pg_basebackup \
    -h 127.0.0.1 -p "$TUNNEL_PORT" \
    -U "$TRUSTME_REPLICATION_ROLE" -D "$PG_DATA" -X stream \
    -S "$TRUSTME_REPLICATION_SLOT" -R -P
fi
systemctl start "$(pg_service_name)"
sudo -u postgres psql -p "$TRUSTME_PG_PORT" -d postgres -Atqc \
  'select pg_is_in_recovery()' | grep -qx t

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
for unit in api worker admin redis; do
  systemctl disable --now "trustme-${unit}.service" 2>/dev/null || true
done
systemctl daemon-reload
install -d -o root -g trustme -m 0750 /etc/trustme
date -Is > "$MARKER_PATH"
chown root:trustme "$MARKER_PATH"
chmod 0640 "$MARKER_PATH"

printf 'TrustMe standby installation complete; application and Redis units remain disabled.\n'
