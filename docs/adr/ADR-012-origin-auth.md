# ADR-012 — Origin Authentication Boundary

## Status

Superseded by ADR-018 for personal device authentication.

## Decision

The origin validates an opaque per-device bearer credential on every protected API request. The pairing exchange is one-use, short-lived, and public only for credential registration; it does not reveal the pairing root secret. Missing, malformed, revoked, or unknown credentials return `401`; authenticated requests outside the owner/session boundary return `403`.

Cloudflare Tunnel remains a transport boundary, not an authentication authority. The origin does not verify Cloudflare issuer, audience, JWKS, or Access JWTs and does not accept them as a compatibility fallback.

## Consequences

- Device credential verifiers, not credential plaintext, persist in SQLite.
- Audit records contain device identifiers and result classifications only.
- The Android app uses Android Keystore-backed storage and returns to pairing after authorization failure.
- Loopback-only binding and CSRF origin checks remain required.
