# Spike B — GJC Coordinator MCP 제어면

- 조사일: 2026-07-15
- 범위: 설치/가용 버전, coordinator tool discovery, `watch_events`/`read_turn`/`list_questions`/`stop_session`, 원격 idempotency와 correlation.
- 안전 경계: coordinator server, tmux session, provider, NanoClaw, host daemon을 시작하지 않았다. `--check`은 계약 metadata 검사만 수행했다.

## 근거와 재현 명령

| 등급 | 명령/출처 | 관찰 또는 계약 |
|---|---|---|
| 검증 | `gjc --version` | 설치된 GJC는 `gjc/0.10.2`이다. |
| 검증 | `GJC_COORDINATOR_MCP_WORKDIR_ROOTS="$PWD" gjc mcp-serve coordinator --check --json` | `ok: true`, server name `gjc-coordinator-mcp`, protocol version `2024-11-05`, `readOnly: true`를 반환했다. |
| 검증 | 같은 `--check` output | `gjc_coordinator_watch_events`, `gjc_coordinator_read_turn`, `gjc_coordinator_list_questions`, `gjc_coordinator_stop_session` 및 session/turn/question/report tool이 discovery 목록에 있다. |
| 검증 | [GJC bot integration guide](https://github.com/Yeachan-Heo/gajae-code/blob/main/docs/bot-integration.md) | Coordinator MCP가 권장 orchestration surface이고 workdir allowlist, startup mutation opt-in, per-call `allow_mutation: true`의 fail-closed gate를 가진다. |
| 검증 | [GJC external-control readiness](https://github.com/Yeachan-Heo/gajae-code/blob/main/docs/external-control-readiness.md) | Coordinator MCP는 preferred multi-session control plane이며 `--check --json`은 provider-independent smoke다. |

재현한 read-only 명령:

```sh
gjc --version
GJC_COORDINATOR_MCP_WORKDIR_ROOTS="$PWD" gjc mcp-serve coordinator --check --json
```

관찰된 tool 목록에는 다음이 포함됐다.

```text
gjc_coordinator_watch_events
gjc_coordinator_read_turn
gjc_coordinator_list_questions
gjc_coordinator_stop_session
```

## 계약 결과

| 항목 | 상태 | 근거/결론 |
|---|---|---|
| `watch_events` | 검증(발견)/deferred(전달 semantics) | tool이 설치된 `--check` discovery에 존재한다. 문서는 watch/poll로 turn state를 관찰하라고 한다. cursor, replay, ordering, disconnect recovery는 이 probe와 공개 문서만으로 확인되지 않았다. |
| `read_turn` | 검증 | 공식 문서는 polling 및 completed turn read 용도로 명시한다. 예시 input은 `session_id`, `turn_id`, `timeout_ms`, `poll_interval_ms`, `lines`이며 terminal status는 `completed`, `failed`, `cancelled`, `superseded`다. |
| `list_questions` | 검증 | tool이 discovery에 존재하고, 공식 문서는 pending structured question을 `session_id`, `status: "pending"`으로 list한 후 advertised shape으로 답하도록 한다. |
| `stop_session` | 검증 | tool이 discovery에 존재한다. 공식 문서상 coordinator-managed session만 owner-proof tmux shutdown으로 종료하며 pane pid, native session id, owner generation, server key, process start time을 검증한다. active turn은 explicit force 없이는 거부한다. |
| mutation gate | 검증 | `start_session`, `send_prompt`, question submit, report, stop은 mutating tool이다. startup mutation opt-in과 call의 `allow_mutation: true`가 모두 없으면 fail closed다. 이 spike의 `--check`은 `readOnly: true`였다. |
| remote idempotency key | 이용 불가(공개 계약) | 공식 start/send/stop/question schemas와 guide에는 caller-provided idempotency key 또는 duplicate delivery dedup contract가 없다. local control plane은 이를 지원한다고 가정할 수 없다. |
| correlation ID | 부분검증 | `start_session` 결과의 `session.session_id`와 prompt delivery의 `turn_id`는 공식 문서에 명시되어 추적 correlation에 사용할 수 있다. 외부 caller correlation ID를 수용·echo하는 계약은 확인되지 않았다. |

## 결론

GJC adapter의 1차 surface는 Coordinator MCP다. `watch_events`는 가속 신호로 사용하고, `read_turn` 및 `list_questions`로 snapshot/poll fallback을 둔다. `stop_session`은 owner-proof된 mutation이지만 remote operation이므로 local command idempotency와 audit record를 먼저 남긴다.

원격 idempotency key contract가 확인되지 않았으므로 `send_prompt`, question answer, `stop_session`에서 timeout/connection-loss처럼 결과가 모호한 경우 자동 재시도하지 않는다. 해당 command는 `unknown`으로 격리하고, durable local `command_id`, `session_id`, `turn_id`와 caller correlation 값을 별도로 저장한다. `turn_id`는 원격 결과가 성공적으로 반환된 뒤에만 remote correlation으로 연결한다.

## 미확정 사항 및 deferred runtime 검증

1. 격리된 temporary state root에서 tool schema snapshot을 capture하여 `watch_events`, `read_turn`, `list_questions`, `stop_session`의 exact input/output을 고정한다.
2. mocked session lifecycle에서 watch event ordering, reconnect/replay/cursor, terminal delivery 중복 여부를 확인한다.
3. mutation-disabled, missing `allow_mutation`, invalid workdir, active-turn stop(no force), forced stop의 fail-closed responses를 확인한다.
4. 동일 caller command를 재전송해 coordinator가 idempotency key를 수용/echo하는지 확인한다. 현재 공개 계약은 없으므로 지원되지 않으면 no-retry policy를 유지한다.
5. caller correlation 값을 전달할 공식 field가 있는지 schema로 확인한다. 없다면 adapter-local mapping만 사용한다.

이 항목들은 live session 또는 mutation을 요구하므로 이번 read-only spike에서는 모두 **deferred**다. provider/model 또는 tmux 기반 runtime 성공을 주장하지 않는다.

## Gate B 판정

**조건부 통과 (remote mutation은 no-retry).** 설치된 `gjc/0.10.2`에서 coordinator contract check와 요구 tool discovery가 성공했고, 공식 문서가 Coordinator MCP를 권장 surface로 규정한다. 다만 event replay semantics와 external idempotency/correlation contract는 검증되지 않았다. Phase 1은 local idempotency + `unknown` 격리 + `session_id`/`turn_id` correlation만 전제로 진행하며, runtime schema/lifecycle fixture 완료 전 원격 exactly-once를 주장하지 않는다.
