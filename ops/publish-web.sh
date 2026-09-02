#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
web_env_file="${TRUSTME_WEB_ENV_FILE:-/etc/trustme/trustme-web.env}"
web_root="${TRUSTME_WEB_ROOT:-/var/www/trustcoupon-web}"
previous_retention="${TRUSTME_WEB_PREVIOUS_RETENTION:-1}"
required_vars=(
  EXPO_PUBLIC_API_URL
  EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID
  EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID
  EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID
  EXPO_PUBLIC_APPLE_WEB_CLIENT_ID
)

if [[ ! -r "$web_env_file" ]]; then
  printf 'missing web environment file: %s\n' "$web_env_file" >&2
  exit 1
fi

for name in "${required_vars[@]}"; do
  unset "$name"
done
set -a
# shellcheck disable=SC1090
source "$web_env_file"
set +a

missing=0
for name in "${required_vars[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    printf 'missing required web environment variable: %s\n' "$name" >&2
    missing=1
  fi
done
if ((missing != 0)); then
  exit 1
fi

if ! [[ "$previous_retention" =~ ^[0-9]+$ ]]; then
  printf 'invalid previous web copy retention: %s\n' "$previous_retention" >&2
  exit 1
fi

web_parent="$(dirname -- "$web_root")"
web_name="$(basename -- "$web_root")"
mkdir -p "$web_parent"
mobile_root="$repo_root/apps/mobile"
staging_dir="$(mktemp -d "$mobile_root/.web-publish.XXXXXX")"

cleanup() {
  if [[ -d "$staging_dir" ]]; then
    rm -rf -- "$staging_dir"
  fi
}
trap cleanup EXIT

(
  cd "$repo_root/apps/mobile"
  npx expo export --platform web --clear --output-dir "$staging_dir"
)

web_chunks_dir="$staging_dir/_expo/static/js/web"
if [[ ! -d "$web_chunks_dir" ]]; then
  printf 'web publish gate failed: Expo emitted no web chunk directory\n' >&2
  exit 1
fi
mapfile -t web_chunks < <(find "$web_chunks_dir" -maxdepth 1 -type f -name '*.js' -print | sort)
if ((${#web_chunks[@]} == 0)); then
  printf 'web publish gate failed: Expo emitted no web chunks\n' >&2
  exit 1
fi

if grep -l -E -- 'import\.meta' "${web_chunks[@]}" >/dev/null; then
  printf 'web publish gate failed: an emitted web chunk contains import.meta\n' >&2
  exit 1
else
  grep_status=$?
  if ((grep_status != 1)); then
    printf 'web publish gate failed: could not scan emitted web chunks\n' >&2
    exit 1
  fi
fi

for name in "${required_vars[@]:1}"; do
  if ! grep -F -l -- "${!name}" "${web_chunks[@]}" >/dev/null; then
    printf 'web publish gate failed: %s is absent from emitted web chunks\n' "$name" >&2
    exit 1
  fi
done

timestamp="$(date -u +%Y%m%d%H%M%S)"
previous_root="${web_root}.prev-${timestamp}"
suffix=0
while [[ -e "$previous_root" || -L "$previous_root" ]]; do
  suffix=$((suffix + 1))
  previous_root="${web_root}.prev-${timestamp}-${suffix}"
done
if [[ -e "$web_root" || -L "$web_root" ]]; then
  mv -- "$web_root" "$previous_root"
fi
mv -- "$staging_dir" "$web_root"

mapfile -t previous_copies < <(
  find "$web_parent" -maxdepth 1 \( -type d -o -type l \) \
    -name "${web_name}.prev-*" -printf '%T@ %p\n' |
    sort -nr |
    cut -d' ' -f2-
)
if ((${#previous_copies[@]} > previous_retention)); then
  for old_copy in "${previous_copies[@]:previous_retention}"; do
    rm -rf -- "$old_copy"
  done
fi

printf 'published web app to %s\n' "$web_root"
