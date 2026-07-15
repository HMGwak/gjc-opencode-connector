# Spike C — GJC Notifications의 Phase 4 포함 여부

- 조사일: 2026-07-15
- 범위: GJC의 외부 알림 표면만 평가한다. NanoClaw는 조사·실행 대상이 아니며 Docker-only 정책을 변경하지 않는다.

## 검증된 근거

| 근거 | 확인 내용 | 등급 |
| --- | --- | --- |
| [GJC 외부 컨트롤러 통합 가이드](https://github.com/Yeachan-Heo/gajae-code/blob/main/docs/bot-integration.md) | 권장 제어면은 Coordinator MCP이며, `gjc_coordinator_watch_events`/`await_turn`/`read_turn`으로 상태를 관찰할 수 있다. | 검증 |
| [같은 가이드의 lifecycle notification 절](https://github.com/Yeachan-Heo/gajae-code/blob/main/docs/bot-integration.md#forward-finishstop-lifecycle-notifications) | 외부 notifier는 opt-in이어야 하고 `turn_end`, `agent_end` 또는 Coordinator의 terminal status만 전달해야 한다. raw prompt·transcript·tool output·token·host path 등은 전달 금지다. | 검증 |
| [같은 가이드의 surface 표](https://github.com/Yeachan-Heo/gajae-code/blob/main/docs/bot-integration.md#integration-surfaces) | Bridge HTTPS는 experimental이며 기본 lifecycle 제어면으로 사용하지 말아야 한다. | 검증 |

## 가정 및 한계

- 공개 1차 문서에서 `GJC Notifications SDK`라는 별도, 버전 고정 가능한 SDK의 API 계약·패키지명·지원 수명주기를 확인하지 못했다. 따라서 SDK의 존재·기능·전달 보장은 **미검증**이다.
- 위 결론은 GJC의 공식 repository 문서가 제공하는 Coordinator/공개 hook 계약에 한정한다. 특정 GJC 설치본의 패키지 또는 README 서술을 SDK 계약으로 승격하지 않는다.
- 알림은 correctness 경로가 아니다. SQLite commit 이후의 event journal과 SSE catch-up이 상태 복구의 정본이며, push/외부 알림은 사용자 주의 환기용 보조 채널이다.

## 결정 및 파라미터 권고

1. **GJC Notifications SDK는 Phase 4에 포함하지 않는다.** Phase 4는 Web Push(VAPID), deep link, 권한·토큰·강제종료/절전 QA에 한정한다.
2. GJC 관련 사용자 알림이 필요하면 Hub backend가 Coordinator MCP의 terminal status 또는 공개 `turn_end`/`agent_end`만 소비해, 최소 메타데이터(`eventType`, `occurredAt`, opaque `sessionId`)로 Web Push를 발행한다.
3. payload에는 prompt, transcript, tool output, hidden instruction, credential, host path, channel/webhook ID를 넣지 않는다. notification tap은 인증된 deep link로만 열고 서버에서 다시 인가한다.
4. Bridge HTTPS는 알림 경로를 포함해 채택 금지다. NanoClaw를 호출·포함·host에서 실행하거나 NanoClaw용 launchd unit을 만들지 않는다.

## Deferred 검증

- 향후 특정 GJC release에 별도 Notifications SDK를 도입하려면 그 release의 공식 source/API 문서, 라이선스, 이벤트 전달·중복·재시도 계약과 secret 취급을 독립 spike로 검증한다.
- Android 실기기 Web Push의 권한 철회, 토큰 교체, 강제종료, 절전, notification tap 재인증은 Phase 4 실기기 QA로 보류한다. 본 spike에서는 실행하지 않았다.

## Hard-gate 판정

**PASS (Phase 1 진입 관점), SDK 포함은 NO-GO.** Coordinator MCP와 공개 lifecycle 이벤트만으로 Hub의 관찰·보조 알림 경로를 설계할 수 있으며, 미검증 SDK는 Phase 4 의존성으로 넣지 않는다. Phase 4의 Web Push 구현은 별도 실기기 QA gate를 통과해야 한다.
