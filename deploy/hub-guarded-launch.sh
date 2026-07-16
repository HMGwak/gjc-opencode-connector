#!/bin/sh
set -eu

runtime_config=${HUB_RUNTIME_CONFIG:-"/Library/Application Support/planee-agent-hub/runtime.conf"}
sqlite_binary=${HUB_SQLITE_BINARY:-/usr/bin/sqlite3}

action=${1:-run}

fail() {
  echo "Hub guard: $*" >&2
  exit 1
}

schema_fence_allows_runtime() {
  minimum_version=$1
  runtime_version=$2
  case "$minimum_version:$runtime_version" in *[!0-9:]*|:*|*:) return 1 ;; esac
  [ "$minimum_version" -le "$runtime_version" ]
}

initializer_matches_runtime() {
  [ "$1" = "$2" ]
}
schema_fence_minimum_version() {
  database_path=$1
  db_evidence=$("$sqlite_binary" "$database_path" "PRAGMA quick_check(1); SELECT min_version FROM schema_fence WHERE name = 'min_binary_version' AND active = 1;") || return 1
  quick_check=$(printf '%s\n' "$db_evidence" | { IFS= read -r line; printf '%s' "$line"; })
  minimum_binary_version=$(printf '%s\n' "$db_evidence" | { IFS= read -r _; IFS= read -r line; printf '%s' "$line"; })
  [ "$quick_check" = "ok" ] || return 1
  case "$minimum_binary_version" in *[!0-9]*|'') return 1 ;; esac
  printf '%s' "$minimum_binary_version"
}

# The no-argument self-test has no filesystem or privilege prerequisites. With a
# database path and runtime compatibility, it verifies the canonical schema fence.
if [ "$action" = "--self-test" ]; then
  [ "$#" -eq 1 ] || [ "$#" -eq 3 ] || fail "self-test usage: --self-test [database-path runtime-compatibility]"
  schema_fence_allows_runtime 1 1 || exit 1
  schema_fence_allows_runtime 1 2 || exit 1
  # Every KeepAlive retry reaches this fence before the sole exec below.
  ! schema_fence_allows_runtime 2 1 || exit 1
  ! schema_fence_allows_runtime 100 1 || exit 1
  initializer_matches_runtime 1 1 || exit 1
  ! initializer_matches_runtime 1 2 || exit 1
  if [ "$#" -eq 3 ]; then
    [ -f "$2" ] || fail "self-test database is not a regular file: $2"
    [ -x "$sqlite_binary" ] || fail "sqlite3 is unavailable for schema-fence self-test"
    minimum_binary_version=$(schema_fence_minimum_version "$2") || fail "self-test database does not have an active min_binary_version schema fence"
    schema_fence_allows_runtime "$minimum_binary_version" "$3" || fail "self-test schema_fence/min_binary_version $minimum_binary_version is incompatible with binary compatibility $3"
  fi
  echo "hub guard schema-fence self-test: pass/fail coverage ok"
  exit 0
fi
[ "$action" = "run" ] || [ "$action" = "--check" ] || fail "unknown action: $action"

verify_root_immutable_path() {
  path=$1
  kind=$2
  case "$path" in /*) ;; *) fail "$kind is not absolute: $path" ;; esac

  remaining=${path#/}
  current=
  while [ -n "$remaining" ]; do
    component=${remaining%%/*}
    if [ "$remaining" = "$component" ]; then remaining=; else remaining=${remaining#*/}; fi
    [ -n "$component" ] || fail "$kind has an invalid path component: $path"
    current="${current}/${component}"
    [ -e "$current" ] || fail "$kind is missing: $current"
    [ ! -L "$current" ] || fail "$kind must not contain a symlink: $current"
    [ "$(stat -f '%u' "$current")" = "0" ] || fail "$kind is not owned by root: $current"
    mode=$(stat -f '%Lp' "$current")
    [ $((0$mode & 022)) -eq 0 ] || fail "$kind is writable by group or other: $current"
  done
}

[ -f "$runtime_config" ] || fail "runtime configuration is missing: $runtime_config"
verify_root_immutable_path "$runtime_config" "runtime configuration"
[ "$(stat -f '%Lp' "$runtime_config")" = "600" ] || fail "runtime configuration permissions are not 0600: $runtime_config"

snapshot_root=
hub_entrypoint=
bun_binary=
binary_schema_compatibility=
initializer_schema_compatibility=
config_lines=0
while IFS= read -r line || [ -n "$line" ]; do
  config_lines=$((config_lines + 1))
  case "$line" in
    SNAPSHOT_ROOT=*) [ -z "$snapshot_root" ] || fail "runtime configuration repeats SNAPSHOT_ROOT"; snapshot_root=${line#SNAPSHOT_ROOT=} ;;
    HUB_ENTRYPOINT=*) [ -z "$hub_entrypoint" ] || fail "runtime configuration repeats HUB_ENTRYPOINT"; hub_entrypoint=${line#HUB_ENTRYPOINT=} ;;
    BUN_BINARY=*) [ -z "$bun_binary" ] || fail "runtime configuration repeats BUN_BINARY"; bun_binary=${line#BUN_BINARY=} ;;
    BINARY_SCHEMA_COMPATIBILITY=*) [ -z "$binary_schema_compatibility" ] || fail "runtime configuration repeats BINARY_SCHEMA_COMPATIBILITY"; binary_schema_compatibility=${line#BINARY_SCHEMA_COMPATIBILITY=} ;;
    INITIALIZER_SCHEMA_COMPATIBILITY=*) [ -z "$initializer_schema_compatibility" ] || fail "runtime configuration repeats INITIALIZER_SCHEMA_COMPATIBILITY"; initializer_schema_compatibility=${line#INITIALIZER_SCHEMA_COMPATIBILITY=} ;;
    *) fail "runtime configuration has an invalid line" ;;
  esac
done < "$runtime_config"
[ "$config_lines" -eq 5 ] || fail "runtime configuration has an invalid number of lines"

case "$snapshot_root" in "/Library/Application Support/planee-agent-hub/runtime") ;; *) fail "runtime SNAPSHOT_ROOT is invalid" ;; esac
case "$hub_entrypoint" in "$snapshot_root"/apps/hub/src/index.ts) ;; *) fail "runtime HUB_ENTRYPOINT is outside the snapshot" ;; esac
case "$bun_binary" in "$snapshot_root"/bin/bun) ;; *) fail "runtime BUN_BINARY is outside the snapshot" ;; esac
case "$binary_schema_compatibility" in *[!0-9]*|'') fail "runtime BINARY_SCHEMA_COMPATIBILITY is invalid" ;; esac
case "$initializer_schema_compatibility" in *[!0-9]*|'') fail "runtime INITIALIZER_SCHEMA_COMPATIBILITY is invalid" ;; esac

# `runtime` is the one installed runtime artifact. It is a root-owned immutable
# directory, never a selector that can retain a retired generation.
verify_root_immutable_path "$snapshot_root" "runtime directory"

hub_dir="$snapshot_root/apps/hub"
web_root="$snapshot_root/apps/web/dist"
entrypoint="$snapshot_root/apps/hub/src/index.ts"
bun="$snapshot_root/bin/bun"
verify_root_immutable_path "$hub_dir" "Hub runtime directory"
verify_root_immutable_path "$entrypoint" "Hub entrypoint"
verify_root_immutable_path "$bun" "Bun runtime executable"
verify_root_immutable_path "$web_root" "Hub web root"
[ -f "$entrypoint" ] || fail "expected Hub entrypoint is not a regular file: $entrypoint"
[ -x "$bun" ] || fail "expected Bun executable is missing or not executable: $bun"
[ -n "${HUB_DATABASE_PATH:-}" ] || fail "HUB_DATABASE_PATH is not set"
[ -n "${HUB_OWNER_ID:-}" ] || fail "HUB_OWNER_ID is not set"
[ -n "${HUB_PAIRING_ROOT_SECRET_FILE:-}" ] || fail "HUB_PAIRING_ROOT_SECRET_FILE is not set"
[ -r "$HUB_PAIRING_ROOT_SECRET_FILE" ] || fail "pairing root secret is missing or unreadable"
[ -d "$web_root" ] || fail "Hub web root is missing: $web_root"
export HUB_WEB_ROOT="$web_root"

if [ -e "$HUB_DATABASE_PATH" ]; then
  [ -f "$HUB_DATABASE_PATH" ] || fail "Hub database path is not a regular file: $HUB_DATABASE_PATH"
  verify_root_immutable_path "$HUB_DATABASE_PATH" "Hub database"
  [ -x "$sqlite_binary" ] || fail "sqlite3 is unavailable for Hub database schema-fence verification"
  verify_root_immutable_path "$sqlite_binary" "sqlite3 schema-fence verifier"
  minimum_binary_version=$(schema_fence_minimum_version "$HUB_DATABASE_PATH") || fail "Hub database schema-fence verification could not read an active min_binary_version fence: $HUB_DATABASE_PATH"
  schema_fence_allows_runtime "$minimum_binary_version" "$binary_schema_compatibility" || fail "Hub database schema_fence/min_binary_version $minimum_binary_version is incompatible with binary compatibility $binary_schema_compatibility"
else
  initializer_matches_runtime "$initializer_schema_compatibility" "$binary_schema_compatibility" || fail "Hub database is absent and runtime compatibility $binary_schema_compatibility is not declared initializer-compatible ($initializer_schema_compatibility)"
fi

[ "$action" = "--check" ] && exit 0
cd "$hub_dir" || fail "expected Hub directory is unavailable: $hub_dir"
exec "$bun" run "$entrypoint"
