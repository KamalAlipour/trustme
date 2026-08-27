#!/usr/bin/env bash
# Promote the local Server 2 standby to the active TrustMe node.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ops/lib.sh
source "$SCRIPT_DIR/lib.sh"
require_root
load_trustme_env
LOG=/var/log/trustme-promote.log
exec > >(tee -a "$LOG") 2>&1

for variable in TRUSTME_PRIMARY_HOST TRUSTME_SSH_USER TRUSTME_SSH_KEY \
  TRUSTME_PG_DATABASE; do
  require_value "$variable"
done
PG_PORT="${TRUSTME_PG_PORT:-}"
REDIS_PORT="${TRUSTME_REDIS_PORT:-}"
MARKER_PATH="${FAILOVER_MARKER_PATH:-/etc/trustme/FAILED_OVER}"
[[ "$PG_PORT" == "$TRUSTME_EXPECTED_PG_PORT" ]] || exit 1
[[ "$REDIS_PORT" == "$TRUSTME_EXPECTED_REDIS_PORT" ]] || exit 1
remote=(ssh -i "$TRUSTME_SSH_KEY" -o BatchMode=yes
  -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new
  "${TRUSTME_SSH_USER}@${TRUSTME_PRIMARY_HOST}")

log() { printf '%s %s\n' "$(date -Is)" "$*"; }
log "=== TRUSTME PROMOTE START ==="
if "${remote[@]}" true 2>/dev/null; then
  log "fencing Server 1 over SSH"
  "${remote[@]}" "install -d -o root -g trustme -m 0750 \"$(dirname "$MARKER_PATH")\"; date -Is > \"$MARKER_PATH\"; systemctl stop trustme-worker.service trustme-api.service trustme-admin.service trustme-redis.service || true" || true
else
  log "Server 1 SSH unreachable; continuing without remote fencing"
fi

systemctl stop trustme-pg-replication-tunnel.service || true
if [[ "$(sudo -u postgres psql -p "$PG_PORT" -d postgres -Atqc \
  'select pg_is_in_recovery()')" == t ]]; then
  sudo -u postgres psql -p "$PG_PORT" -d postgres -Atqc \
    'select pg_promote(true, 60)' >/dev/null
fi
for _ in $(seq 1 30); do
  [[ "$(sudo -u postgres psql -p "$PG_PORT" -d postgres -Atqc \
    'select pg_is_in_recovery()')" == f ]] && break
  sleep 2
done
[[ "$(sudo -u postgres psql -p "$PG_PORT" -d postgres -Atqc \
  'select pg_is_in_recovery()')" == f ]] || { log "promotion failed"; exit 1; }

# Server 1 may have a newer glibc than Server 2. Refreshing collation metadata
# and rebuilding text indexes prevents a glibc-skewed standby from serving
# inconsistent ordering after promotion.
sudo -u postgres psql -p "$PG_PORT" -d postgres -v ON_ERROR_STOP=1 \
  -c "alter database \"${TRUSTME_PG_DATABASE}\" refresh collation version" || true
sudo -u postgres reindexdb -p "$PG_PORT" -d "$TRUSTME_PG_DATABASE" || log "WARN: reindex failed"
rm -f "$MARKER_PATH"
systemctl enable --now trustme-redis.service
systemctl enable --now trustme-api.service trustme-admin.service trustme-worker.service
install_trustme_nginx_vhost
log "TrustMe is active on this host"
printf 'Operator action required: point TrustMe DNS records to this host (%s).\n' \
  "${TRUSTME_STANDBY_HOST:-this server}"
printf 'Operator action required: obtain TLS with certbot after DNS points here.\n'
printf '=== TRUSTME PROMOTE DONE ===\n'
