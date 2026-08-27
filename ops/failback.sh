#!/usr/bin/env bash
# Deliberately reverse a TrustMe promotion. This is never automatic.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ops/lib.sh
source "$SCRIPT_DIR/lib.sh"
require_root
if [[ "${1:-}" != "--force" ]]; then
  printf 'refusing failback without explicit --force confirmation\n' >&2
  exit 2
fi
load_trustme_env
LOG=/var/log/trustme-failback.log
exec > >(tee -a "$LOG") 2>&1

for variable in TRUSTME_PRIMARY_HOST TRUSTME_SSH_USER TRUSTME_SSH_KEY \
  TRUSTME_REPLICATION_ROLE TRUSTME_REPLICATION_SLOT TRUSTME_REPLICATION_PASSWORD \
  TRUSTME_PG_DATABASE; do
  require_value "$variable"
done
PG_VERSION="${TRUSTME_PG_VERSION:-}"
require_value PG_VERSION
PG_PORT="${TRUSTME_PG_PORT:-}"
FAILBACK_TUNNEL_PORT="${TRUSTME_FAILBACK_TUNNEL_PORT:-}"
MARKER_PATH="${FAILOVER_MARKER_PATH:-/etc/trustme/FAILED_OVER}"
PGPASS_FILE="${TRUSTME_PGPASS_FILE:-/etc/trustme/pgpass}"
[[ "$PG_PORT" == "$TRUSTME_EXPECTED_PG_PORT" ]] || exit 1
[[ "$FAILBACK_TUNNEL_PORT" == "$TRUSTME_EXPECTED_FAILBACK_TUNNEL_PORT" ]] ||
  { printf 'TRUSTME_FAILBACK_TUNNEL_PORT must be %s\n' \
      "$TRUSTME_EXPECTED_FAILBACK_TUNNEL_PORT" >&2; exit 1; }
remote=(ssh -i "$TRUSTME_SSH_KEY" -o BatchMode=yes
  -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new
  "${TRUSTME_SSH_USER}@${TRUSTME_PRIMARY_HOST}")
log() { printf '%s %s\n' "$(date -Is)" "$*"; }
"${remote[@]}" true || { log "Server 1 is not reachable over SSH"; exit 1; }

log "stopping writes on the active Server 2"
install -d -o root -g trustme -m 0750 "$(dirname "$MARKER_PATH")"
date -Is > "$MARKER_PATH"
systemctl stop trustme-worker.service trustme-api.service trustme-admin.service \
  trustme-redis.service trustme-pg-replication-tunnel.service || true

# Create a new slot on the current primary and use a temporary reverse SSH
# tunnel so the fenced Server 1 can receive a physical base backup without
# exposing PostgreSQL publicly.
sudo -u postgres psql -p "$PG_PORT" -d postgres -v ON_ERROR_STOP=1 -c \
  "select pg_create_physical_replication_slot('${TRUSTME_REPLICATION_SLOT}_s1') where not exists (select 1 from pg_replication_slots where slot_name = '${TRUSTME_REPLICATION_SLOT}_s1')" >/dev/null
ssh -i "$TRUSTME_SSH_KEY" -N -T -o BatchMode=yes \
  -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new \
  -R 127.0.0.1:"$FAILBACK_TUNNEL_PORT":127.0.0.1:"$PG_PORT" \
  "${TRUSTME_SSH_USER}@${TRUSTME_PRIMARY_HOST}" &
tunnel_pid=$!
trap 'kill "$tunnel_pid" 2>/dev/null || true' EXIT
sleep 2
escaped_password="${TRUSTME_REPLICATION_PASSWORD//\'/\'\'}"
{
  printf "\\set trustme_replication_password '%s'\n" "$escaped_password"
  printf 'host=127.0.0.1 port=%s user=%s password=' "$FAILBACK_TUNNEL_PORT" \
    "$TRUSTME_REPLICATION_ROLE"
  printf "'trustme_replication_password'\n"
} | "${remote[@]}" "sudo install -d -o root -g trustme -m 0751 \"$(dirname "$PGPASS_FILE")\"; sudo install -o postgres -g postgres -m 0600 /dev/stdin \"$PGPASS_FILE\""
unset escaped_password
"${remote[@]}" "systemctl stop postgresql@${PG_VERSION}-trustme.service; data=\$(sudo -u postgres pg_conftool ${PG_VERSION} trustme show data_directory); if [ -e \"\$data/PG_VERSION\" ]; then mv \"\$data\" \"\$data.before-trustme-failback-\$(date +%Y%m%d%H%M%S)\"; fi; install -d -o postgres -g postgres -m 0700 \"\$data\"; sudo -u postgres env PGPASSFILE=${PGPASS_FILE} pg_basebackup -h 127.0.0.1 -p ${FAILBACK_TUNNEL_PORT} -U ${TRUSTME_REPLICATION_ROLE} -D \"\$data\" -X stream -S ${TRUSTME_REPLICATION_SLOT}_s1 -R -P; systemctl start postgresql@${PG_VERSION}-trustme.service; for i in \$(seq 1 30); do [ \"\$(sudo -u postgres psql -p ${PG_PORT} -d postgres -Atqc 'select pg_is_in_recovery()')\" = t ] && break; sleep 2; done; sudo -u postgres psql -p ${PG_PORT} -d postgres -Atqc 'select pg_promote(true, 60)' >/dev/null; rm -f ${MARKER_PATH}; systemctl enable --now trustme-redis.service trustme-api.service trustme-admin.service trustme-worker.service"
kill "$tunnel_pid" 2>/dev/null || true
trap - EXIT

log "Server 1 is primary again; re-seeding this host as its standby"
"$SCRIPT_DIR/s2-standby.sh"
printf 'Operator action required: move TrustMe DNS back to %s and reload its nginx vhost.\n' \
  "$TRUSTME_PRIMARY_HOST"
log "=== TRUSTME FAILBACK DONE ==="
