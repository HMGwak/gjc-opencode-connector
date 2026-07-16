# Personal Device Pairing and Cloudflare Tunnel Runbook

## Required topology

```text
Android app -- TLS --> agents.myplanee.com -- Cloudflare Tunnel --> 127.0.0.1:8787 Hub
```

Cloudflare Tunnel remains outbound-only. Hub, OpenCode, and GJC are never public-bound or router-forwarded. The Hub listener is the literal `127.0.0.1:8787`.
Cloudflare Access JWT verification is not present in the current Hub implementation or deployment plist. The repository cannot establish the current Cloudflare Access application, policy, MFA, App Launcher, Tunnel, or DNS control-plane state; verify those externally before treating a cutover as complete.

## Root secret and local administration

Use Model B: create the pairing root secret once in a root-owned `0600` file containing exactly 32 random bytes. The deployment plist configures `HUB_PAIRING_ROOT_SECRET_FILE`, `HUB_OWNER_ID`, and `HUB_WEB_ROOT`; use the same values when running the local administration CLI. Do not put the file contents in an environment variable, SQLite, source control, logs, or documentation.

Generate a code only on the Mac hosting the Hub:

```sh
sudo env \
  HUB_DATABASE_PATH=/var/db/planee-agent-hub/hub.sqlite \
  HUB_OWNER_ID=planee \
  HUB_PAIRING_ROOT_SECRET_FILE=/var/db/planee-agent-hub/pairing-root-secret \
  /Users/planee/.bun/bin/bun --cwd apps/hub run admin -- create-pairing
sudo env \
  HUB_DATABASE_PATH=/var/db/planee-agent-hub/hub.sqlite \
  HUB_OWNER_ID=planee \
  HUB_PAIRING_ROOT_SECRET_FILE=/var/db/planee-agent-hub/pairing-root-secret \
  /Users/planee/.bun/bin/bun --cwd apps/hub run admin -- list-devices
sudo env \
  HUB_DATABASE_PATH=/var/db/planee-agent-hub/hub.sqlite \
  HUB_OWNER_ID=planee \
  HUB_PAIRING_ROOT_SECRET_FILE=/var/db/planee-agent-hub/pairing-root-secret \
  /Users/planee/.bun/bin/bun --cwd apps/hub run admin -- revoke-device <device-id>
```

The first command intentionally prints a short-lived one-use code to the local terminal. Do not redirect it to logs or paste it into tickets.

## Verification, cutover, and rollback

Repository-supported checks:

1. A credential-less request to `/api/v1/health` returns `401`; a valid device credential is required for protected APIs.
2. `/api/v1/pairings/redeem` is intentionally unauthenticated for first registration, but accepts only a valid, unexpired, unused pairing code. Do not submit a live code merely as a health check.
3. The Hub binds its listener to literal `127.0.0.1:8787`. Confirm the running process and container port mappings on the host before cutover.
4. The deployment plist uses `system/com.planee.agent-hub`, `/var/db/planee-agent-hub/hub.sqlite`, and `/var/db/planee-agent-hub/pairing-root-secret`; confirm the installed service uses that plist.

Checks requiring external or physical-device evidence remain incomplete until recorded:

1. Pair a physical Android device, restart the app, reconnect its network, revoke it, and re-pair it. It must operate without browser login or MFA and reject the revoked credential.
2. Restart the Tunnel and confirm the paired Android app reconnects.
3. Confirm from a separate client that the public hostname reaches the Hub and anonymous protected API requests return `401` without Hub data.
4. In the Cloudflare control plane, confirm whether `Planee Agent Hub` Access application/policy remains. Before deleting it, confirm App Launcher and organization MFA changes do not affect another Access application.

Do not delete Cloudflare Access merely because the current Hub has no JWT verifier: first complete the external and physical-device checks and retain an executable prior Hub deployment. If rollback is required after Access removal, restore the Access application/policy and the prior Hub deployment that verifies Access JWTs as one change. Never open the hostname without Hub authentication and never add a temporary JWT compatibility path to the current Hub.
