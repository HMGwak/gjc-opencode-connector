#!/bin/sh
set -eu

fail() {
  echo "Hub installer: $*" >&2
  exit 1
}

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
hub_dir="$repo_root/apps/hub"
core_dir="$repo_root/packages/core"
web_dist="$repo_root/apps/web/dist"
plist_source="$repo_root/deploy/com.planee.agent-hub.plist"
wrapper_source="$repo_root/deploy/hub-guarded-launch.sh"
plist_target="/Library/LaunchDaemons/com.planee.agent-hub.plist"
guard_dir="/Library/Application Support/planee-agent-hub"
runtime_target="$guard_dir/runtime"
wrapper_target="$guard_dir/hub-guarded-launch.sh"
runtime_config_target="$guard_dir/runtime.conf"
data_dir="/var/db/planee-agent-hub"
secret_file="$data_dir/pairing-root-secret"
binary_schema_compatibility=1
initializer_schema_compatibility=1
bun_binary=${BUN_BINARY:-}
dry_run=false

[ "${1:-}" != "--dry-run" ] || dry_run=true
[ "${1:-}" = "" ] || [ "${1:-}" = "--dry-run" ] || fail "usage: $0 [--dry-run]"
if [ -z "$bun_binary" ]; then bun_binary=$(command -v bun || :); fi

[ -f "$plist_source" ] || fail "Missing launchd plist: $plist_source"
[ -f "$wrapper_source" ] || fail "Missing Hub guard wrapper: $wrapper_source"
[ -r "$hub_dir/src/index.ts" ] || fail "Missing Hub entrypoint: $hub_dir/src/index.ts"
[ -d "$core_dir" ] || fail "Missing Core package: $core_dir"
[ -d "$web_dist" ] || fail "Missing built Web distribution: $web_dist"
[ -f "$repo_root/package.json" ] || fail "Missing workspace manifest: $repo_root/package.json"
[ -f "$repo_root/bun.lock" ] || fail "Missing workspace lockfile: $repo_root/bun.lock"
case "$repo_root" in /*) ;; *) fail "Repository root is not absolute: $repo_root" ;; esac
case "$bun_binary" in /*) ;; *) fail "Bun executable must be an absolute path; set BUN_BINARY." ;; esac
[ -x "$bun_binary" ] || fail "Bun executable is missing or not executable: $bun_binary"

if "$dry_run"; then
  sh "$wrapper_source" --self-test
  echo "Hub installer dry-run: replace-never-coexists and schema-fence guard verified"
  exit 0
fi

[ "$(id -u)" -eq 0 ] || fail "Run this installer with sudo."
install -d -o root -g wheel -m 755 "$guard_dir"
install -d -o root -g wheel -m 700 "$data_dir"
if [ ! -f "$secret_file" ]; then
  umask 077
  openssl rand 32 > "$secret_file"
fi
chown root:wheel "$secret_file"
chmod 600 "$secret_file"

snapshot_stage=$(mktemp -d "$guard_dir/.runtime-staging.XXXXXX")
wrapper_tmp=$(mktemp "$guard_dir/.hub-guarded-launch.sh.XXXXXX")
runtime_config_tmp=$(mktemp "$guard_dir/.runtime.conf.XXXXXX")
plist_tmp=$(mktemp "/Library/LaunchDaemons/.com.planee.agent-hub.plist.XXXXXX")
activation_succeeded=false
cleanup_done=false
cleanup() {
  [ "$cleanup_done" = true ] && return
  cleanup_done=true
  trap - EXIT HUP INT TERM
  rm -rf "$snapshot_stage"
  rm -f "$wrapper_tmp" "$runtime_config_tmp" "$plist_tmp"
  if ! "$activation_succeeded"; then
    # Fail closed: no previous runtime, selector, or launch configuration is restored.
    if ! launchctl bootout system/com.planee.agent-hub >/dev/null 2>&1; then :; fi
    rm -f "$runtime_config_target" "$wrapper_target" "$plist_target"
    rm -rf "$runtime_target"
  fi
}
handle_signal() {
  signal_status=$1
  trap - EXIT HUP INT TERM
  activation_succeeded=false
  cleanup
  exit "$signal_status"
}
trap cleanup EXIT
trap 'handle_signal 129' HUP
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM
# Retire every previously selectable runtime before preparing this install. A failed
# install therefore cannot resurrect or retain a retired Hub binary.
if ! launchctl bootout system/com.planee.agent-hub >/dev/null 2>&1; then :; fi
rm -f "$runtime_config_target" "$wrapper_target" "$plist_target"
rm -rf "$runtime_target" "$guard_dir/current" "$guard_dir/runtime-generations"
# Copy only the runtime closure. This excludes checkout metadata, secrets, Android,
# documentation, artifacts, and tests.
install -d "$snapshot_stage/apps" "$snapshot_stage/packages" "$snapshot_stage/bin" "$snapshot_stage/node_modules/@planee"
install -m 644 "$repo_root/package.json" "$snapshot_stage/package.json"
install -m 644 "$repo_root/bun.lock" "$snapshot_stage/bun.lock"
cp -R "$hub_dir" "$snapshot_stage/apps/hub"
cp -R "$core_dir" "$snapshot_stage/packages/core"
cp -R "$core_dir" "$snapshot_stage/node_modules/@planee/core"
install -d "$snapshot_stage/apps/web"
install -m 644 "$repo_root/apps/web/package.json" "$snapshot_stage/apps/web/package.json"
cp -R "$web_dist" "$snapshot_stage/apps/web/dist"
rm -f "$snapshot_stage/apps/hub/src/"*.test.ts "$snapshot_stage/packages/core/src/"*.test.ts "$snapshot_stage/node_modules/@planee/core/src/"*.test.ts
install -m 755 "$bun_binary" "$snapshot_stage/bin/bun"
[ -z "$(/usr/bin/find "$snapshot_stage" -type l -print -quit)" ] || fail "Runtime snapshot contains a symlink"
chown -R root:wheel "$snapshot_stage"
chmod -R go-w "$snapshot_stage"

# The configuration and plist name only the one installed runtime.
printf '%s\n' \
  "SNAPSHOT_ROOT=$runtime_target" \
  "HUB_ENTRYPOINT=$runtime_target/apps/hub/src/index.ts" \
  "BUN_BINARY=$runtime_target/bin/bun" \
  "BINARY_SCHEMA_COMPATIBILITY=$binary_schema_compatibility" \
  "INITIALIZER_SCHEMA_COMPATIBILITY=$initializer_schema_compatibility" > "$runtime_config_tmp"
chown root:wheel "$runtime_config_tmp"
chmod 600 "$runtime_config_tmp"
install -o root -g wheel -m 755 "$wrapper_source" "$wrapper_tmp"
install -o root -g wheel -m 644 "$plist_source" "$plist_tmp"

# Stop first, then remove every selectable artifact before installing the replacement.
# Bootstrap failure leaves the daemon stopped; recovery is DB backup restore plus a
# compatible redeploy, never binary resurrection.
if ! launchctl bootout system/com.planee.agent-hub >/dev/null 2>&1; then :; fi
rm -f "$runtime_config_target" "$wrapper_target" "$plist_target"
rm -rf "$runtime_target" "$guard_dir/current" "$guard_dir/runtime-generations"
mv "$snapshot_stage" "$runtime_target"
mv -f "$runtime_config_tmp" "$runtime_config_target"
mv -f "$wrapper_tmp" "$wrapper_target"
mv -f "$plist_tmp" "$plist_target"

if ! launchctl bootstrap system "$plist_target" || ! launchctl kickstart -k system/com.planee.agent-hub; then
  fail "Could not bootstrap current runtime; service remains stopped. Restore the DB backup and redeploy a compatible current runtime."
fi

activation_succeeded=true
trap - EXIT HUP INT TERM
