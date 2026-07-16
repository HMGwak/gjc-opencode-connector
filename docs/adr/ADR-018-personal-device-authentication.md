# ADR-018 — Personal Device Pairing Authentication

## Status

Accepted for implementation. Physical Android, reboot, Tunnel, and Cloudflare Access-removal verification remain pending.

## Decision

The Hub authenticates Android devices with an opaque, per-device bearer credential instead of Cloudflare Access JWTs.

- A local Hub administrator runs `bun run --cwd apps/hub admin -- create-pairing` to print a one-use pairing code that expires after five minutes. This command reads the Model B pairing root secret locally; that root secret is never sent over HTTP.
- The server stores an HMAC-SHA-256 verifier for pairing codes and a SHA-256 verifier for each 256-bit random device credential. It never stores either raw value.
- Pairing codes are limited to five attempts, have a 15-minute maximum lifetime, are consumed atomically, and emit identifier-only audit events.
- Credentials do not expire during ordinary personal use. Creating a new pairing creates a new credential; the owner may revoke any lost device immediately. A revoked credential fails closed on the next request.
- Android stores the credential only through a Capacitor bridge backed by Android Keystore AES-GCM encryption. It is not placed in localStorage, IndexedDB, web assets, source, or logs. App reinstall removes the encrypted store and therefore requires a new pairing.
- `/api/v1/pairings/redeem` is the only unauthenticated pairing exchange. Every other `/api/v1/*` endpoint requires `Authorization: Bearer <device credential>` and retains owner/session authorization checks.

## Recovery

If the Android Keystore entry is unavailable, the credential is revoked, or the app is reinstalled, the app clears local state and displays the pairing screen. The owner creates a new pairing code locally and may revoke the old device entry. There is no JWT fallback and no unauthenticated mode.

## Consequences

Cloudflare Tunnel remains the only external ingress and the Hub remains bound to `127.0.0.1:8787`. Cloudflare Access can be removed only after the manual checks in the pairing runbook pass. Pairing/device management is intentionally a local CLI rather than a public administrative HTTP API, so the root secret is never transmitted to a public hostname.
