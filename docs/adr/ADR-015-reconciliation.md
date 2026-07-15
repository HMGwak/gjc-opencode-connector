# ADR-015 — Reconciliation 정확성 계약과 Degrade 모드

## 상태

Accepted for implementation; backend capability rows remain Phase 0 evidence gates.

## Decision

SQLite journal을 로컬 권위로 사용하되 재연결 시 backend snapshot과 대조한다. stable remote ID, revision, terminal state, tombstone, watermark 또는 fencing 정보가 부족하면 복원하지 못한 사실을 숨기지 않고 세션을 `stale` 또는 `unknown`으로 표시한다. 이 상태에서는 mutation을 거부한다.

Reconciliation은 adapter별 single writer와 epoch를 사용한다. 새 epoch가 시작되면 이전 epoch의 관측 결과는 적용하지 않는다. 정상 결과에만 `reconciled: true`를 기록한다.

## Drivers

- OpenCode SSE cursor/replay 보장 부재
- GJC watch stream 재연결 계약 미확정
- 중복 mutation보다 명시적 운영자 확인을 우선하는 fail-closed 정책

## Alternatives considered

- snapshot을 완전한 event replay로 간주: 중간 message, 삭제, 순서를 복원할 수 없어 기각.
- 불명확한 상태에서도 mutation 허용: 중복·오작동 위험으로 기각.
- terminal 상태만 동기화: 사용자에게 잘못된 최신성을 보여 기각.

## Consequences

일시적으로 읽기 전용 degrade UX가 발생할 수 있다. adapter capability fixture와 reconciliation 결과에 근거 등급이 필요하다. 운영자는 `unknown`을 확인하고 명시적으로 해소해야 한다.

## Verification

각 adapter fixture에 stable ID, revision, terminal state, tombstone, watermark, fencing 지원 여부를 기록한다. 다음 crash 지점을 통합 테스트한다.

1. 원격 호출 전
2. 원격 호출 후, 로컬 commit 전
3. 로컬 commit 후, 응답 전
4. reconciliation commit 중 재시작

중간 event가 snapshot으로 복원 불가능한 fixture에서는 `reconciled: true`가 설정되지 않고 mutation이 거부되어야 한다.

## Follow-ups

Spike A/B runtime fixture로 capability table을 채우고, 지원되지 않는 항목은 명시적으로 `unavailable`로 고정한다.
