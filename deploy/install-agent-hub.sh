#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
plist_source="$repo_root/deploy/com.planee.agent-hub.plist"
plist_target="/Library/LaunchDaemons/com.planee.agent-hub.plist"
data_dir="/var/db/planee-agent-hub"
secret_file="$data_dir/pairing-root-secret"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

install -d -o root -g wheel -m 700 "$data_dir"
if [ ! -f "$secret_file" ]; then
  umask 077
  openssl rand 32 > "$secret_file"
fi
chown root:wheel "$secret_file"
chmod 600 "$secret_file"
install -o root -g wheel -m 644 "$plist_source" "$plist_target"
launchctl bootout system/com.planee.agent-hub 2>/dev/null || true
launchctl bootstrap system "$plist_target"
launchctl kickstart -k system/com.planee.agent-hub
