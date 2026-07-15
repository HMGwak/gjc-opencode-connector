# Web Push 운영 Runbook

## 범위와 불변식

- Web Push는 사용자 주의 환기용 **best-effort hint**다. SQLite session/event journal과 정상 인증된 API가 상태의 권위이며, push 수신·중복·손실·순서는 어떤 상태 전이나 mutation의 근거가 될 수 없다.
- 발송 payload에는 prompt, transcript, tool output, credential, VAPID private key, host path, webhook/channel ID 또는 session 내용을 넣지 않는다. 허용 payload는 최소한의 이벤트 종류, 발생 시각, opaque session ID와 동일 출처 상대 deep link뿐이다.
- subscription은 인증된 owner에만 귀속한다. 다른 owner의 subscription을 조회·발송·철회할 수 없다. 철회 또는 provider `410`/`404` 응답은 즉시 해당 subscription을 비활성화/삭제하고 재사용하지 않는다.
- notification tap은 same-origin allowlist의 상대 경로만 연다. 도착한 뒤에도 normal authentication과 server-side authorization을 다시 수행한다. 미인증·만료·권한 없음이면 로그인 또는 권한 거부 화면으로 fail closed하며 session 내용을 표시하지 않는다.
- 이 문서는 키 값, subscription endpoint, auth/p256dh key, access token 또는 운영 환경의 URL을 기록하지 않는다.

## VAPID 키 생성과 주입

1. 승인된 비밀 관리 provider에서 Web Push용 새 VAPID key pair를 생성한다. 생성은 운영 애플리케이션 host, source repository, CI log 밖에서 수행한다.
2. public key는 배포 가능한 설정값으로 등록하고, private key는 provider의 write-only secret 항목으로만 등록한다. key material을 issue, 문서, shell history, `.env`, fixture, browser bundle, analytics, log에 넣지 않는다.
3. backend runtime identity에 private-key secret의 읽기 권한만 부여한다. web/PWA build, browser client, 일반 개발자 계정에는 private-key read 권한을 부여하지 않는다.
4. 배포 시 injected secret provider를 통해 backend process에만 private key를 전달한다. 시작 검증은 키의 존재 여부와 provider reference만 기록한다. 값 또는 값의 일부를 출력하지 않는다.
5. backend가 private key 없이 시작하거나 public/private key pair가 불일치하면 push sender를 disabled로 두고 발송을 거부한다. session API, journal, SSE/reconnect는 계속 동작해야 한다.

## Rotation 및 폐기

1. rotation 전에 새 pair를 secret provider에 생성하고 새 public key를 배포 설정에 추가한다. old private key는 여전히 provider 안에만 둔다.
2. 새 public key를 제공하는 client 배포와 새 private key를 읽는 backend 배포를 완료한다. 구독 등록은 authenticated owner에 대해 새 key로 다시 수행하게 한다.
3. 등록 성공, owner-scoped persistence, 정상 발송, `404`/`410` 비활성화 처리를 비밀 없는 운영 지표로 확인한다. 실제 payload나 endpoint는 기록하지 않는다.
4. 활성 client가 새 key를 받았고 replacement subscription이 확인된 뒤 old key를 sender에서 제거한다. old-key subscription은 재발송하지 말고 사용자 재등록으로 수렴시킨다.
5. old private key를 provider에서 revoke/delete하고 runtime 접근 권한 및 audit trail을 확인한다. 유출 의심이면 같은 절차를 즉시 수행하고 영향 subscription을 fail closed로 비활성화한다.

## Subscription 운영 절차

1. UI는 HTTPS secure context, service worker readiness, Push API/Notification API 지원, authenticated owner를 모두 확인한 뒤에만 permission과 subscription을 요청한다.
2. permission이 `denied`, API가 미지원, service worker가 준비되지 않음, 등록 API가 실패함, owner가 없음 중 하나라도 있으면 구독을 만들거나 재사용하지 않는다. UI는 push가 선택 사항임을 표시하고 in-app/SSE 상태 확인을 유지한다.
3. subscription registration API는 현재 인증 owner만 저장/교체할 수 있어야 한다. 동일 owner의 token replacement는 원자적으로 새 record를 활성화하고 이전 record를 폐기한다.
4. 사용자의 disable/revoke 요청은 owner-scoped revoke endpoint와 browser `unsubscribe()`를 모두 시도한다. 어느 한쪽 실패도 성공으로 표시하지 않고, server revoke가 성공할 때까지 발송 대상에서 제외한다.
5. provider가 permanent failure (`404` 또는 `410`)를 반환하면 재시도하지 않고 해당 record를 즉시 비활성화/삭제한다. transient failure는 delivery 성공으로 기록하지 않으며 correctness 처리로 승격하지 않는다.

## Android Chrome 수동 QA (실기기 필수)

다음 항목은 실기기에서 수행 전까지 `PENDING`이다. Android emulator와 browser automation은 이 gate를 대체하지 못한다. 각 실행은 기기/Android/Chrome 버전, 앱 설치 상태, permission 상태, 네트워크 상태, 시작/종료 시각, 관측 결과만 기록한다. subscription endpoint, key, private data, push payload 원문은 기록하지 않는다.

| 시나리오 | 절차 | 기대 fail-closed 결과 |
| --- | --- | --- |
| 설치 | Android Chrome에서 HTTPS origin을 열고 PWA를 설치한 뒤 앱을 실행한다. | 설치 후에도 인증 없이 session 정보가 보이지 않는다. 지원/권한 조건이 충족될 때만 opt-in UI가 보인다. |
| permission 허용/거부 | 알림 opt-in에서 각각 Allow와 Don't allow를 시험한다. | Allow만 owner-scoped registration을 시도한다. Deny는 subscription/발송을 만들지 않고 앱의 권위 상태는 정상적으로 조회된다. |
| force-stop | 등록 후 Android Settings에서 PWA/Chrome을 force-stop하고 알림을 유발한다. 이후 앱을 다시 연다. | 전달 여부에 의존하지 않는다. 재실행 후 SQLite/API/SSE에서 권위 상태가 복구되고 tap/deep link도 재인증된다. |
| Doze | 등록된 기기를 Doze 상태로 두고 알림을 유발한 뒤 깨운다. | 지연 또는 미전달은 실패로 위장하지 않는다. 앱 재개 시 권위 API로 상태가 수렴한다. |
| token replacement | Chrome site data/notification registration을 교체시키는 정상 절차 후 재등록한다. | 새 subscription은 같은 owner에만 저장되고 이전 record는 폐기된다. 다른 owner가 새/이전 record를 조작할 수 없다. |
| revocation | 앱 UI와 Android/Chrome site permission에서 각각 알림을 철회한다. | server record는 발송 대상에서 제외된다. 이후 발송은 성공으로 표시되지 않으며 re-enable은 명시적 opt-in과 재등록을 요구한다. |
| tap 재인증 | notification을 탭한 뒤 로그아웃, 세션 만료, 다른 owner 로그인 상태를 각각 시험한다. | same-origin allowlisted 경로만 열리고 normal authz가 재검사된다. 원 owner가 아니면 session 내용을 노출하지 않는다. |

## Browser automation 경계

Automation은 same-origin URL validation, authenticated registration/revocation API의 owner isolation, permission-denied UI branch, permanent provider failure의 record invalidation, tap route의 reauthentication을 검증할 수 있다. 실제 Android Chrome 설치, OS notification permission UX, force-stop, Doze delivery, background process lifecycle, FCM token rotation 및 OS notification tap은 automation 결과로 통과 처리하지 않는다. 이 항목들은 위 실기기 checklist의 `PENDING` 상태로 남는다.

## 운영 판정

- 실기기 checklist의 필수 행이 하나라도 `PENDING`, `FAIL`, 또는 증거 없음이면 Android Web Push release gate는 통과하지 않는다.
- push sender 장애, key 주입 실패, subscription 파싱 실패, 허용되지 않은 deep link, owner 불일치는 모두 해당 push 동작을 거부/비활성화한다. 권위 session API를 대체하거나 mutation을 재시도하지 않는다.
- secret 값과 endpoint를 포함한 log/trace/artifact가 발견되면 배포를 중지하고 노출된 VAPID key를 rotation 절차로 폐기한다.
