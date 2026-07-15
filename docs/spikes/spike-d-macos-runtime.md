# Spike D — macOS 부팅·secret runtime 모델

- 조사일: 2026-07-15
- 안전 경계: 읽기 전용 local probe만 실행했다. 재부팅, 로그인/자동 로그인 변경, Keychain 읽기·쓰기, secret 생성, `launchctl bootstrap`/`bootout`/`kickstart`, production launchd plist 작성은 수행하지 않았다. NanoClaw는 host에서 시작하지 않았고 launchd job도 만들지 않았다.

## 검증된 근거

| 근거 | 확인 내용 | 등급 |
| --- | --- | --- |
| [Apple: Creating Launch Daemons and Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html) | system daemon은 boot 시, per-user agent는 사용자가 로그인할 때 해당 launchd 환경에서 로드된다. | 검증 |
| [Apple: Designing Daemons and Services](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/DesigningDaemons.html) | launch daemon과 user agent는 서로 다른 실행 문맥이며, daemon은 user session과 독립적으로 동작한다. | 검증 |
| local probe: `sw_vers; uname -m; sysctl -n kern.boottime; fdesetup status; launchctl print-disabled system` | 대상은 macOS 26.5.1 (25F80), arm64이고 현재 boot time은 2026-07-11 20:55:47이었다. FileVault 상태는 `Off`였다. system domain의 disabled-service 목록을 읽었을 뿐 job 상태를 변경하지 않았다. | 검증 |

## 모델 비교

| 항목 | A: user LaunchAgent + 자동 로그인 + Keychain | B: system LaunchDaemon + non-user secret store |
| --- | --- | --- |
| 기동 전제 | 대상 사용자의 자동 로그인이 성공해야 한다. | OS boot 후 system domain에서 기동하며 사용자 로그인은 전제가 아니다. |
| secret 접근 | 로그인 사용자 Keychain의 직접 사용을 전제한다. | Keychain user-session 의존을 제거하고 root 소유 파일 기반 secret store를 전제한다. |
| 물리 보안 | 자동 로그인은 콘솔 물리 접근 위험을 높인다. 계획상 FileVault가 필수 보완 통제다. | 자동 로그인 없이 운영할 수 있으나 root-context secret file의 소유자·mode·백업 경계를 별도 설계해야 한다. |
| 필요한 증명 | 자동 로그인 **활성** 상태의 실제 재부팅 후 health/secret 접근/외부 uptime을 관찰한다. | **비로그인** 상태의 실제 재부팅 후 health/secret 접근/외부 uptime을 관찰한다. |
| 현재 상태와의 관계 | FileVault가 `Off`이므로 계획의 Model A 보완 통제를 충족하지 못한다. | 현재 probe가 모델 B의 boot 또는 secret 접근을 증명하지는 않는다. |

## 가정

- Model B secret store의 경로·형식·rotation·권한은 아직 결정되지 않았다. `0600`은 계획의 최소 mode 가정일 뿐, 실제 owner/group·parent directory·backup exclusion을 포함한 완성 설계가 아니다.
- `planee serve`와 cloudflared의 start order는 health/readiness 기반으로 구현해야 한다. launchd의 load 순서가 애플리케이션 readiness를 보장한다는 가정은 하지 않는다.
- NanoClaw는 이 runtime 모델의 관리 대상이 아니다. NanoClaw를 호출·포함·이미지/unit 공유하는 경우에도 Docker-only를 유지하고 host launchd로 옮기지 않는다.

## Deferred physical test

아래 시험은 **실행하지 않았다**. 실제 재부팅 및 외부 네트워크 관측이 필요한 물리 시험이므로 결과를 주장하지 않는다.

1. Model A: FileVault를 정책상 충족시키고 자동 로그인을 명시적으로 활성화한 뒤, 실제 재부팅 → 로그인 후 LaunchAgent 기동 → Keychain secret 접근 → `/api/v1/health` → 외부 uptime monitor가 5분 이내 관측하는지 기록한다.
2. Model B: user login 없이 실제 재부팅 → LaunchDaemon 기동 → non-user secret store를 필요한 권한으로 읽음 → `/api/v1/health` → 외부 uptime monitor가 5분 이내 관측하는지 기록한다.
3. 두 시험 모두 reboot 전/후 boot identifier, process UID, health timestamp, secret 값 자체가 아닌 접근 성공 여부, 외부 monitor timestamp를 증거로 남긴다. failure도 동등하게 기록한다.

## 파라미터 권고

- **후보: Model B.** 자동 로그인과 사용자 Keychain에 의존하지 않아 headless 운영 목표에 부합한다.
- Model B를 확정하려면 secret store threat model(UID/GID, `0600`, parent directory 권한, rotation, backup/restore, log redaction)을 ADR-014에 기록하고 위 비로그인 reboot 시험을 통과해야 한다.
- Model A는 FileVault가 활성이고 물리 접근 위험을 명시적으로 수용하며 실제 reboot 증명이 있을 때만 재검토한다. 현재 local probe 결과로는 선택할 수 없다.

## Hard-gate 판정

**BLOCK.** Model A는 현재 FileVault precondition을 충족하지 않고, Model B도 비로그인 실제 재부팅/secret-read/uptime 증거가 없다. production launchd plist를 커밋·생성·기동하지 않은 상태를 유지하며, ADR-014 확정 및 Phase 1 runtime 구현은 Model B physical test가 성공할 때까지 보류한다.
