# Cloudflare Access and Tunnel Runbook

## Required topology

```text
Internet -> Cloudflare Access (default deny + MFA) -> Cloudflare Tunnel (outbound only)
         -> http://127.0.0.1:8787 (hub origin)
```

The hub and adapter ports are not public services. The Tunnel originates outbound from the host; do not create inbound firewall/port-forward rules for the hub, OpenCode, or GJC. The Tunnel origin is the literal loopback address `127.0.0.1:8787`, not `localhost` and not a LAN address.

## Access policy

1. Create the Access application for the exact production hostname.
2. Start with a **default deny** policy. Add an explicit allow policy only for the named operator identity/group.
3. Require MFA through the configured identity provider. Do not substitute IP allowlisting, a shared password, or an unauthenticated bypass for MFA.
4. Set short, reviewed session policy appropriate to the operator workflow. Remove departed identities immediately.
5. Keep the origin's JWT validation enabled. Access is an edge control, not a replacement for origin issuer, audience, signature, expiry, and authorization checks.
6. Test access with an authorized MFA-complete identity and an unauthorized identity. Record only outcome/status/time; never record Access tokens, cookies, JWTs, client secrets, or tunnel tokens.

## Tunnel configuration requirements

- Use a separately managed `cloudflared` service/account from the hub. Do not combine it with a NanoClaw lifecycle unit.
- Configure a named hostname service to `http://127.0.0.1:8787` only. Do not configure a wildcard or catch-all ingress that reaches local administrative services.
- The connector makes outbound connections to Cloudflare. No inbound listener, router port-forward, or public bind is permitted for the hub origin.
- Keep credentials in the selected secret store with restrictive access; this document intentionally contains no credentials or token commands.
- Restart ordering is readiness-based: verify hub loopback health first, then verify Tunnel connectivity and external Access-protected health. launchd load order alone is not proof of readiness.

## Verification and failure handling

Run these non-destructive checks from the host:

```sh
curl --fail --silent --show-error http://127.0.0.1:8787/api/v1/health
lsof -nP -iTCP:8787 -sTCP:LISTEN
docker ps --format '{{.Names}} {{.Ports}}'
```

The listener check must show `127.0.0.1:8787` only. The Docker listing must not publish the hub port or show NanoClaw outside its approved Docker publish policy. Verify the public hostname from the external uptime monitor or a browser authenticated through Access; a direct origin bypass is a failure, not an alternate test path.

If Access denies an expected user, correct identity/MFA policy rather than weakening default deny. If the Tunnel is down, restore its outbound connector after loopback health succeeds; do not public-bind the hub. If a loopback listener is absent or on a non-loopback address, stop the rollout and correct the service configuration before exposing the hostname.
