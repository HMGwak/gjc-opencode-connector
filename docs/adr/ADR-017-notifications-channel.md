# ADR-017 — Notifications 채널은 선택적 Hint로 한정

## 상태

Accepted for Phase 4 implementation. Android physical-device validation remains pending and is a release gate for Android Web Push availability.

## Context

Hub의 SQLite session/event journal과 인증된 session API가 상태의 권위다. Push delivery는 플랫폼 권한, background lifecycle, network, provider의 subscription 수명에 따라 지연·중복·손실될 수 있다. 따라서 notification을 상태 동기화, command 확인, retry 결정, session 권한의 입력으로 사용하면 correctness를 보장할 수 없다.

Spike C는 GJC의 공개 문서에서 Coordinator MCP 및 opt-in lifecycle notifier의 계약은 확인했지만, 별도 `GJC Notifications SDK`의 버전 고정 가능한 공식 API, delivery/retry 계약, secret 취급을 확인하지 못했다. NanoClaw는 Docker-only 정책상 이 결정의 notifier 또는 runtime dependency가 아니다.

## Decision

1. Web Push는 VAPID를 사용하되 optional, best-effort hint channel로만 운영한다. SQLite journal, session API, SSE catch-up/reconnect가 권위 상태와 복구 경로다.
2. backend는 GJC Coordinator MCP terminal status 또는 공개 `turn_end`/`agent_end`만 관찰할 수 있다. 발송 payload는 `eventType`, `occurredAt`, opaque `sessionId`, same-origin allowlisted relative deep link의 최소 메타데이터로 제한한다.
3. VAPID private key는 injected secret provider에서 backend runtime에만 제공한다. source, client bundle, log, artifact, test fixture 및 문서에는 저장하지 않는다. 키가 없거나 불일치하면 sender를 disabled로 하고 push를 fail closed한다.
4. subscription은 인증된 owner-scoped record이며 revocable이다. replacement는 같은 owner의 새 record로 교체하고 이전 record를 폐기한다. user revoke와 provider `404`/`410`은 즉시 발송 대상에서 제외한다.
5. notification tap은 same-origin allowlisted deep link만 열며 normal authentication과 server-side authorization을 다시 수행한다.
6. **GJC Notifications는 primary source contract가 검증될 때까지 optional hint channel로만 취급한다.** 검증되지 않은 SDK는 Phase 4 의존성 또는 권위 경로에 포함하지 않는다. Bridge HTTPS는 대체 notifier 경로로 채택하지 않는다.

## Consequences

- 사용자는 push를 놓치거나 늦게 받아도 앱을 열어 권위 API/SSE로 정확한 상태를 회복한다.
- permission denied, unsupported browser, force-stop, Doze, token churn, sender/key failure는 push 기능 저하이지 session correctness 실패가 아니다.
- Android Chrome 설치/permission/force-stop/Doze/token replacement/revocation/tap reauthentication은 실기기 QA를 완료하기 전까지 release gate를 통과할 수 없다.
- GJC Notifications SDK를 도입하려면 공식 1차 source/API, 버전·지원 수명, event semantics, duplicate/retry, authentication/authorization, secret/payload 제한을 별도 spike에서 검증하고 이 ADR을 갱신해야 한다.

## Alternatives considered

- GJC Notifications SDK를 Phase 4의 primary notification path로 채택: 공식 primary-source 계약이 확인되지 않아 기각.
- Push delivery를 session state 또는 command completion의 증거로 사용: at-least/at-most-once와 순서가 보장되지 않아 기각.
- Bridge HTTPS를 notifier fallback으로 사용: experimental surface이며 기본 lifecycle 제어면으로 쓰지 않는 정책에 따라 기각.
- NanoClaw host runtime/launchd notifier를 추가: Docker-only 경계를 침해하고 범위 밖이므로 기각.

## Verification

`artifacts/g004-manual-qa-checklist.json`의 물리 기기 행은 현재 모두 `PENDING`; 결과를 추정하거나 automation으로 대체하지 않는다. `docs/runbooks/web-push.md`는 key rotation, owner-scoped revoke, Android Chrome 실기기 절차와 browser automation 경계를 정의한다.
