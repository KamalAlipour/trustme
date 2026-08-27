#!/usr/bin/env bash
# Deploy a ref to an already-installed TrustMe host. Run locally as root.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ops/lib.sh
source "$SCRIPT_DIR/lib.sh"

require_root
load_trustme_env
REF=""
NO_MIGRATE=0
ROLLBACK=0
while (($# > 0)); do
  case "$1" in
    --ref)
      (($# >= 2)) || { printf '%s requires a value\n' "$1" >&2; exit 2; }
      REF="$2"; shift 2 ;;
    --no-migrate) NO_MIGRATE=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    *) printf 'usage: %s --ref REF [--no-migrate] [--rollback]\n' "$0" >&2; exit 2 ;;
  esac
done

release_root="${TRUSTME_RELEASE_ROOT:-/opt/trustme/releases}"
current_link="${TRUSTME_CURRENT_LINK:-/opt/trustme/current}"
previous_link="${release_root}/previous"
repo_cache="${TRUSTME_REPO_CACHE:-/opt/trustme/repository.git}"
repo_url="${TRUSTME_REPOSITORY_URL:-}"
release=""
old_release=""
require_value TRUSTME_REPOSITORY_URL
MARKER_PATH="${FAILOVER_MARKER_PATH:-/etc/trustme/FAILED_OVER}"

rollback_release() {
  local target
  target="$(readlink -f "$previous_link" 2>/dev/null || true)"
  [[ -n "$target" && -d "$target" ]] || {
    printf 'no previous release is available\n' >&2
    return 1
  }
  systemctl stop trustme-worker.service || true
  ln -sfn "$target" "${current_link}.next"
  mv -Tf "${current_link}.next" "$current_link"
  systemctl restart trustme-api.service trustme-admin.service
  if [[ ! -e "$MARKER_PATH" ]]; then
    systemctl start trustme-worker.service
  fi
  printf 'rolled back to %s\n' "$target"
}

if ((ROLLBACK == 1)); then
  rollback_release
  exit 0
fi
[[ -n "$REF" ]] || { printf '--ref is required\n' >&2; exit 2; }

install -d -o trustme -g trustme -m 0750 "$release_root"
if [[ ! -d "$repo_cache" ]]; then
  git clone --mirror "$repo_url" "$repo_cache"
fi
git -C "$repo_cache" remote get-url origin >/dev/null 2>&1 ||
  git -C "$repo_cache" remote add origin "$repo_url"
fetch_ref="${REF#origin/}"
git -C "$repo_cache" fetch --prune origin "$fetch_ref"
commit="$(git -C "$repo_cache" rev-parse FETCH_HEAD)"
release="${release_root}/$(date +%Y%m%d%H%M%S)-${commit:0:12}"
install -d -o trustme -g trustme -m 0750 "$release"
git -C "$repo_cache" archive "$commit" | tar -x -C "$release"
chown -R trustme:trustme "$release"

(cd "$release" && npm ci && npm run build)
if ((NO_MIGRATE == 0)); then
  (cd "$release" && npx prisma migrate deploy --schema packages/db/prisma/schema.prisma)
fi

old_release="$(readlink -f "$current_link" 2>/dev/null || true)"
systemctl stop trustme-worker.service
if [[ -n "$old_release" && -d "$old_release" ]]; then
  ln -sfn "$old_release" "${previous_link}.next"
  mv -Tf "${previous_link}.next" "$previous_link"
fi
ln -sfn "$release" "${current_link}.next"
mv -Tf "${current_link}.next" "$current_link"
if ! systemctl restart trustme-api.service trustme-admin.service; then
  if [[ -n "$old_release" && -d "$old_release" ]]; then
    ln -sfn "$old_release" "${current_link}.next"
    mv -Tf "${current_link}.next" "$current_link"
  fi
  systemctl restart trustme-api.service trustme-admin.service || true
  exit 1
fi
if [[ ! -e "$MARKER_PATH" ]]; then
  systemctl start trustme-worker.service
fi
printf 'deployed %s to %s\n' "$commit" "$release"
