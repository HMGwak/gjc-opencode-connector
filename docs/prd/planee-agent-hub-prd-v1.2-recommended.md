# Planee Agent Hub PRD v1.2 — 권장안

**상태:** 권장안. 기기 pairing 인증 경계와 Capacitor Android 앱 연결은 구현되어 있으나, 실기기·Tunnel·Cloudflare 제어면 검증은 별도 증적이 필요
**작성일:** 2026-07-15
**제품 형태:** Mac mini 단일 노드 기반 모바일 Agent 관리 허브
**대상 Agent:** OpenCode, Gajae-Code(GJC)
**외부 접속:** `agents.myplanee.com` + Cloudflare Tunnel + 기기별 pairing credential
**모바일:** Capacitor Android 앱. PWA 우선 전략은 후속 제품 결정
**저장 방식:** 로컬 우선(Local-first), 실시간 우선, 연결 복구형 동기화  

---

## 0. 문서 성격

이 문서는 최종 확정 설계가 아니라 **현재까지 조사한 공식 제어면과 사용 환경을 바탕으로 한 구현 권장안**이다.

실제 구현 과정에서 다음이 확인되면 구조를 변경할 수 있다.

- OpenCode 또는 GJC의 실제 API·세션 저장 방식이 문서와 다름
- 특정 제어면이 안정적으로 재연결되지 않음
- GJC Coordinator MCP와 Notifications SDK의 역할이 중복되거나 충돌함
- OpenCode SSE가 기대한 cursor·replay 기능을 제공하지 않음
- macOS `launchd`, 절전, 로그인 세션 또는 Keychain 제약이 발생함
- Cloudflare Tunnel과 SSE/WebSocket 장기 연결에서 문제가 발생함
- PWA background 제한으로 실시간 알림 신뢰도가 낮음
- SQLite 단일 DB가 실제 event 양이나 동시성에 부족함
- Agent 프로세스가 Hub보다 더 나은 durable event source를 제공함

따라서 구현은 먼저 작은 기술 검증을 수행하고, 결과에 따라 ADR과 PRD를 갱신하는 방식으로 진행한다.

---

# 1. Executive Summary

Planee Agent Hub는 Mac mini에서 실행되는 OpenCode와 GJC를 Android 스마트폰에서 통합 관리하기 위한 셀프호스팅 모바일 허브다.

현재 권장 구조는 다음과 같다.

```text
Android PWA
    │
    ▼
agents.myplanee.com
    │
Cloudflare Tunnel + Hub device authentication
    │
    ▼
Mac mini
├─ planee-core
│  ├─ SQLite event journal
│  ├─ OpenCode Adapter
│  ├─ GJC Adapter
│  ├─ command queue
│  ├─ pending action store
│  └─ reconnect/reconciliation engine
│
├─ planee-web
│  ├─ PWA
│  ├─ REST API
│  ├─ SSE/WebSocket
│  └─ Web Push
│
├─ cloudflared
├─ OpenCode
└─ GJC
```

핵심 동작 원칙:

```text
정상 연결 상태
→ 실시간 동기화

모바일·웹·Tunnel 연결 중단
→ Mac mini SQLite에 계속 기록

연결 복구
→ 마지막 수신 sequence 이후 catch-up 동기화
```

즉, 이 제품은 비실시간 시스템이 아니라 **실시간 우선 + 오프라인 내구성** 시스템이다.

---

# 2. Problem Statement

현재 모바일 SSH 중심 운영에는 다음 문제가 있다.

- 작은 화면에서 TUI 조작이 불편하다.
- OpenCode와 GJC의 상태를 한눈에 볼 수 없다.
- 질문, 승인, 오류, 완료 이벤트를 놓치기 쉽다.
- 모바일 네트워크가 끊기면 작업 상태를 복구하기 어렵다.
- Agent와 모바일 사이의 통신 방식이 도구마다 다르다.
- 장시간 실행 중인 Agent의 결과를 SSH 없이 확인하기 어렵다.
- 외부 접속을 위해 Agent 포트를 직접 공개하는 것은 위험하다.
- 작업 기록과 Agent 상태를 Linear 같은 외부 도구에만 의존하면 실행 상태와 기록이 분리된다.

---

# 3. Product Vision

## 3.1 한 문장 정의

> Mac mini에서 실행되는 여러 코딩 Agent의 상태, 질문, 지시, 변경 결과를 Android에서 실시간으로 관리하고, 연결이 끊겨도 기록을 잃지 않는 개인용 모바일 운영 허브.

## 3.2 핵심 가치

1. 모바일 우선
2. 실시간 우선
3. 로컬 우선 저장
4. 연결 복구 가능
5. Agent별 공식 제어면 사용
6. 터미널 스크래핑 최소화
7. Mac mini가 실행 권한의 최종 경계
8. 외부 서비스는 선택적 Connector

---

# 4. Product Principles

## 4.1 Local-first

모든 Agent 상태 변화와 명령 결과는 외부 전달보다 먼저 Mac mini 로컬 저장소에 기록한다.

```text
Agent event
    ↓
planee-core SQLite 기록
    ↓
연결된 모바일에 전달
```

모바일, Cloudflare, PWA, 브라우저가 없어도 로컬 기록은 계속된다.

## 4.2 Realtime-first

모바일이 연결되어 있으면 이벤트는 즉시 전달한다.

권장 전송:

- Agent → `planee-core`: Adapter별 공식 event stream
- `planee-core` → `planee-web`: 내부 event bus
- `planee-web` → PWA: SSE
- 명령: REST API
- Push: Web Push 또는 이후 FCM

## 4.3 Recoverable

모든 실시간 연결은 끊길 수 있다고 가정한다.

필수 기능:

- monotonic sequence
- idempotency key
- snapshot reconciliation
- pending action 복구
- command deduplication
- reconnect cursor
- local spool

## 4.4 Bounded control

모바일에서 허용되는 동작만 노출한다.

기본 허용:

- 세션 목록
- 상태 조회
- prompt 전송
- 질문 응답
- 승인 응답
- abort
- diff 조회
- artifact 조회

기본 금지:

- 임의 shell
- 임의 절대 경로 실행
- 환경 변수 조회
- provider credential 조회
- system prompt 조회
- unrestricted tmux 명령
- Mac mini 관리 권한

## 4.5 Adapter isolation

OpenCode와 GJC를 동일하게 보이게 하되 내부적으로는 각 공식 제어면을 유지한다.

```text
Unified Hub Domain Model
    ├─ OpenCode Adapter
    └─ GJC Adapter
```

---

# 5. Scope

## 5.1 MVP

### Dashboard

- OpenCode/GJC 통합 세션 목록
- 상태:
  - Offline
  - Starting
  - Idle
  - Queued
  - Running
  - Needs Input
  - Blocked
  - Succeeded
  - Failed
  - Cancelled
- Backend 필터
- 프로젝트 필터
- Needs Input 우선 정렬
- 마지막 활동 시각
- pending action 수

### Session Detail

- 세션 정보
- Backend
- 프로젝트·branch·worktree
- 현재 상태
- 최근 Agent 응답
- 최근 activity timeline
- pending action 카드
- prompt composer
- abort
- 변경 파일
- diff
- 테스트 결과
- artifact

### Pending Action

- single select
- multi select
- free text
- permission once
- permission remember
- destructive confirmation
- workflow gate
- unsupported mobile action

### Session Command

- 새 session 생성
- 기존 session에 prompt
- queued follow-up
- abort
- pending action 답변

### Realtime and Recovery

- 연결 중 실시간 SSE
- 연결 끊김 감지
- last sequence 저장
- 재연결 catch-up
- snapshot reconciliation
- command idempotency
- stale action 처리

### Security

- device pairing credential
- Cloudflare Tunnel
- Agent 포트 외부 비공개
- localhost bind
- Mac mini local secret
- audit
- capability allowlist

## 5.2 Post-MVP

- Capacitor Android 앱
- FCM
- biometric unlock
- Linear Connector
- GitHub Connector
- Telegram fallback
- 음성 prompt
- 여러 Mac node
- terminal read-only
- 비용·token dashboard
- 예약 작업
- Agent profile UI

## 5.3 Non-goals

- 모바일 IDE
- 원격 데스크톱
- 기본 arbitrary shell
- OpenCode/GJC fork
- 멀티테넌트 SaaS
- Linear 필수 의존
- raw tmux scrollback 중심 구현
- 전체 transcript 무제한 전송

---

# 6. Recommended Architecture

## 6.1 Runtime Components

### `planee-core`

Mac mini에서 계속 실행되는 경량 daemon.

책임:

- OpenCode/GJC 탐색
- Adapter 연결
- event normalization
- SQLite 저장
- pending action 저장
- command queue
- process lifecycle
- reconnect
- reconciliation
- artifact metadata
- health

평소에는 LLM을 실행하지 않는다.

### `planee-web`

모바일 UI와 API 서버.

책임:

- PWA 제공
- REST API
- SSE
- 인증
- Web Push
- mobile session cursor
- audit UI

구현 단순화를 위해 MVP에서는 `planee-core`와 같은 프로세스로 합칠 수도 있다.

권장 시작:

```text
한 프로세스
├─ core
├─ API
└─ web
```

안정화 후 필요하면 분리한다.

### `cloudflared`

```text
agents.myplanee.com
    ↓
Hub device authentication
    ↓
Cloudflare Tunnel
    ↓
127.0.0.1:8787
```

공유기 포트포워딩은 하지 않는다.

## 6.2 Deployment Recommendation

### MVP 권장안

하나의 macOS `launchd` 서비스:

```text
planee serve
```

내부:

- SQLite
- Adapter
- API
- PWA
- SSE

별도 서비스:

- `cloudflared`

이유:

- 초기 운영 복잡도 감소
- process 간 동기화 문제 감소
- SQLite writer 단일화
- 디버깅 용이
- 재시작 단순화

### 확장안

성능·안정성 문제가 확인되면:

```text
planee-core
planee-web
planee-worker
```

로 분리한다.

이 분리는 사전 확정하지 않고 실제 부하와 장애 패턴을 보고 결정한다.

---

# 7. Sync Model

## 7.1 Realtime Path

```text
OpenCode SSE / GJC Event
    ↓
Adapter
    ↓
SQLite transaction
    ↓
Hub event bus
    ↓
SSE
    ↓
Android PWA
```

저장 성공 후에만 모바일로 전달한다.

## 7.2 Disconnected Path

```text
Cloudflare/PWA 연결 끊김
    ↓
Mac mini event 기록 계속
    ↓
events.seq 증가
    ↓
모바일 재접속
    ↓
lastSeq 이후 이벤트 요청
    ↓
catch-up
```

## 7.3 Process Restart

```text
planee 재시작
    ↓
SQLite adapter cursor 조회
    ↓
Backend snapshot 조회
    ↓
저장 상태와 비교
    ↓
누락/변경 상태 reconciliation
    ↓
event 생성
```

## 7.4 Mobile Offline Outbox

PWA가 연결되지 않은 상태에서 일반 prompt를 임시 저장할 수 있다.

허용:

- 일반 prompt
- 메모
- work item 연결

금지:

- permission 승인
- destructive action
- abort
- force turn
- 오래된 질문 답변
- remember permission

오프라인 prompt는 재접속 시 사용자가 전송 여부를 다시 확인할 수 있게 한다.

---

# 8. Event Journal

## 8.1 Event Structure

```json
{
  "seq": 1842,
  "eventId": "evt_...",
  "adapter": "gjc",
  "sessionId": "sess_...",
  "type": "session.needs_input",
  "payload": {},
  "occurredAt": "2026-07-15T18:30:00+09:00",
  "storedAt": "2026-07-15T18:30:00+09:00"
}
```

## 8.2 Required Properties

- append-only
- monotonic sequence
- unique event id
- duplicate safe
- bounded payload
- secret-free
- replayable
- snapshot recoverable

## 8.3 Retention

권장안:

- metadata event: 90일
- message preview: 30일
- full tool output: 7일 또는 artifact 이동
- audit: 180일
- completed session summary: 장기 보존

실제 사용량 확인 후 변경한다.

---

# 9. SQLite Design

## 9.1 권장 설정

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
```

## 9.2 Tables

```text
nodes
backend_instances
projects
sessions
turns
messages
pending_actions
commands
events
artifacts
adapter_cursors
client_cursors
audit_logs
settings
```

## 9.3 SQLite 사용 조건

MVP에서 SQLite를 권장한다.

장점:

- Mac mini 단일 노드
- 설치 간단
- 백업 쉬움
- local-first에 적합
- 외부 DB 불필요

다음 조건이 발생하면 PostgreSQL 전환을 검토한다.

- 여러 Mac node
- 다중 사용자
- write contention
- event 수백만 건 이상
- 복잡한 analytics
- remote worker 분리

SQLite는 확정 기술이 아니라 MVP 권장안이다.

---

# 10. Unified Domain Model

## 10.1 Session State

```text
offline
starting
idle
queued
running
needs_input
blocked
succeeded
failed
cancelled
```

상태 우선순위:

```text
offline
> needs_input
> failed
> blocked
> running
> queued
> idle
> succeeded
> cancelled
```

## 10.2 Core Entities

### Session

- id
- backend
- backendSessionId
- projectId
- title
- state
- backendState
- branch
- worktree
- activeTurnId
- pendingActionCount
- lastActivityAt
- createdAt
- updatedAt

### Turn

- id
- sessionId
- backendTurnId
- status
- userPreview
- assistantPreview
- startedAt
- completedAt
- error

### PendingAction

- id
- sessionId
- backendActionId
- kind
- prompt
- options
- controls
- state
- expiresAt
- resolvedAt
- resolvedBy

### Command

- id
- type
- targetId
- idempotencyKey
- requestHash
- state
- attempts
- acceptedAt
- completedAt
- result
- error

### AdapterCursor

- adapter
- stream
- cursor
- generation
- updatedAt

---

# 11. Adapter Contract

```ts
export interface AgentAdapter {
  readonly backend: "opencode" | "gjc";

  health(): Promise<BackendHealth>;

  listSessions(): Promise<AgentSessionSummary[]>;

  getSession(sessionId: string): Promise<AgentSessionSnapshot>;

  createSession(input: CreateSessionInput): Promise<CommandReceipt>;

  sendPrompt(input: SendPromptInput): Promise<CommandReceipt>;

  answerAction(input: AnswerActionInput): Promise<CommandReceipt>;

  abortSession(input: AbortSessionInput): Promise<CommandReceipt>;

  getChanges(sessionId: string): Promise<SessionChanges>;

  getArtifacts(sessionId: string): Promise<ArtifactSummary[]>;

  subscribe(cursor?: AdapterCursor): AsyncIterable<AgentEvent>;

  reconcile(
    stored: StoredAdapterState,
  ): Promise<ReconciliationResult>;
}
```

## 11.1 Adapter Rules

- 모든 mutation은 idempotency key를 가진다.
- Backend 응답 전 성공 표시 금지
- unknown event 보존
- secret 필드 제거
- version handshake
- reconnect 지원 여부 명시
- snapshot API 제공
- event replay가 없으면 reconciliation으로 보완

---

# 12. OpenCode Adapter — 권장안

## 12.1 Primary Control Surface

권장:

- OpenCode Server API
- SDK
- SSE events

```text
opencode serve
    └─ 127.0.0.1:<port>
```

외부 공개 금지.

## 12.2 Expected Mapping

- health
- session list
- session status
- create session
- async prompt
- abort
- messages
- diff
- permissions
- events

## 12.3 Discovery Spike Required

구현 전 다음을 실제 코드와 실행 환경에서 검증해야 한다.

- Server를 종료 후 재시작해도 기존 session을 다시 읽을 수 있는가
- SSE가 stable event id 또는 replay cursor를 제공하는가
- event gap을 어떤 snapshot API로 복구할 수 있는가
- permission event가 재연결 후 재조회 가능한가
- `prompt_async` 결과를 어떤 event로 식별하는가
- project별 server가 필요한가, 하나의 server로 여러 project가 가능한가
- 기존 TUI session과 server session이 동일 저장소를 공유하는가
- server API version drift가 있는가

검증 결과에 따라 다음 중 하나를 선택한다.

### Option A

단일 장기 OpenCode server

### Option B

프로젝트별 OpenCode server

### Option C

필요 시 시작하고 idle timeout 후 종료

현재 권장안은 Option A 또는 B지만, 실제 session persistence 확인 후 결정한다.

---

# 13. GJC Adapter — 권장안

## 13.1 Primary Surfaces

권장 조합:

### Coordinator MCP

- session list
- start/register
- send prompt
- turn status
- question answer
- artifact
- event journal

### Notifications SDK

- action_needed
- action_resolved
- reply
- user_message
- activity
- turn_stream
- session_closed

## 13.2 Authority Rule

- durable session/turn 상태: Coordinator MCP
- 빠른 UI 이벤트: Notifications
- 충돌 시 Coordinator 상태 우선
- Notifications 이벤트는 UX 가속용이며 단독 source of truth가 아님

## 13.3 Discovery Spike Required

구현 전 다음을 검증한다.

- Coordinator MCP 세션이 GJC 일반 실행 세션을 얼마나 안정적으로 탐색하는가
- 기존 tmux 세션 등록이 필요한가
- Coordinator event sequence가 재시작 후 유지되는가
- `watch_events` long-poll의 실제 안정성
- pending question이 재연결 후 list API에서 복구되는가
- Notifications endpoint discovery가 세션 재개 시 어떻게 변경되는가
- Notifications action과 Coordinator question id를 연결할 수 있는가
- turn_stream과 final_response 중 어떤 것을 최종 결과로 사용할지
- GJC 버전 변경 시 protocol compatibility를 어떻게 확인할지
- Coordinator MCP process를 장기 유지할지 요청 시 시작할지

검증 결과에 따라 Notifications를 최소화하고 Coordinator만 사용할 수도 있다.

---

# 14. API Draft

## 14.1 Read

```http
GET /api/v1/health
GET /api/v1/backends
GET /api/v1/projects
GET /api/v1/sessions
GET /api/v1/sessions/{id}
GET /api/v1/sessions/{id}/messages
GET /api/v1/sessions/{id}/changes
GET /api/v1/sessions/{id}/artifacts
GET /api/v1/actions
GET /api/v1/events?after={seq}
GET /api/v1/stream
```

## 14.2 Mutations

```http
POST /api/v1/sessions
POST /api/v1/sessions/{id}/prompts
POST /api/v1/sessions/{id}/abort
POST /api/v1/actions/{id}/answer
POST /api/v1/push/subscriptions
```

응답:

```json
{
  "commandId": "cmd_...",
  "state": "accepted"
}
```

실제 성공·실패는 event로 전달한다.

---

# 15. PWA UX

## 15.1 Bottom Navigation

1. Attention
2. Sessions
3. Activity
4. Settings

## 15.2 Attention

- Needs Input
- Failed
- Blocked
- Offline Backend
- Expired Action

## 15.3 Session Card

목록에서 로드:

- title
- backend
- project
- branch
- status
- last activity
- pending action count
- short summary

로드하지 않음:

- 전체 transcript
- full tool output
- full diff
- image
- artifact body

## 15.4 Session Detail

- Action card 최상단
- timeline
- final response
- tool summary
- changes
- artifacts
- sticky composer
- keyboard-safe layout

---

# 16. Tunnel and Device Security

## 16.1 External Access

```text
agents.myplanee.com
```

필수:

- Cloudflare Tunnel
- Hub 기기 credential 검증 (`Authorization: Bearer`)
- 1회·짧은 수명의 pairing code
- Android 앱 전용 `SharedPreferences` credential 저장과 `allowBackup=false`
- HSTS와 rate limit은 배포·외부 경로에서 별도 검증
- no port forwarding
- no direct Agent port

## 16.2 Local Bind

권장:

```text
planee-web: 127.0.0.1:8787
opencode: 127.0.0.1:<port>
GJC MCP: stdio
GJC notification: 127.0.0.1
```

## 16.3 Secret Storage

- pairing root secret은 root-owned `0600` 파일
- Android 앱은 credential을 앱 전용 `SharedPreferences`에 저장하고 `allowBackup=false`를 사용한다. Keystore 암호화가 아니므로 분실·root된 기기 보호 수준은 더 낮다.
- credential, Authorization header, pairing code는 로그에 남기지 않는다.
- provider key DB 저장 금지

---

# 17. macOS Runtime

## 17.1 launchd

권장 MVP:

```text
~/Library/LaunchAgents/com.myplanee.planee.plist
```

실행:

```text
planee serve
```

`RunAtLoad`와 `KeepAlive`를 사용한다.

## 17.2 Sleep

Mac mini가 항상 켜져 있어도 macOS sleep 정책을 확인해야 한다.

필수 검증:

- system sleep 비활성화 여부
- display sleep과 system sleep 구분
- login session 없이 LaunchAgent가 실행 가능한지
- 재부팅 후 자동 로그인 필요 여부
- Keychain 접근 가능 여부
- network 변경 후 cloudflared 복구

headless 부팅이 필요하면 LaunchDaemon을 별도 검토한다.

---

# 18. Notifications

## 18.1 MVP

- PWA 열린 상태: SSE 실시간
- PWA 닫힘: Web Push
- push payload는 session id와 event type만 포함
- 민감한 question 본문은 notification에 넣지 않음

## 18.2 Discovery Spike

PWA Web Push가 Android 환경에서 충분하지 않으면:

- Telegram
- FCM via Capacitor
- ntfy
- Gotify

중 하나를 보조 채널로 추가한다.

현재 권장안은 Web Push 우선이지만 확정은 아니다.

---

# 19. Linear — 후속 Connector

Linear는 MVP 핵심 경로에서 제외한다.

후속 역할:

- Work Queue
- session link
- status sync
- result comment

원칙:

- Hub가 source of truth
- 모든 댓글 자동 실행 금지
- `/agent` 같은 명시적 trigger만 허용
- webhook dedupe
- origin marker
- Agent credential에 Linear token 직접 노출 금지

---

# 20. Implementation Strategy

## Phase 0 — Technical Discovery

코드 작성 전에 실행 가능한 spike를 만든다.

### Spike A — OpenCode

- server 시작
- session 생성
- prompt
- SSE
- server restart
- session recovery
- permission
- diff

### Spike B — GJC Coordinator

- MCP 시작
- session list
- session start
- prompt
- question
- answer
- artifact
- event resume

### Spike C — GJC Notifications

- discovery
- action
- reply
- reconnect
- resumed session
- Coordinator와 id 연결

### Spike D — macOS Runtime

- launchd
- restart
- sleep
- network reconnect
- Keychain
- cloudflared

### Spike E — PWA Reconnect

- SSE disconnect
- Last-Event-ID
- IndexedDB cursor
- catch-up
- background/foreground
- push

각 spike는 결과 문서와 추천 변경안을 남긴다.

## Phase 1 — Vertical Slice

```text
Cloudflare login
→ session list
→ one session detail
→ prompt
→ realtime result
→ reconnect catch-up
```

지원 Backend는 먼저 하나만 선택해도 된다.

권장 순서:

1. OpenCode
2. GJC

실제 spike 결과가 GJC가 더 단순하면 순서를 바꿀 수 있다.

## Phase 2 — Pending Actions

- durable action
- answer
- stale/expired
- reconnect
- duplicate answer

## Phase 3 — Changes and Artifacts

- diff summary
- file diff on demand
- test result
- artifact

## Phase 4 — Notifications

- Web Push
- deep link
- fallback channel 검토

## Phase 5 — Second Adapter

첫 Adapter에서 만든 공통 contract를 기준으로 두 번째 Backend를 연결한다.

---

# 21. Decision Gates

## Gate 1 — OpenCode Event Reliability

통과 조건:

- prompt 결과를 event로 식별 가능
- restart 후 session 복구 가능
- permission 복구 가능
- snapshot reconciliation 가능

실패 시:

- OpenCode 자체 Web UI를 임시 link
- message polling 보완
- project별 server 구조 변경

## Gate 2 — GJC Durable Control

통과 조건:

- Coordinator turn 상태가 source of truth로 충분
- pending question 복구 가능
- event cursor 재개 가능

실패 시:

- RPC worker 방식 검토
- Notifications 중심 Adapter
- GJC 공식 Telegram remote를 보조 채널로 유지

## Gate 3 — Single Process Viability

통과 조건:

- SQLite contention 없음
- web/core 장애 격리 요구 낮음
- memory 안정

실패 시:

- `planee-core`와 `planee-web` 분리

## Gate 4 — PWA Notification Reliability

통과 조건:

- Android에서 push 도달
- deep link 복구
- background reconnect

실패 시:

- Capacitor + FCM
- Telegram fallback

## Gate 5 — Cloudflare Long Connection

통과 조건:

- SSE reconnect 안정
- 기기 credential으로 Access JWT 갱신 없이 재연결
- Tunnel 재시작 후 자동 복구

실패 시:

- WebSocket
- 짧은 polling
- hybrid transport

---

# 22. Acceptance Criteria

## 22.1 Product

- Android에서 접속 가능
- OpenCode/GJC 세션 통합 조회
- prompt 가능
- 질문 응답 가능
- 완료·오류 확인
- 연결 복구 후 누락 이벤트 동기화

## 22.2 Durability

- web 재시작 후 상태 유지
- cloudflared 중단 중 event 유지
- 모바일 offline 중 event 유지
- command 중복 실행 방지
- stale action 방지

## 22.3 Security

- Agent 포트 외부 비공개
- 인증되지 않은 Hub API 요청 차단
- credential은 bundle·source·로그에 저장하지 않음
- arbitrary shell 없음
- audit에 secret 없음

## 22.4 Performance

- session 100개 목록
- 목록에서 전체 message 미로드
- tool output 지연 로드
- event payload 제한
- reconnect 시 변경분만 전달

---

# 23. Risks

| 위험 | 대응 |
|---|---|
| OpenCode SSE replay 부족 | cursor 대신 snapshot reconciliation |
| GJC 제어면 중복 | Coordinator authority 규칙 |
| GJC protocol 변경 | version handshake, adapter tests |
| macOS sleep | power policy, launchd test |
| PWA background 제한 | Web Push, Capacitor fallback |
| Cloudflare 연결 중단 | local journal, reconnect |
| SQLite 성장 | retention, vacuum, archive |
| 대용량 tool output | artifact 분리 |
| pending action 중복 | idempotency, first-valid-wins |
| 전체 구조 과설계 | vertical slice 우선 |
| 실제 코드가 문서와 다름 | discovery gate 후 PRD 갱신 |

---

# 24. Recommended Repository Structure

```text
planee-agent-hub/
├─ apps/
│  ├─ server/
│  └─ web/
├─ packages/
│  ├─ domain/
│  ├─ protocol/
│  ├─ db/
│  ├─ adapter-opencode/
│  ├─ adapter-gjc/
│  ├─ ui/
│  └─ testkit/
├─ docs/
│  ├─ prd/
│  ├─ adr/
│  ├─ spikes/
│  ├─ runbooks/
│  └─ security/
├─ infra/
│  ├─ launchd/
│  └─ cloudflare/
└─ README.md
```

---

# 25. Required ADRs

- ADR-001: Mac mini single-node architecture
- ADR-002: Local-first event journal
- ADR-003: SSE + catch-up transport
- ADR-004: SQLite MVP
- ADR-005: OpenCode Adapter control surface
- ADR-006: GJC Coordinator/Notifications authority
- ADR-018: Personal device pairing authentication
- ADR-008: PWA first
- ADR-009: No terminal scraping
- ADR-010: Single process first, split later

ADR은 spike 결과에 따라 변경 가능하다.

---

# 26. First Deliverable

첫 번째 구현 목표:

```text
Mac mini에서 planee serve 실행
→ SQLite 생성
→ Android device pairing 후 PWA 접속
→ 한 Backend의 session 목록
→ session 상세
→ prompt 전송
→ 실시간 응답
→ Tunnel 중단
→ 로컬 event 기록
→ Tunnel 복구
→ 누락 event catch-up
```

이 기능이 성공해야 다음 기능을 구현한다.

- 두 번째 Backend
- Pending Action
- Push
- Linear
- Android 앱

---

# 27. Final Recommendation

현재 권장안은 다음이다.

```text
Android PWA
    ↓
Cloudflare Tunnel + Hub device authentication
    ↓
Mac mini의 planee serve
    ├─ API/PWA
    ├─ SQLite
    ├─ realtime event stream
    ├─ reconnect/catch-up
    ├─ OpenCode Adapter
    └─ GJC Adapter
```

운영 방식:

```text
정상
→ 실시간

외부 연결 중단
→ 로컬 저장

복구
→ 누락분 동기화
```

단, 이 설계는 **구현 권장안이며 확정 아키텍처가 아니다.**

실제 OpenCode/GJC 코드와 프로토콜을 연결하면서 더 단순하고 안정적인 공식 경로가 발견되면 해당 경로를 우선한다. 반대로 replay, session persistence, 질문 복구, macOS daemon 운영에서 막힘이 확인되면 Adapter 방식이나 process 구조를 변경한다.

제품의 고정 요구사항은 기술 선택이 아니라 다음 네 가지다.

1. Android에서 관리 가능
2. 연결 중에는 실시간
3. 연결이 끊겨도 로컬 기록 유지
4. 연결 복구 후 누락 데이터 동기화

나머지 구현 방식은 spike와 실제 코드 검증 결과에 따라 변경 가능하다.

---

# 28. Reference Targets for Implementation Discovery

- OpenCode Server API
- OpenCode SDK
- OpenCode event stream
- GJC Coordinator MCP
- GJC external control readiness
- GJC Notifications SDK
- GJC RPC mode
- device pairing credential
- Cloudflare Tunnel
- macOS launchd
- PWA Service Worker
- Web Push
- Capacitor
