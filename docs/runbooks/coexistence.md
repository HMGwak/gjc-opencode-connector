# NanoClaw Docker-only 공존 Runbook

- 근거: `.gjc/_session-019f6549-0ecd-7000-9041-95a2c3b971d8/plans/ralplan/019f6549-0ecd-7000-9041-95a2c3b971d8/pending-approval.md` §5.0, §8
- 적용: NanoClaw를 호출·포함·이미지 또는 unit으로 공유하는 모든 변경

## 불변 규칙

1. NanoClaw는 Docker 컨테이너 안에서만 실행한다. host에서 NanoClaw 프로세스를 시작하지 않는다.
2. NanoClaw용 launchd LaunchAgent/LaunchDaemon을 만들거나 공유하지 않는다.
3. NanoClaw와 planee-agent-hub는 이미지, 컨테이너, volume, 환경 파일, launchd unit을 공유하지 않는다.
4. hub의 외부 ingress는 Cloudflare Tunnel만 사용하며, hub HTTP listener는 `127.0.0.1:8787`에만 bind한다. 포트포워딩이나 public bind는 금지한다.
5. NanoClaw가 host에 노출할 포트는 운영자가 별도 승인한 Docker publish 규칙 외에는 없다. 미승인 port publish는 변경을 중단하고 제거한다.

## 포트·프로세스 경계

| 구성요소 | 실행 위치 | 허용 listener/publish | 금지 |
|---|---|---|---|
| planee-web | host | `127.0.0.1:8787` | `0.0.0.0:8787`, 직접 인터넷 노출 |
| cloudflared | host, 별도 관리 단위 | outbound tunnel | hub/NanoClaw와 unit 공유 |
| OpenCode | host | `127.0.0.1` bind | public bind |
| GJC Coordinator | host | workdir allowlist가 있는 MCP | Bridge HTTPS 기본 경로 |
| NanoClaw | Docker 전용 | 승인된 Docker publish만 | host 실행, launchd, hub 포트/volume 공유 |

## 배포 전 점검

1. NanoClaw 관련 명령이 Docker runtime/compose를 통해서만 실행되는지 확인한다. host binary, shell alias, launchd plist를 실행 경로에 넣지 않는다.
2. Docker 구성에서 NanoClaw service의 `ports`, `volumes`, `env_file`, image와 hub 구성요소의 동일 항목을 비교한다. 하나라도 공유하면 배포를 중단하고 분리한다.
3. hub listener가 loopback인지 확인한다. 재현 가능한 읽기 전용 확인 예시는 `lsof -nP -iTCP:8787 -sTCP:LISTEN`이며 결과가 `127.0.0.1:8787` 외 주소이면 fail closed 한다.
4. Docker 공개 포트를 확인한다. 재현 가능한 읽기 전용 확인 예시는 `docker ps --format '{{.Names}} {{.Ports}}'`이다. NanoClaw의 미승인 publish 또는 hub `8787` publish가 있으면 fail closed 한다.
5. launchd 등록 목록에서 NanoClaw 이름 또는 NanoClaw 실행 경로가 발견되면 해당 변경을 배포하지 않는다. NanoClaw를 구동하는 shared unit도 허용하지 않는다.

## 리소스 분리

- NanoClaw resource limit은 Docker service 단위로만 설정·관측한다. host-wide limit이나 hub service와의 공유 cgroup/compose service는 사용하지 않는다.
- CPU, memory, disk/volume quota의 수치는 Spike 또는 운영 관측으로 결정한다. 근거 없는 수치를 이 runbook에 고정하지 않는다.
- NanoClaw 컨테이너가 hub의 SQLite, secret store, workdir, socket 또는 로그 volume을 mount하면 즉시 중단한다.
- resource pressure가 발생하면 NanoClaw 컨테이너를 Docker 경계에서 제한/중지하고, hub의 인증·journal·ingress 경계를 약화시키지 않는다.

## 장애·변경 처리

- NanoClaw 장애를 해결하기 위해 host 실행이나 shared launchd를 임시 도입하지 않는다.
- port 충돌 시 NanoClaw를 hub 포트로 재매핑하지 않는다. 승인된 Docker port 정책을 다시 설계할 때까지 해당 NanoClaw 서비스는 중지 상태로 둔다.
- 이 경계를 바꾸려면 ADR 및 운영 검토를 먼저 갱신한다.
