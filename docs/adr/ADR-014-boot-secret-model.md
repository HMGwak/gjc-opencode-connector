# ADR-014 — Boot/Secret 운영 모델

## 상태

Phase 0 검증 대기. 실제 재부팅 증거 전에는 production launchd 구성을 만들지 않는다.

## Decision

두 후보를 독립적으로 검증한다.

- 모델 A: 사용자 LaunchAgent, 자동 로그인, 사용자 Keychain. 자동 로그인 활성 상태의 실제 재부팅으로 검증하며 FileVault와 물리 접근 위험을 명시적으로 수용해야 한다.
- 모델 B: system LaunchDaemon, 비사용자 secret store(`root:wheel`, mode `0600`). 로그인하지 않은 실제 재부팅으로 검증한다.

두 실험 중 운영 요구를 충족하는 하나만 최종 선택한다. 그전에는 앱이 secret을 환경 변수, SQLite, 로그 또는 저장소에 저장하지 못하게 한다.

## Drivers

- 재부팅 후 무인 복구
- secret의 최소 노출
- 단일 Mac mini 운영의 단순성

## Alternatives considered

- 두 모델을 동시에 지원: 운영·감사 표면이 불필요하게 커져 기각.
- 평문 저장소 secret: 기각.
- 자동 로그인 없이 사용자 Keychain 사용 가능하다고 가정: 검증되지 않아 기각.

## Consequences

실제 재부팅 시험 전 Phase 0 Gate 4는 `DEFERRED`다. 외부 uptime monitor가 5분 내 실패를 감지해야 한다. 모델 A는 물리 접근 위험, 모델 B는 GUI/Keychain 편의성 상실을 동반한다.

## Verification

1. 모델 A 전용 test secret으로 자동 로그인 재부팅 후 앱 접근과 로그 비노출을 관측한다.
2. 모델 B 전용 test secret으로 비로그인 재부팅 후 동일 항목을 관측한다.
3. 각 모델에서 cloudflared와 hub의 시작 순서, 실패 복구, 외부 health 감지를 기록한다.
4. 실제 credential 대신 회전 가능한 test secret만 사용한다.

## Follow-ups

Spike D 결과, 선택 모델, 위험 수용자, 재현 명령과 타임스탬프를 이 문서에 반영한 뒤 Gate 4를 재판정한다.
