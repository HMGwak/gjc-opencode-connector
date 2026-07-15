# Spike A — OpenCode Server 제어면

- 조사일: 2026-07-15
- 범위: 설치 버전, `prompt_async`, session status, SSE event, cursor, permission, restart/recovery.
- 안전 경계: 이 조사는 서버를 시작하지 않았고, NanoClaw 또는 host daemon을 시작하지 않았다.

## 근거와 재현 명령

| 등급 | 명령/출처 | 관찰 또는 계약 |
|---|---|---|
| 검증 | `opencode --version` | 설치된 OpenCode는 `1.17.15`이다. |
| 검증 | `opencode serve --help` | `--hostname` 기본값은 `127.0.0.1`, `--port` 기본값은 `0`, `--mdns` 기본값은 false이다. 명령은 help만 출력했으며 서버를 시작하지 않았다. |
| 검증 | [OpenCode Server 문서](https://opencode.ai/docs/server/) | headless HTTP server와 `/doc` OpenAPI 3.1 endpoint를 공식 제공한다. 문서 예시의 default port(4096)와 설치된 CLI help의 port default(0)가 다르므로, 실행 시 실제 listen 주소/port를 별도 기록해야 한다. |
| 검증 | [OpenCode Server API: Sessions/Messages/Events](https://opencode.ai/docs/server/#sessions) | `GET /session/status`, `POST /session/:id/prompt_async`, `POST /session/:id/permissions/:permissionID`, `POST /session/:id/abort`, `GET /event`가 공개되어 있다. |

재현용 read-only 명령:

```sh
opencode --version
opencode serve --help
```

서버를 실제로 기동한 뒤에만 수행할 deferred probe(이 spike에서는 실행 금지):

```sh
# 전용 격리 환경에서만: 아래 HTTP 요청은 상태를 변경하거나 모델 호출을 유발할 수 있다.
# curl -i http://127.0.0.1:<port>/global/health
# curl -N http://127.0.0.1:<port>/event
# curl -i http://127.0.0.1:<port>/session/<id>/status
```

## 계약 결과

| 항목 | 상태 | 근거/결론 |
|---|---|---|
| `prompt_async` | 검증 | `POST /session/:id/prompt_async`는 message와 같은 body를 받고 공식 문서상 **`204 No Content`**를 반환한다. Adapter는 202를 성공으로 가정하지 않는다. |
| status | 검증 | `GET /session/status`는 모든 session의 `SessionStatus` map을 반환한다. 개별 상태 enum, terminal transition과 polling race는 runtime 검증 전 미확정이다. |
| event | 검증 | `GET /event`는 SSE stream이며 첫 event는 `server.connected`, 이후 bus event다. |
| cursor/replay | 이용 불가(공개 계약) | 공식 event 표와 설명에 `Last-Event-ID`, cursor query, replay window 또는 event-id 안정성 계약이 없다. 따라서 SSE 재접속 catch-up source로 사용하지 않고, session/message snapshot reconciliation을 사용한다. |
| permission | 검증 | `POST /session/:id/permissions/:permissionID` body는 `{ response, remember? }`, 반환은 boolean이다. response enum과 중복/만료 permission의 의미는 OpenAPI snapshot 및 runtime에서 확인 전 미확정이다. |
| abort | 검증 | `POST /session/:id/abort`는 boolean을 반환한다. 재시작 복구나 owner proof를 제공한다는 공개 계약은 확인되지 않았다. |
| restart/recovery | 이용 불가(공개 계약) | `opencode serve`가 standalone server를 시작한다는 사실 외에, restart 후 session/event cursor 보존, 재연결 semantics, in-flight prompt의 exactly-once 보장은 공식 문서에서 확인되지 않았다. |

## 결론

OpenCode adapter는 공식 HTTP/OpenAPI와 `/event`만 사용한다. 비동기 prompt의 성공은 `204`만으로 기록하고, event stream은 liveness/가속 신호일 뿐 durable cursor로 취급하지 않는다. 재연결과 server restart 후에는 `GET /session`, `GET /session/status`, 필요한 session의 message 조회로 local journal과 reconcile해야 한다. Permission 응답과 abort는 원격 mutation이므로 local idempotency key와 crash 후 `unknown` 격리를 적용할 대상이다.

## 미확정 사항 및 deferred runtime 검증

1. `/doc`에서 설치 버전 `1.17.15`의 OpenAPI JSON을 capture하여 request schema와 status enum을 fixture로 고정한다.
2. 새 session에 `prompt_async`를 한 번만 보내 HTTP status/body를 확인한다. provider credentials/model 호출이 필요한 경우 deferred로 유지한다.
3. SSE를 끊고 재연결하여 event `id:` field, `Last-Event-ID` 수용, 누락 구간 replay 유무를 확인한다. 공개 계약이 없으므로 replay가 없어도 defect가 아니다.
4. permission을 생성해 allow/deny/duplicate/expired 응답을 확인한다.
5. prompt 중 process restart를 수행하고 session/status/message persistence 및 duplicate 위험을 기록한다.

이 항목들은 이번 조사에서 서버를 시작하지 않았으므로 모두 **deferred**이며, 성공/실패를 주장하지 않는다.

## Gate A 판정

**조건부 통과 (Phase 1 진입 전 runtime fixture 필요).** 공식 제어면, loopback 기본 bind, `204` 비동기 prompt, status, permission, SSE는 확인됐다. Cursor replay와 restart recovery가 공개 계약에 없으므로 구현은 snapshot reconciliation 및 no-retry/unknown 격리를 전제로 해야 한다. 설치 OpenAPI snapshot과 위 deferred runtime matrix가 완료되기 전에는 durable event/restart 보장을 주장할 수 없다.
