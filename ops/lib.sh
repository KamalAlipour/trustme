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

ensure_generated_secret() {
  local name="$1"
  local bytes="$2"
  local value
  if [[ -n "${!name:-}" ]]; then
    return 0
  fi
  command -v openssl >/dev/null 2>&1 || {
    printf 'openssl is required to generate %s\n' "$name" >&2
    return 1
  }
  value="$(openssl rand -hex "$bytes")"
  if grep -q "^${name}=" "$trustme_env_file"; then
    sed -i -E "s|^${name}=.*$|${name}=${value}|" "$trustme_env_file"
  else
    printf '%s=%s\n' "$name" "$value" >> "$trustme_env_file"
  fi
  printf -v "$name" '%s' "$value"
  export "$name"
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

install_trustme_ops() {
  install -d -o root -g root -m 0750 /opt/trustme/ops
  for script in "$ops_script_dir"/*.sh; do
    install -o root -g root -m 0750 "$script" \
      "/opt/trustme/ops/$(basename "$script")"
  done
  install -d -o root -g root -m 0750 /opt/trustme/ops/systemd \
    /opt/trustme/ops/nginx /opt/trustme/ops/env
  install -o root -g root -m 0644 "$ops_script_dir"/systemd/*.service \
    /opt/trustme/ops/systemd/
  install -o root -g root -m 0644 "$ops_script_dir"/nginx/trustme.conf \
    /opt/trustme/ops/nginx/
  install -o root -g root -m 0640 "$ops_script_dir"/env/trustme.env.example \
    /opt/trustme/ops/env/
}

install_trustme_units() {
  local pg_unit="$1"
  local unit source destination
  for unit in api worker admin redis; do
    source="$ops_script_dir/systemd/trustme-${unit}.service"
    destination="/etc/systemd/system/trustme-${unit}.service"
    sed "s|__TRUSTME_PG_UNIT__|${pg_unit}|g" "$source" > "$destination"
    chown root:root "$destination"
    chmod 0644 "$destination"
  done
}

install_trustme_nginx_vhost() {
  require_value TRUSTME_API_HOST
  require_value TRUSTME_ADMIN_HOST
  local vhost="${TRUSTME_NGINX_VHOST:-/etc/nginx/sites-available/trustme.conf}"
  local enabled="${TRUSTME_NGINX_ENABLED_LINK:-/etc/nginx/sites-enabled/trustme.conf}"
  if ! [[ "$TRUSTME_API_HOST" =~ ^[A-Za-z0-9.-]+$ &&
    "$TRUSTME_ADMIN_HOST" =~ ^[A-Za-z0-9.-]+$ ]]; then
    printf 'invalid TrustMe hostname\n' >&2
    return 1
  fi
  install -d -m 0755 "$(dirname "$vhost")" "$(dirname "$enabled")"
  sed -e "s|__TRUSTME_API_HOST__|${TRUSTME_API_HOST}|g" \
    -e "s|__TRUSTME_ADMIN_HOST__|${TRUSTME_ADMIN_HOST}|g" \
    "$ops_script_dir/nginx/trustme.conf" > "$vhost"
  chown root:root "$vhost"
  chmod 0644 "$vhost"
  ln -sfn "$vhost" "$enabled"
  nginx -t
  if systemctl is-active --quiet nginx; then
    systemctl reload nginx
  else
    systemctl start nginx
  fi
}
