# Spike E — PWA 재연결, heartbeat, backpressure 계측 계약

- 조사일: 2026-07-15
- 범위: ADR-011의 replay-to-live 모델에 필요한 측정 정의와 초기 안전 파라미터를 정한다. Hub runtime/PWA가 아직 없으므로 live traffic, Android 실기기, Cloudflare Tunnel 및 network-throttling 시험은 실행하지 않았다.

## 검증된 근거

| 근거 | 확인 내용 | 등급 |
| --- | --- | --- |
| [MDN: Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) | SSE comment는 keep-alive에 사용할 수 있고, `id`는 EventSource의 last event ID를 설정하며, `retry`는 재연결 대기 시간(ms)이다. 끊긴 EventSource는 기본적으로 재시작된다. | 검증 |
| [Cloudflare WebSockets](https://developers.cloudflare.com/network/websockets/) | 장기 연결은 idle 때 종료될 수 있으며 keepalive가 권장된다. Cloudflare edge 배포도 connection을 종료할 수 있다. | 검증 |
| [승인 계획 §7.1](../../.gjc/_session-019f6549-0ecd-7000-9041-95a2c3b971d8/plans/ralplan/019f6549-0ecd-7000-9041-95a2c3b971d8/pending-approval.md#71-replay-to-live-원자적-전환-프로토콜-adr-011-최종) | connection construction에 유일한 sender spawn 지점을 두고, `publishMutex`에서 registration/publish/gate-open/pop/disconnect를 선형화한다. DB read와 `send()`는 lock 밖에서 수행한다. | 검증 |

## 가정 및 비목표

- heartbeat는 **liveness 신호**다. delivery correctness, cursor durability, sender ownership, replay completeness를 증명하지 않는다. correctness는 SQLite commit 후 publish, monotonic `seq`, cursor catch-up, snapshot-reset으로 보장한다.
- 아래 값은 구현 전의 보수적 초기값이다. 실측 p99와 overflow 시나리오로 ADR-011의 최종값을 확정해야 하며, 값만으로 phase gate를 통과했다고 주장하지 않는다.
- SSE를 기본 transport로 유지한다. WebSocket은 별도 채택 결정 없이는 만들지 않는다. NanoClaw를 시작하거나 host launchd로 관리하지 않는다.

## 초기 파라미터 권고

| 항목 | 초기값 | 정확한 의미 및 수렴 동작 |
| --- | ---: | --- |
| heartbeat interval | 25 s | server가 유휴 SSE stream에 `: hb <server-monotonic-ms>\n\n` comment를 기록하는 주기. business event와 별도이며 client가 수신 여부를 metric으로 보고한다. 25 s는 측정 출발값이지 provider timeout 보장은 아니다. |
| heartbeat miss threshold | 3 intervals (75 s) | client는 마지막 byte 수신 후 75 s가 지나면 stream을 close하고 cursor로 재연결한다. background/sleep 중 timer 지연은 실패가 아니라 재개 시 reconnect 사유다. |
| queue N | 256 events/connection | gate 상태와 무관한 미전송 FIFO 항목 수 상한. append 뒤 `len > 256`이면 해당 connection을 disconnect하고 listener에서 제거한 뒤 client가 snapshot-reset/catch-up 한다. producer를 block하지 않는다. |
| queue T | 30 s | FIFO head가 최초 enqueue된 뒤 아직 성공적으로 send되지 않은 최대 residence time. `now - head.enqueuedMonotonicMs > 30_000`이면 N과 동일하게 disconnect + snapshot-reset한다. 실제 send latency는 별도 histogram이다. |
| `publishMutex` hold target | p99 < 2 ms; max < 10 ms | lock acquisition부터 release까지의 monotonic duration이다. registration, publish fanout append, gate transition, empty-check/wait-arm, pop, disconnect cleanup만 포함한다. DB read, serialization가 아닌 payload 생성, `await send()`, network I/O는 포함하거나 lock 안에서 실행하면 안 된다. |
| sender active count | 0 또는 1 | connection-id별 construction부터 disconnect cleanup 완료까지 살아 있는 `senderTask` 수. 2 이상은 즉시 invariant violation이며 connection을 close하고 error/audit metric을 남긴다. |

## 측정 계약

### 공통 event/metric labels

`connectionId`(opaque), `seq`, `phase`(`replay|live`), `gate`(`CLOSED|OPEN`), `sampledAtMonotonicMs`, `transport`, `outcome`만 사용한다. prompt, transcript, token, host path, secret, raw payload는 metric/log label 또는 trace에 넣지 않는다.

### Heartbeat 및 reconnect

- `heartbeat_sent_total`, `heartbeat_received_total`, `heartbeat_last_byte_age_ms`, `reconnect_attempt_total{reason}`, `reconnect_to_first_event_ms`, `catchup_events_total`, `snapshot_reset_total`을 기록한다.
- 수신 client는 마지막 처리한 durable `seq`를 IndexedDB에 commit한 후에만 cursor로 사용한다. duplicate `seq`는 방어적으로 무시하고 gap/410은 snapshot-reset으로 처리한다.
- Phase 1 시험: foreground/background 전환, offline/online, server connection close, Tunnel 단절/복구를 각각 최소 1,000회 논리 반복(실기기·Tunnel은 별도 환경에서)하여 cursor gap, duplicate, reset을 확인한다. 아직 실행하지 않았다.

### Queue N/T 및 backpressure

- 매 append/pop에서 `queue_depth`, `queue_head_age_ms`, `queue_overflow_total{limit="N|T"}`, `connection_closed_total{reason}`를 기록한다.
- overflow 판정은 `publishMutex` 안에서 queue mutation과 동일한 선형화 지점에서 하고, close/network I/O는 lock 밖에서 실행한다. N/T 초과 시 event를 조용히 drop하거나 sender를 추가 생성하지 않는다.
- 합격 기준: 느린 consumer에서 producer의 journal commit이 blocking되지 않고, N 또는 T 초과 connection은 하나의 snapshot-reset 경로로 수렴한다.

### `publishMutex`

- 모든 lock 획득에 `mutex_wait_ms`와 `mutex_hold_ms` histogram(p50/p95/p99/max)을 기록한다. publish에는 `fanout_count`, registration에는 `registration_to_gate_open_ms`도 기록한다.
- 독립 검증: static check로 lock scope 내 `send`, `await`, HTTP/SSE write, DB read를 금지하고, runtime test에서 artificial slow send를 주입해도 `mutex_hold_ms`가 network delay를 포함하지 않는지 확인한다.
- 초기 경보: p99가 2 ms 이상인 5분 window 또는 max가 10 ms 초과이면 경보·원인 trace를 생성한다. 이는 fail-open하지 않으며, N/T 결과와 함께 값 조정 근거가 된다.

### construction-time exactly-one sender

- `sender_created_total{connectionId}`, `sender_active_gauge{connectionId}`, `sender_exit_total{connectionId,reason}`, `sender_generation`을 기록한다. construction에서 generation=1을 단 한 번 만들고, disconnect 전 재생성은 금지한다.
- runtime assertion: 생성 직후와 sender loop의 각 iteration에서 active count가 1인지 확인하고, cleanup 후 0인지 확인한다. 2 이상 또는 generation != 1은 즉시 invariant violation이다.
- Phase 1 race harness: subscribe/register, publish, replay completion, disconnect, slow/failing send를 무작위 interleaving으로 최소 10,000회 실행한다. 각 run에서 sender count 0/1, gate `CLOSED→OPEN` 1회 이하, wire `seq` strictly increasing, concurrent send 0, CLOSED 기간 enqueue 항목의 eventual send 또는 documented disconnect/reset을 확인한다. 아직 실행하지 않았다.

## Deferred physical/network tests

- Android Chrome 실기기에서 sleep/doze, background 제한, permission revoke, network handoff, app force-stop 후의 reconnect/Push 동작은 미실행이다.
- Cloudflare Tunnel과 실제 Access 경유 SSE의 idle/disconnect distribution도 미실행이다. 25 s heartbeat를 해당 환경에서 24시간 관찰한 뒤 p99 last-byte age와 reconnect 빈도로 재조정한다.

## Hard-gate 판정

**BLOCK (ADR-011 파라미터 확정 및 Phase 1 protocol gate).** 초기값과 측정 계약은 구현에 사용할 수 있으나, runtime·PWA·Tunnel·실기기에서 N/T overflow, mutex bound, 0/1 sender invariant, reconnect/cursor 시험의 증거가 없다. Phase 1 진입 후 위 harness와 환경 시험을 통과하기 전에는 파라미터를 확정하거나 delivery 보장을 주장하지 않는다.
