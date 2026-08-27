#!/usr/bin/env bash
# Validate a host before installing TrustMe. This script is intentionally
# independent of FairFare and does not connect to either production server.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ops/ports.sh
source "$SCRIPT_DIR/ports.sh"

TRUSTME_REDIS_DATA_DIR="${TRUSTME_REDIS_DATA_DIR:-/var/lib/trustme-redis}"
ALLOW_EXISTING=0
while (($# > 0)); do
  case "$1" in
    --allow-existing) ALLOW_EXISTING=1 ;;
    *) printf 'usage: %s [--allow-existing]\n' "$0" >&2; exit 2 ;;
  esac
  shift
done

PASS=0
FAIL=0
printf '%-34s %s\n' "TrustMe preflight" "result"
printf '%-34s %s\n' "------------------------------" "------"

check() {
  local label="$1"
  shift
  if "$@"; then
    printf '%-34s PASS\n' "$label"
    PASS=$((PASS + 1))
  else
    printf '%-34s FAIL\n' "$label"
    FAIL=$((FAIL + 1))
  fi
}

command_present() { command -v "$1" >/dev/null 2>&1; }

trustme_listener() {
  local port="$1"
  case "$port" in
    "$TRUSTME_EXPECTED_PG_PORT")
      pg_lsclusters --no-header 2>/dev/null |
        awk '$2 == "trustme" && $3 == "'"$port"'" { found = 1 }
          END { exit !found }'
      ;;
    "$TRUSTME_EXPECTED_REPLICATION_TUNNEL_PORT")
      systemctl is-active --quiet trustme-pg-replication-tunnel.service
      ;;
    "$TRUSTME_EXPECTED_REDIS_PORT")
      systemctl is-active --quiet trustme-redis.service
      ;;
    "$TRUSTME_EXPECTED_API_PORT")
      systemctl is-active --quiet trustme-api.service
      ;;
    "$TRUSTME_EXPECTED_ADMIN_PORT")
      systemctl is-active --quiet trustme-admin.service
      ;;
    *)
      return 1
      ;;
  esac
}

port_is_available() {
  local port="$1"
  local listeners
  listeners="$(ss -H -ltnp "( sport = :${port} )" 2>/dev/null || true)"
  if [[ -z "$listeners" ]]; then
    return 0
  fi
  if ((ALLOW_EXISTING == 1)) && trustme_listener "$port"; then
    return 0
  fi
  return 1
}

no_trustme_cluster() {
  while read -r _ name port status _ _; do
    [[ -n "${name:-}" ]] || continue
    if [[ "$name" == trustme ]]; then
      if [[ "$port" != "$TRUSTME_EXPECTED_PG_PORT" ]] ||
        ! ((ALLOW_EXISTING == 1)); then
        return 1
      fi
    elif [[ "$port" == "$TRUSTME_EXPECTED_PG_PORT" ]]; then
      return 1
    fi
  done < <(pg_lsclusters --no-header 2>/dev/null || true)
}

no_trustme_role_or_database() {
  while read -r _ name port status _ _; do
    [[ "${status:-}" == online ]] || continue
    if sudo -u postgres psql -p "$port" -d postgres -Atqc \
      "select 1 from pg_roles where rolname = 'trustme'" | grep -q 1; then
      if ! ((ALLOW_EXISTING == 1)) || [[ "$name" != trustme ]]; then
        return 1
      fi
    fi
    if sudo -u postgres psql -p "$port" -d postgres -Atqc \
      "select 1 from pg_database where datname = 'trustme'" | grep -q 1; then
      if ! ((ALLOW_EXISTING == 1)) || [[ "$name" != trustme ]]; then
        return 1
      fi
    fi
  done < <(pg_lsclusters --no-header 2>/dev/null || true)
}

trustme_user_is_safe() {
  if ! getent passwd trustme >/dev/null; then
    return 0
  fi
  local owned
  owned="$(find / -xdev -user trustme -not -path '/opt/trustme' \
    -not -path '/opt/trustme/*' -not -path "$TRUSTME_REDIS_DATA_DIR" \
    -not -path "$TRUSTME_REDIS_DATA_DIR/*" -print -quit 2>/dev/null || true)"
  [[ -z "$owned" ]]
}

for port in "$TRUSTME_EXPECTED_PG_PORT" "$TRUSTME_EXPECTED_REPLICATION_TUNNEL_PORT" \
  "$TRUSTME_EXPECTED_REDIS_PORT" "$TRUSTME_EXPECTED_API_PORT" \
  "$TRUSTME_EXPECTED_ADMIN_PORT" "$TRUSTME_EXPECTED_FAILBACK_TUNNEL_PORT"; do
  check "TCP port ${port} is available" port_is_available "$port"
done
check "no TrustMe PostgreSQL cluster" no_trustme_cluster
check "no TrustMe PostgreSQL role/database" no_trustme_role_or_database
check "trustme OS user owns only /opt/trustme" trustme_user_is_safe
for binary in bash awk find getent id install ss systemctl sudo runuser pg_lsclusters \
  psql pg_createcluster pg_conftool pg_basebackup reindexdb redis-server nginx git npm node; do
  check "binary ${binary} exists" command_present "$binary"
done

if ((FAIL > 0)); then
  printf '\nPreflight failed: %d check(s) failed, %d passed.\n' "$FAIL" "$PASS" >&2
  exit 1
fi
printf '\nPreflight passed: %d checks.\n' "$PASS"
