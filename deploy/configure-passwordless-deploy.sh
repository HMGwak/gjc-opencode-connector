#!/bin/sh
set -eu

[ "$(id -u)" -eq 0 ] || {
  echo "Passwordless deploy setup: run with sudo." >&2
  exit 1
}

sudoers_file=/etc/sudoers.d/planee-agent-hub-deploy
temporary_file=$(mktemp /tmp/planee-agent-hub-sudoers.XXXXXX)
trap 'rm -f "$temporary_file"' EXIT HUP INT TERM

cat >"$temporary_file" <<'EOF'
# Planee Agent Hub: allow only the exact deployment command.
# The deploy target is a root launchd service, so this permission is equivalent
# to allowing its owner to replace that service's executable snapshot.
planee ALL=(root) NOPASSWD: /usr/bin/env BUN_BINARY=/Users/planee/.bun/bin/bun /bin/sh /Users/planee/Automation/codeconnector/deploy/install-agent-hub.sh
EOF

chmod 0440 "$temporary_file"
chown root:wheel "$temporary_file"
/usr/sbin/visudo -cf "$temporary_file" >/dev/null
install -o root -g wheel -m 0440 "$temporary_file" "$sudoers_file"
/usr/sbin/visudo -cf /etc/sudoers >/dev/null

echo "Passwordless Agent Hub deployment configured."
