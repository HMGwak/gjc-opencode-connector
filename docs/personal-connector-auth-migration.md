# 개인용 Connector 인증 단순화 인수인계

## 목표

Cloudflare Access, 조직 로그인, MFA, App Launcher에 의존하지 않고 Android 개인 앱이 Hub에 연결되게 한다. 사용자는 최초 기기 등록 이후 매번 브라우저 로그인이나 MFA를 수행하지 않는다.

이 문서는 구현 작업의 순서와 완료 기준이다. 실제 비밀값, pairing code, device token, Cloudflare token은 문서·저장소·로그·테스트 fixture에 기록하지 않는다.

## 2026-07-16 저장소 기준 상태

- Hub 구현과 배포 plist에는 Cloudflare Access JWT verifier, issuer/AUD/JWKS 설정이 없다. `agents.myplanee.com`은 Cloudflare Tunnel을 거쳐 Hub로 연결되고, Hub API는 기기 credential을 검사한다.
- Android 앱은 최초 1회 **숫자 6자리** pairing code로 등록한다. code는 기본 5분 후 만료되고 한 번만 사용할 수 있으며, 서버는 시도 횟수를 제한한다.
- pairing 성공 뒤에는 기기별 credential으로 자동 연결한다. 앱 흐름에는 Cloudflare 로그인, 조직 MFA, App Launcher가 없다.
- credential은 Android 앱 전용 `SharedPreferences`에 저장한다. 이 앱은 `allowBackup=false`이며, 개인 단일 사용자 환경을 위해 Keystore 암호화 대신 이 단순한 저장 방식을 사용한다. 분실·root된 기기에 대한 보호 수준은 Keystore보다 낮다.
- 배포 plist는 Hub를 macOS LaunchDaemon `system/com.planee.agent-hub`로 실행하도록 구성하고, 데이터와 pairing root secret 경로를 `/var/db/planee-agent-hub/`로 지정한다. 실제 설치·실행 상태는 이 저장소만으로 확인할 수 없다.
- Cloudflare Access application/policy의 삭제 여부와 Zero Trust 조직 상태는 외부 제어면 증적이 없으므로 이 문서에서 완료로 주장하지 않는다.

## 지켜야 할 경계

```text
Android 앱 -- TLS --> agents.myplanee.com -- Cloudflare Tunnel --> 127.0.0.1:8787 Hub
```

- Hub는 계속 `127.0.0.1:8787`에만 bind한다.
- Tunnel/DNS/ingress와 router port-forwarding은 변경하지 않는다.
- Cloudflare Access 제거 여부는 외부 제어면에서 별도로 확인한다. 새 기기 인증을 구현·검증하고 이전 Hub 배포본을 복원할 수 있을 때에만 제거한다.
- "인증 없음"으로 public hostname을 열지 않는다. 외부에서 추측 가능한 공유 비밀번호 하나로 보호하는 방식도 사용하지 않는다.

## 목표 사용자 경험

1. 새 Android 기기에서 앱을 연다.
2. 소유자가 Hub의 로컬 관리 경로에서 짧은 수명의 1회 pairing code를 만든다.
3. 앱이 pairing code를 한 번 제출하고 기기 전용 credential을 안전한 Android 저장소에 보관한다.
4. 이후 앱은 credential으로 자동 연결한다. 일상 사용 중 Cloudflare 로그인·MFA·Launcher는 없다.
5. 소유자는 분실 기기를 Hub에서 즉시 revoke할 수 있다.

## 구현 작업

### 1. 인증 모델 확정

- [x] ADR-014의 운영 secret 모델을 먼저 확정한다. Hub가 재부팅 뒤에도 pairing root secret을 안전하게 읽을 수 있어야 한다.
- [x] `docs/adr/`에 기기 credential 형식, 만료·회전·폐기, Android 저장 위치, 복구 절차를 결정한 ADR을 추가한다.
- [x] 서버가 저장하는 값은 credential 원문이 아닌 검증 가능한 최소 정보(예: 해시 또는 공개키)로 제한한다.
- [x] pairing code는 1회 사용, 짧은 만료, 실패 횟수 제한, 감사 이벤트를 가진다.

### 2. Hub 인증 경계 교체

- [x] `apps/hub/src/server.ts`의 Cloudflare Access JWT 전용 인증 경계를 기기 credential 검증으로 교체한다.
- [x] 현재 Access JWT verifier와 Cloudflare issuer/AUD/JWKS 런타임 의존성을 제거한다.
- [x] 모든 `/api/v1/*` 보호 endpoint에 새 인증과 owner/session 권한 검사를 적용한다.
- [x] pairing 생성·등록·기기 목록·revoke 관리 경로를 최소 권한으로 구현한다. 생성·목록·revoke는 root secret을 외부 API로 보내지 않는 로컬 CLI다.
- [x] 누락·revoke·위조 credential은 `401` 또는 `403`으로 fail closed 한다. pairing code의 만료·재사용·시도 횟수 초과도 거부한다.
- [x] audit log에는 기기 식별자와 결과만 남기고 credential, Authorization header, pairing code를 남기지 않는다.

### 3. Android 앱 연결 흐름 구현

- [x] Capacitor/Android의 앱 전용 저장소에 기기 credential을 보관한다. 웹 localStorage, bundle, source, 로그에는 저장하지 않는다.
- [x] 첫 연결 화면에 pairing code 입력과 성공·만료·이미 사용됨·네트워크 실패 UX를 구현한다.
- [x] 정상 실행 시 저장된 credential을 자동으로 `Authorization: Bearer` 요청에 붙인다.
- [x] credential이 revoke되면 자동 재시도 루프 대신 pairing 화면으로 명확히 전환한다.
- [ ] 새 APK 설치 후 최초 pairing을 실기기에서 검증한다.
- [ ] 앱 재시작, 기기 revoke 뒤 재등록을 실기기에서 추가 검증한다.

### 4. 테스트와 전환

- [x] Hub unit/integration tests: 정상 기기, credential 없음, 위조 credential, 만료 pairing code, 재사용 pairing code, revoke 후 요청, 다른 owner의 session 접근을 추가한다.
- [ ] Android 실기기에서 최초 pairing 후 앱 재시작과 네트워크 재연결이 로그인 없이 동작함을 확인한다.
- [x] 익명 `curl`은 `401`이어야 하며 Hub 데이터를 반환하지 않는다.
- [x] Hub listener는 계속 `127.0.0.1:8787`에만 열려 있다.
- [ ] Tunnel을 재시작한 뒤 Android 자동 재연결을 확인한다.

### 5. Cloudflare Access 제거 (마지막 단계)

- [ ] `Planee Agent Hub` Cloudflare Access application과 관련 policy를 외부 제어면에서 삭제했음을 확인한다.
- [ ] App Launcher와 조직 MFA가 다른 Access application을 보호하지 않음을 외부 제어면에서 확인한다.
- [ ] `agents.myplanee.com`이 Tunnel을 통해 Hub에 도달하고 credential 없는 API 요청이 Hub에서 `401`으로 거부됨을 공개 경로에서 재검증한다.
- [x] `docs/runbooks/cloudflare-access.md`와 PRD의 Access/MFA/JWT 서술을 새 기기 pairing 모델에 맞게 갱신했다.

## 완료 기준

- Android 개인 앱은 최초 pairing 뒤 브라우저·Cloudflare 로그인·MFA 없이 Hub를 사용한다.
- 분실 기기 revoke는 즉시 이후 API 요청을 막는다.
- public hostname에 인증 없는 요청은 Hub data/API에 접근할 수 없다.
- origin은 계속 loopback-only이며 Tunnel 이외의 인터넷/LAN 노출이 없다.
- Hub의 Cloudflare Access JWT 검증 의존성은 제거되었고, 관련 문서와 테스트가 새 기기 credential 모델을 설명한다.

## 롤백

현재 Hub에는 Cloudflare Access JWT 검증 경로가 없으므로 Access application만 복원해서는 이전 앱을 사용할 수 없다. 전환 뒤 문제가 발견되면 Cloudflare Access application/policy와 Access JWT를 검증하던 이전 Hub 배포본을 함께 복원한다. 새 credential 방식과 기존 Access JWT를 동시에 허용하는 임시 우회는 만들지 않는다. 롤백은 공개 hostname을 인증 없이 여는 방식이 아니어야 한다.

## 운영 절차

### 새 기기 pairing code 발급

관리자 권한이 있는 macOS 셸에서 실행한다. 출력된 숫자는 민감한 일회용 code이므로 문서나 채팅 기록에 남기지 않는다.

```sh
cd /Users/planee/Automation/codeconnector/apps/hub
sudo env \
  HUB_DATABASE_PATH=/var/db/planee-agent-hub/hub.sqlite \
  HUB_OWNER_ID=planee \
  HUB_PAIRING_ROOT_SECRET_FILE=/var/db/planee-agent-hub/pairing-root-secret \
  /Users/planee/.bun/bin/bun run admin -- create-pairing
```

### 기기 목록과 폐기

```sh
cd /Users/planee/Automation/codeconnector/apps/hub
sudo env HUB_DATABASE_PATH=/var/db/planee-agent-hub/hub.sqlite HUB_OWNER_ID=planee HUB_PAIRING_ROOT_SECRET_FILE=/var/db/planee-agent-hub/pairing-root-secret /Users/planee/.bun/bin/bun run admin -- list-devices
sudo env HUB_DATABASE_PATH=/var/db/planee-agent-hub/hub.sqlite HUB_OWNER_ID=planee HUB_PAIRING_ROOT_SECRET_FILE=/var/db/planee-agent-hub/pairing-root-secret /Users/planee/.bun/bin/bun run admin -- revoke-device '<device-id>'
```

### APK 재빌드와 OneDrive 교체

```sh
cd /Users/planee/Automation/codeconnector
env JAVA_HOME=/opt/homebrew/opt/openjdk@21 ANDROID_HOME=/opt/homebrew/share/android-commandlinetools ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools PATH=/opt/homebrew/opt/openjdk@21/bin:$PATH bun run build:android
```

생성물은 `android/app/build/outputs/apk/debug/app-debug.apk`이다. OneDrive 루트의 대상은 `/Users/planee/Library/CloudStorage/OneDrive-ktng.com/app-debug.apk`이다. Finder로 기존 APK를 삭제한 뒤 새 APK를 복사한다. File Provider 영역이므로 `cp`, `mv`, `rm`으로 직접 조작하지 않는다.

### Hub 재시작과 확인

Hub TypeScript를 수정한 뒤에는 실행 중 프로세스가 이전 코드를 계속 들고 있을 수 있다. 아래처럼 LaunchDaemon을 재시작한다.

```sh
sudo launchctl bootout system/com.planee.agent-hub || true
sudo launchctl bootstrap system /Library/LaunchDaemons/com.planee.agent-hub.plist
sudo launchctl kickstart -k system/com.planee.agent-hub
```

`/api/v1/health`는 유효한 기기 credential 없이는 `401`을 반환한다. `/`의 응답은 배포된 `HUB_WEB_ROOT`의 정적 파일 존재 여부에 따라 달라 고정된 `200` 상태 확인으로 사용하지 않는다. `/api/v1/pairings/redeem`은 최초 등록을 위해 의도적으로 인증 없이 열려 있으므로, 실제 pairing code를 상태 확인용으로 제출하지 않는다. `bootstrap`이 간헐적으로 `Input/output error`를 낸 경우에는 `bootstrap`과 `kickstart`를 다시 순서대로 실행한 뒤 서비스 로그와 인증된 health 요청으로 확인한다.
