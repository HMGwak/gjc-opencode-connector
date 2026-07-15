# ADR-012: Origin API 인증·인가 및 CSRF 경계

- 상태: 채택
- 결정 출처: `.gjc/_session-019f6549-0ecd-7000-9041-95a2c3b971d8/plans/ralplan/019f6549-0ecd-7000-9041-95a2c3b971d8/pending-approval.md` §6.2, §12, §20

## Decision

Cloudflare Access는 첫 번째 경계일 뿐 인증의 유일한 근거가 아니다. origin은 모든 보호 API 요청에서 JWT의 issuer, JWKS 서명, audience, 만료 및 clock skew를 직접 검증한다. 검증 정보가 없거나 JWKS 조회·로테이션 중 검증을 완료할 수 없으면 fail closed로 `401`을 반환한다. 인증되었으나 사용자·세션·프로젝트 권한이 맞지 않으면 `403`을 반환한다.

쿠키 기반 mutation에는 SameSite와 Origin 검증 또는 CSRF 토큰을 함께 적용한다. SSE와 Push subscription 생성·해지도 같은 사용자/세션/프로젝트 인가를 요구하고 rate/size limit을 적용한다. PWA는 CSP를 적용하고 Service Worker 캐시에 API 응답을 저장하지 않는다.

JWT issuer, audience, JWKS 위치, 허용 clock skew 값 및 CSRF 방식의 구체값은 secret이나 환경별 설정을 문서에 넣지 않고 구현 시 안전한 설정으로 제공한다.

## Drivers

- 외부 노출 표면은 Cloudflare Tunnel/Access 뒤에 있어도 origin 우회 또는 잘못된 edge 신뢰를 방어해야 한다.
- 모바일의 mutation, SSE, Push 구독은 최소 권한으로 제한해야 한다.
- 단일 운영 환경에서도 인증 실패를 허용하는 fail-open 동작은 허용할 수 없다.

## Alternatives

- Cloudflare Access 헤더만 신뢰: origin 자체의 인증 경계가 없어져 채택하지 않는다.
- JWT 검증을 edge에만 위임: edge 설정 오류·우회에 대한 독립 방어가 없어 채택하지 않는다.
- CSRF 방어 없이 SameSite에만 의존: cookie mutation의 요청 출처 검증이 불충분하므로 채택하지 않는다.

## Consequences

- origin에 JWKS cache/rotation 및 JWT 검증 구현이 필요하다.
- Access 정책과 origin 권한 모델을 각각 유지·검증해야 한다.
- 인증 또는 CSRF 검증을 통과하지 못한 요청은 기능 저하로 전환하지 않고 거부된다.

## Follow-ups

- **Spike 증거 필요:** 실제 Access/Tunnel과 origin 경계의 배포 구성은 구현 전 loopback 시험으로 확인한다. Spike 결과가 issuer/audience 전달 방식에 영향을 주면 이 ADR을 갱신한다.
- JWT/CSRF secret, VAPID private key, provider key는 DB·문서·audit log에 저장하지 않는다.

## Test obligations

- loopback에서 (1) 유효 JWT 허용, (2) 만료 JWT `401`, (3) 위조 또는 issuer/audience 불일치 JWT `401`의 세 경우를 검증한다.
- 인증된 타 사용자·세션·프로젝트 요청은 `403`인지 검증한다.
- cookie mutation의 Origin/CSRF 실패가 거부되는지, SSE/Push subscription 해지까지 동일 인가가 적용되는지 검증한다.
- API 응답이 Service Worker cache에 기록되지 않고 audit log가 secret-free인지 검증한다.
