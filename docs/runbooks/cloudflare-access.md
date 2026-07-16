# Personal Device Pairing and Cloudflare Tunnel Runbook

## Required topology

```text
Android app -- TLS --> agents.myplanee.com -- Cloudflare Tunnel --> 127.0.0.1:8787 Hub
```

Cloudflare Tunnel remains outbound-only. Hub, OpenCode, and GJC are never public-bound or router-forwarded. The Hub listener is the literal `127.0.0.1:8787`.

## Root secret and local administration

Use Model B: create the pairing root secret once in a root-owned `0600` file containing exactly 32 random bytes. Run the Hub as the selected system service with `HUB_PAIRING_ROOT_SECRET_FILE` pointing to that file, `HUB_OWNER_ID` matching the owner of existing Hub sessions, and `HUB_WEB_ROOT` pointing to the built `apps/web/dist` directory. Do not put the file contents in an environment variable, SQLite, source control, logs, or documentation.

Generate a code only on the Mac hosting the Hub:

```sh
sudo -E bun --cwd apps/hub run admin -- create-pairing
sudo -E bun --cwd apps/hub run admin -- list-devices
sudo -E bun --cwd apps/hub run admin -- revoke-device <device-id>
```

The first command intentionally prints a short-lived one-use code to the local terminal. Do not redirect it to logs or paste it into tickets.

## Verification and cutover

1. From a separate client, anonymous `curl` to a protected Hub API must return `401` or `403` and no Hub data.
2. Pair a physical Android device, restart the app, and reconnect its network. It must operate without browser login or MFA.
3. Revoke the device locally and verify its next API request is rejected. Re-pair it and verify recovery.
4. Verify `lsof -nP -iTCP:8787 -sTCP:LISTEN` shows only `127.0.0.1:8787` and `docker ps --format '{{.Names}} {{.Ports}}'` shows no Hub port publish.
5. Restart the Tunnel and confirm the paired Android app reconnects.
6. Only after these checks, delete the `Planee Agent Hub` Cloudflare Access application and policy. Before changing organization MFA or App Launcher, verify they protect no other Access application.

If any step fails, keep or restore Cloudflare Access while diagnosing. Never open the hostname without Hub authentication and never create a temporary JWT compatibility path.
