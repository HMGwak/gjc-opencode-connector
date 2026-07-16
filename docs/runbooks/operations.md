# Operations Runbook

## Service boundaries and port table

| Component | Runtime | Listener / transport | Required boundary |
|---|---|---|---|
| Planee hub (`planee serve`) | host | `127.0.0.1:8787` | Cloudflare Tunnel is the only external ingress; no public bind or port forwarding. |
| cloudflared | separately managed host unit | outbound-only Tunnel connection | It forwards only to the loopback hub origin; the Hub enforces device credentials. |
| OpenCode | host | loopback-only server port selected by the operator | Run as `opencode serve --hostname 127.0.0.1`; never public-bind it. |
| GJC Coordinator | host | MCP stdio/local coordinator transport | Require `GJC_COORDINATOR_MCP_WORKDIR_ROOTS` allowlist; use Coordinator MCP, not Bridge HTTPS. |
| NanoClaw | Docker only | explicitly approved Docker publish rules only | Never host-start it, create a launchd unit for it, or share hub image/volume/environment/unit. |

Read-only boundary checks:

```sh
lsof -nP -iTCP:8787 -sTCP:LISTEN
docker ps --format '{{.Names}} {{.Ports}}'
```

Fail closed when the hub listener is not `127.0.0.1:8787`, port `8787` is Docker-published, or NanoClaw has an unapproved publish. Do not use these checks to start NanoClaw; all NanoClaw lifecycle actions remain Docker-only and follow its separately approved Docker configuration.

## Health, metrics, and alert response

The authenticated loopback health probe is intentionally minimal:

```sh
curl --fail --silent --show-error -H "Authorization: Bearer <device-credential>" http://127.0.0.1:8787/api/v1/health
```

Probe the externally reachable hostname only with an enrolled test device or a credential-aware monitor; never log its credential. Configure that monitor to alert when it cannot observe the expected health response within **5 minutes**. Record monitor incident timestamps; the monitor is an independent signal, not authority for data correctness.

Alert and investigate at least these signals:

| Signal | Alert condition | Immediate safe response |
|---|---|---|
| Hub / adapter health | probe failure, adapter unhealthy, or stale health beyond the observed budget | Preserve logs/metrics; verify loopback health and adapter reconciliation; do not bypass device authentication. |
| Tunnel | disconnected or unable to reach loopback origin | Check cloudflared unit status and origin listener; retain outbound-only Tunnel and loopback origin. |
| Heartbeat | expected heartbeat missing beyond the measured reconnect budget | Treat as liveness loss only; reconnect/reconcile from the SQLite journal rather than assuming event correctness. |
| SQLite / WAL | sustained WAL growth, checkpoint remains busy, or low disk space | Follow `backup-restore.md`; do not remove WAL files. |
| `publishMutex` | p99/maximum hold time exceeds the measured Spike E budget | Inspect lock instrumentation; network I/O inside the lock is a defect. |
| Queue / sends | queue growth, wake delay, send failures, or overflow | Preserve evidence; disconnect/reset per protocol and reconcile. Do not create another sender. |
| Active sender count | any connection has `sender_active_gauge > 1` | Invariant violation: close the affected connection, emit error/audit metric without secrets, and investigate before recovery. Counts may otherwise only be 0 or 1. |
| Audit secret scan | any suspected secret pattern or raw credential field | Restrict access, rotate through the secret manager, preserve minimal evidence, and remove the leaking field from logs/metrics/audit. Never paste a secret into an incident. |

Metrics and audit records must contain identifiers and classifications, not request authorization headers, cookies, JWTs, provider keys, VAPID private keys, database connection strings with credentials, or raw sensitive payloads. Scan exported audit material only in an access-controlled environment and report matches by record ID/field name/redacted fingerprint, not by value.

## Incident and recovery state

1. Open an incident and preserve UTC timestamps, health result, adapter state, tunnel state, database/WAL measurements, and relevant non-secret metrics.
2. The Coordinator and durable SQLite journal are authoritative. Notifications, heartbeat, and external uptime are hints/liveness signals; none may authorize a mutation or overwrite reconciliation state.
3. For adapter uncertainty, run reconciliation. Mark sessions `stale` or `unknown` when the remote state cannot be proven; reject mutations for those sessions.
4. For a command whose remote outcome is ambiguous, keep it `unknown`. Do not automatically retry, infer success/failure, or issue a second mutation. Resolve only after operator verification through the adapter's authoritative control plane.
5. For Tunnel failure, restore the separately managed outbound Tunnel only after the loopback origin is healthy. Never expose the hub or adapters directly to the internet as a workaround.
6. For database corruption, disk exhaustion, or restore need, use the isolated drill in `backup-restore.md`. Production cutover requires explicit approval; automatic rollback is prohibited.
7. Declare recovery only after health, adapter reconciliation, external monitor recovery, WAL condition, sender invariant, and audit secret scan are all recorded as healthy.

## Degraded operation

Degraded mode is read-only: show `stale`/`unknown`, refuse mutations, and retain local journal evidence. Do not downgrade device authentication, CSRF checks, workdir allowlists, or Docker-only NanoClaw isolation to regain availability. If evidence is insufficient to determine state, remain `unknown` and escalate.
