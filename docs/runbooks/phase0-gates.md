# Phase 0 Gate 1–5 판정 Runbook

- 근거: `.gjc/_session-019f6549-0ecd-7000-9041-95a2c3b971d8/plans/ralplan/019f6549-0ecd-7000-9041-95a2c3b971d8/pending-approval.md` §9, §12, §16
- 원칙: 각 Gate는 증거 문서와 재현 절차가 있을 때만 통과다. 미실행 재부팅·네트워크·모바일 시험은 **deferred**로 기록하며 통과로 취급하지 않는다.

## 공통 판정 절차

1. Spike별 문서에 실행일, 도구/adapter 버전, 입력, 재현 가능한 읽기 전용 또는 테스트 명령, 관측 결과, 실패/제한을 기록한다.
2. 외부 제품의 사실은 1차 문서 URL 또는 재현 가능한 명령 출력으로 뒷받침한다. 추정은 `가정`으로 표시한다.
3. Gate 결과는 `PASS`, `FAIL`, `DEFERRED` 중 하나로 기록한다. `DEFERRED`와 `FAIL`은 Phase 1 진입을 막는다.
4. 보안 통제, remote idempotency, replay/gate 불변식 중 하나라도 증명하지 못하면 fail closed 한다.

## Gate 1 — Spike A: OpenCode

**통과 조건**

- OpenCode 버전과 OpenAPI snapshot을 `packages/testkit`에 고정한다.
- restart/recovery, cursor 유무, permission 매핑, snapshot diff 한계를 관찰한다.
- `prompt_async`의 실제 응답을 기록한다. 공식 기본 계약은 `204 No Content`이며, `202` 기록은 실측 증거가 있을 때만 허용한다.
- mutation별 remote idempotency/correlation 지원·조회 가능 여부를 ADR-013 capability table에 제공한다.

**실패 처리:** cursor/recovery 또는 mutation 불확실성을 정상 동작으로 가정하지 않는다. 해당 동작은 reconciliation 또는 `no-retry/unknown`으로 제한하고 ADR-013/015 갱신 없이는 통과시키지 않는다.

## Gate 2 — Spike B: GJC Coordinator

**통과 조건**

- Coordinator tool 버전과 MCP tool snapshot을 `packages/testkit`에 고정한다.
- `watch_events` 안정성과 `read_turn`/`list_questions` fallback을 관찰한다.
- `stop_session`의 owner-proof abort 매핑과 workdir allowlist 경계를 확인한다.
- 각 mutation의 remote idempotency/correlation 지원 표를 ADR-013에 제공한다.

**실패 처리:** Bridge HTTPS를 대체 경로로 채택하지 않는다. 지원이 불명확한 mutation은 `unknown` 격리 및 no-retry로 제한한다.

## Gate 3 — Spike C: GJC Notifications

**통과 조건**

- Notifications SDK 원문을 clone 또는 1차 소스에서 확인하고 버전·API·제약을 기록한다.
- Phase 4 보조 채널 포함 여부를 명시적으로 결정한다.

**실패 처리:** 원문/API를 확인하지 못하면 Notifications SDK는 Phase 4 범위에서 제외하고 `DEFERRED`로 기록한다. README 요약만으로 통과시키지 않는다.

## Gate 4 — Spike D: macOS Runtime 및 secret 모델

**통과 조건**

- 모델 A는 자동 로그인을 활성화한 실제 재부팅에서 LaunchAgent/Keychain 접근을 독립 검증한다.
- 모델 B는 비로그인 실제 재부팅에서 LaunchDaemon/non-user secret store를 독립 검증한다.
- 증거를 바탕으로 ADR-014에 단 하나의 운영 모델을 확정하고 외부 uptime monitor의 5분 이내 감지 절차를 기록한다.

**실패 처리:** 실제 재부팅을 수행하지 못하면 `DEFERRED`다. production launchd plist는 ADR-014 확정 전 만들거나 커밋하지 않는다.

## Gate 5 — Spike E: PWA reconnect 및 sender

**통과 조건**

- 실제 reconnect 조건에서 heartbeat 주기, 큐 N/T 상한, `publishMutex` 보유 시간 및 `send()` 완료 정의를 실측한다.
- 연결당 활성 sender 인스턴스가 항상 0 또는 1임을 계측한다.
- replay-to-live 경쟁을 수천 회 수행해 no-gap, `CLOSED→OPEN` 단조 1회, CLOSED 중 enqueue, seq wire order, wake 유실 없음, single-flight, 양 gate 상태에서 disconnect 우선을 증명한다.
- overflow가 snapshot-reset으로 수렴하고 cursor 만료가 `410`인지 검증한다.

**실패 처리:** sender가 2 이상이거나 누락/역전/재시도가 관측되면 `FAIL`이다. parameter 미측정은 `DEFERRED`이며 ADR-011 파라미터를 임의 확정하지 않는다.

## Phase 0 종료 기준

Spike A–E 문서, ADR-011~ADR-015 확정본, Gate 1–5 판정 초안이 모두 있어야 한다. 어느 하나라도 `FAIL` 또는 `DEFERRED`이면 Phase 1에 진입하지 않는다.
