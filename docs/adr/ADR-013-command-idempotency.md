# ADR-013: Command 원격 Idempotency와 Unknown 격리

- 상태: 채택(원격 지원 표 확정 전)
- 결정 출처: `.gjc/_session-019f6549-0ecd-7000-9041-95a2c3b971d8/plans/ralplan/019f6549-0ecd-7000-9041-95a2c3b971d8/pending-approval.md` §5.0, §7.2, §12, §20

## Decision

모든 command mutation은 로컬 idempotency key와 원격 correlation ID를 기록한다. 상태 전이는 다음으로 제한한다.

`accepted → dispatching(attempt, lease) → remote-confirmed → applied | failed`

원격 제어면이 idempotency key 및 correlation ID 조회를 지원하는 mutation만, 확인 가능한 원격 결과에 근거해 복구한다. 원격 지원이 없거나 timeout/crash로 원격 실행 여부가 모호하면 자동 재시도를 금지하고 즉시 `unknown`으로 격리한다. `unknown`은 운영자 확인 전 성공·실패 어느 쪽으로도 추정하지 않으며 추가 mutation을 발행하지 않는다.

동일 로컬 idempotency key의 중복 요청은 같은 command 기록을 반환하거나 명시적 충돌 응답을 반환해야 하며, 새 원격 호출을 만들면 안 된다. lease 만료는 새 호출의 근거가 아니며 원격 확인 절차의 시작 조건일 뿐이다.

## Drivers

- DB commit과 원격 호출 사이의 crash, 원격 호출 후 local commit 전 crash, timeout은 로컬 key만으로 원격 중복 실행을 막을 수 없다.
- OpenCode와 GJC의 원격 idempotency/correlation 지원 여부는 아직 Spike로 확인해야 한다.
- 조용한 재시도보다 명시적 불확실성과 운영자 판단이 안전하다.

## Alternatives

- 로컬 idempotency key만 사용: 원격 부작용 중복 위험을 남기므로 채택하지 않는다.
- timeout/crash 후 자동 재시도: 원격 실행 여부를 알 수 없을 때 at-most-once를 위반할 수 있어 채택하지 않는다.
- unknown을 성공 또는 실패로 추정: 실제 상태를 은폐하므로 채택하지 않는다.

## Consequences

- 일부 mutation은 자동 복구되지 않고 운영자 확인이 필요하다.
- command 저장소는 attempt, lease, local key, correlation ID, 전이 사유와 secret-free audit 정보를 보존해야 한다.
- adapter별 capability table 없이는 원격 재시도 정책을 활성화할 수 없다.

## Follow-ups

- **Spike A/B 증거 필요:** OpenCode와 GJC의 각 mutation별 idempotency key 수용, correlation ID 반환, 상태 조회, timeout 의미를 버전·API/MCP snapshot과 함께 표로 기록한다.
- 지원하지 않는 mutation은 capability table에 `no-retry/unknown`으로 명시하고 Phase 1 진입 전 검토한다.
- reconciliation의 crash 4시점(원격 호출 전/후, local commit 전/후) 결과를 ADR-015 계약과 맞춘다.

## Test obligations

- 중복 key가 새 원격 호출을 만들지 않는지와 lease/duplicate 충돌 처리를 검증한다.
- crash 4시점과 모호한 timeout에서 원격 지원 없는 mutation이 재시도 없이 `unknown`으로 격리되는지 검증한다.
- 원격 지원 mutation은 correlation ID 조회 결과가 확인된 경우에만 최종 상태로 전이하는지 검증한다.
- `unknown` command가 자동 적용·실패 처리·추가 mutation을 유발하지 않는지 검증한다.
