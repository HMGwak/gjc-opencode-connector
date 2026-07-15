# ADR-011: Replay-to-Live 원자적 전환

- 상태: 채택
- 결정 출처: `.gjc/_session-019f6549-0ecd-7000-9041-95a2c3b971d8/plans/ralplan/019f6549-0ecd-7000-9041-95a2c3b971d8/pending-approval.md` §7.1, §12, §20

## Decision

각 SSE/WS 연결은 construction 시 단 한 번 생성하는 `senderTask`, 단 하나의 FIFO `queue`, `CLOSED | OPEN` activation gate, `disconnected` 상태를 소유한다.

1. `publishMutex` 안에서 현재 high-water mark를 읽고 listener를 등록하며, queue/gate/disconnected를 초기화한다.
2. mutex 밖의 유일한 spawn 지점에서 해당 연결의 sender를 한 번만 생성한다. 재생성·풀링·idle wake 기반 spawn은 금지한다.
3. sender는 gate가 `CLOSED`인 동안 replay 범위(`lastSeq` 초과, 등록 시 high-water mark 이하)만 순차 전송한다. 이 단계는 queue를 소비하지 않는다.
4. replay 완료 후 mutex 안에서 disconnect를 먼저 확인하고 gate를 정확히 한 번 `CLOSED → OPEN`으로 전이한다. 역전이는 금지한다.
5. `publish`는 commit 이후 mutex 안에서 gate 상태와 무관하게 연결 queue에 append하고 wake를 예약한다.
6. `OPEN` 후에도 같은 sender만 mutex 안에서 queue 비어 있음 확인과 pop을 수행하고, mutex 밖에서 단일 flight로 전송한다. 전송 실패나 disconnect면 listener를 제거하고 종료하며 재시도 또는 sender 재생성은 하지 않는다.

DB 읽기와 모든 네트워크 `send()`는 mutex 밖에서 수행한다. 버퍼 N/T 상한은 Spike E가 정하며 초과 시 연결을 종료하고 snapshot-reset을 요구한다.

## Drivers

- OpenCode/GJC 이벤트 replay 보장이 아직 확정되지 않았다.
- 등록과 publish 사이의 누락, replay/live 경계의 순서 역전, 중복 sender와 wake 유실을 막아야 한다.
- 단일 Mac mini 노드에서 명시적으로 검증 가능한 단순한 단일 sender 모델이 필요하다.

## Alternatives

- DB transaction 또는 DB lock으로 high-water mark와 fanout 등록을 묶기: 네트워크 I/O를 transaction에 넣게 되어 채택하지 않는다.
- 선형화 지점 없는 구독-우선 버퍼: no-gap 불변식을 보장하지 못한다.
- LIVE 이후 직접 전송과 버퍼 전송을 선택하는 이중 경로: stranded event 또는 순서 역전 위험이 있다.
- idle 시 sender를 조건부 재생성: 중복 sender와 wake 경합을 유발하므로 금지한다.

## Consequences

- sender 수명은 connection 수명과 1:1이며 연결마다 생성 비용이 든다.
- gate, queue 길이, wake 지연, sender 활성 수, mutex 보유 시간을 관측해야 한다.
- client dedup은 방어적 backstop일 뿐 서버 정확성의 대체물이 아니다.

## Follow-ups

- **Spike E 증거 필요:** heartbeat 주기, N/T 상한, mutex 보유 시간, `send()` 완료 정의와 연결당 활성 sender 수 0/1을 실측해 파라미터를 확정한다.
- cursor 만료는 `410`과 snapshot-reset으로 처리하고 `Last-Event-ID`와 `after`의 precedence를 계약화한다.
- 다중 프로세스 확장 전에는 분산 동기화 필요성을 재검토한다.

## Test obligations

- spawn 호출 지점이 construction 함수 하나뿐임을 정적 검사한다.
- 등록~publish 사이 누락 0건, gate 단조 전이, CLOSED 구간 enqueue, gate 경계 wire sequence 오름차순을 수천 회 경쟁 테스트로 검증한다.
- CLOSED/OPEN 각각에서 disconnect 우선, single-flight send, 전송 실패 cleanup, wake 유실 없음, overflow→snapshot-reset을 검증한다.
- mutex 임계구역에 DB I/O나 네트워크 I/O가 없음을 정적 검사하고 sender 활성 수가 2 이상이면 실패시킨다.
