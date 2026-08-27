#!/usr/bin/env bash
# Shared, TrustMe-only helpers for scripts under ops/.

ops_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ops/ports.sh
source "$ops_script_dir/ports.sh"

trustme_env_file="${TRUSTME_ENV_FILE:-/etc/trustme/trustme.env}"

load_trustme_env() {
  if [[ ! -r "$trustme_env_file" ]]; then
    printf 'missing environment file: %s\n' "$trustme_env_file" >&2
    return 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "$trustme_env_file"
  set +a
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    printf 'this TrustMe operation must run as root\n' >&2
    return 1
  fi
}

require_value() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    printf 'missing required environment value: %s\n' "$name" >&2
    return 1
  fi
}

valid_identifier() {
  [[ "$1" =~ ^[a-z_][a-z0-9_]*$ ]]
}

pg_service_name() {
  printf 'postgresql@%s-trustme.service' "${TRUSTME_PG_VERSION}"
}
