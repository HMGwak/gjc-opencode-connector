#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
expected_root="/Users/planee/Automation/codeconnector"

[ "$repo_root" = "$expected_root" ] || {
  echo "Agent Hub deploy: repository must be at $expected_root" >&2
  exit 1
}

exec sudo -n env \
  BUN_BINARY=/Users/planee/.bun/bin/bun \
  /bin/sh "$expected_root/deploy/install-agent-hub.sh"
