# W2 결과 — 필수 검증·외부 의존성 차단의 권위 분리

- 확인일: 2026-10-31 KST
- 실행 환경: `/shared/moonshot-relay`, Linux; 코드 기준선 `6edf507545de88fc3a3691cb05d6a7513de60233`.
- 작업 추적: `e910ed34-c83b-47d0-8b0d-9006cac40ff3`.
- **판정: W2 PASS (확인된 권위 오류 2건 수정·회귀)**. C03의 독립 작업 중단 인과는 증명하지 못했다. 통합 W0~W10은 완료가 아니다.

## W2 적용 기준

필수 증명을 통과하기 전 개발 구현은 진행할 수 있어야 하지만, 실제 완료 판정에 필요한 Hard Evidence나 안전 경계를 제거하면 안 된다. 따라서 구현 진입·증명 단계·안전 차단을 구분한다. 동일한 차단 분류는 Kernel에서 결정하고, 모델이 제출한 `report.blocker`의 주장으로 바꾸지 않는다.

## 실제 결함 1 — 외부 Report가 차단 권위를 바꿀 수 있었음

기존 `src/kernel/control-plane.ts`에서 `report.blocker.blockingClass`가 `blockRun`으로 전달돼 있었다. 완전 격리 Run에서 `reason=unsafe-command`, `blockingClass=completion`을 제출하자 SQLite에 **`blockedReason=unsafe-command`, `blockingClass=completion`**이 저장되는 것을 재현했다. 즉 안전성을 요구하는 차단을 호출자/모델 주장으로 낮출 수 있었다. Run 자체는 계속 `blocked`여서 이 실험에서 무단 실행은 없었다.

**수정:** 기존 `resolveWorkBlockingClass`가 `reason`을 기반으로 권위를 결정하도록 호출자 제공 분류 전달을 제거했다. 별도 Classifier/규칙/DB 필드는 추가하지 않았다.

**검증:** 양방향 주입을 한 실제 격리 Run에서 `unsafe-command + caller completion → safety`, `external-dependency + caller safety → completion`을 확인했다. Run은 두 경우 모두 `blocked`로 유지됐고, `kernel next`의 분류도 일치했다. 미입증 작업을 자동 승인하거나 무조건 재개하도록 바꾸지 않았다.

## 실제 결함 2 — 구형 차단 기록이 모두 safety로 표시될 수 있었음

W0에서 만든 일관 SQLite 백업 사본(운영 원본 **읽기 전용**)의 `runs`를 집계했다.

| `blocked_reason` | 상태가 blocked인 Run 수 | `blocking_class` |
|---|---:|---|
| `unsupported-verification` | 18 | `NULL` |
| `external-dependency` | 7 | `NULL` |
| `question` | 2 | `NULL` |

기존 `src/kernel/run/run-loop.ts`는 `run.blockingClass || 'safety'`를 반환했다. 이 때문에 기존 완료 조건 차단 27건의 표시가 safety로 격상될 수 있었다. 실 운영 기록 자체를 수정하거나 삭제하지 않았다.

**수정:** 저장된 명시적 분류가 없을 때만 기존 `resolveWorkBlockingClass(run.blockedReason)`를 사용한다. 명시적 `safety`는 그대로 유지하고, 알 수 없는 사유도 기존 함수에 따라 safety로 유지한다. 새 추정 규칙이나 영속 마이그레이션을 추가하지 않았다.

**검증:** legacy `unsupported-verification`, `external-dependency`, `question` → completion; `unsafe-command`, `network-policy` → safety; 기존 명시적 safety는 유지. 바뀌는 것은 복구/모델 가시 분류이지 blocked Run의 승인·재개 상태가 아니다.

## 원래 C03/C04 계획과 구현 연속성 경계

- **C04 필수 검증 부재:** 기존 `kernel-progressive-admission` 회귀에서 명령이 없는 Run도 `startRun`·`EXECUTE`와 `implement`까지 정상 진행한다. `PROVE`에서 필수 증명이 해결되지 않으면 `unsupported-verification`으로 blocked가 된다. 이후 올바른 프로젝트 명령을 제공하면 기존 동적 Rebinding이 활성화된다. 임의의 다른 명령을 증명으로 대체하지 않는다.
- **C03 외부 의존성:** 백업 사본에는 blocked/external-dependency Run 7건(FRAME 2, PROVE 5)이 있었다. 이 사실은 외부 차단 기록이 존재함을 입증하지만, **그 시점에 독립적으로 안전한 미완료 구현 작업이 실제로 남았다는 인과는 입증하지 못한다.** Explicit `report.blocker`는 사용자/Agent가 선언한 진짜 차단일 수 있다. 따라서 독립 작업을 자동으로 재개하는 새 authority, 우회 경로, 강제 unblock 규칙은 만들지 않았다. 이후 실제 반례가 확보되면 C03을 별도 재개 검증 대상으로 연다.
- **Safety 보존:** `unsafe-command`·`network-policy`는 여전히 safety, 명시적인 차단 Run은 계속 blocked. Migration rollback/Smoke 및 Protected Obligation을 완화하지 않았다.

## 검증 결과와 비용

- 수정 소스: `src/kernel/control-plane.ts`, `src/kernel/run/run-loop.ts`의 기존 경계 두 곳. 새 DB·Schema·Host 분기·모델 지침 없음.
- 회귀: `kernel-host-loop-e2e`, `kernel-progressive-admission`, `kernel-preflight-execution-first`, `kernel-migration-workflow`, `kernel-agent-recovery` 격리 실행 **49/49 PASS**.
- 동일 코드의 별도 Linux overlay에서 Runtime 빌드·테스트 산출물 빌드, TypeScript 7.0.2 native `--noEmit`, `--boundaries`, `--check`, `--tests --check`를 검증. 소스 작업 트리의 Windows 공유 설치를 덮어쓰지 않았다.
- 첫 isolated 테스트 실행의 4건 실패는 `build:tests` 누락으로 `dist/tests/*.mjs`가 없었던 테스트 설정 오류다. 정상 테스트 산출물을 생성한 뒤 위 49건을 통과했다. 첫 실패를 제품 결함으로 승격하지 않았다.
- `skills/explain-diff-html/scripts/render.py`의 일시적 Git modified 표시가 반복됐으나 정규화한 원문은 HEAD와 동일한 CRLF/LF 차이였다. 해당 파일은 변경·원복·커밋 대상에 포함하지 않는다.

## 다음 Wave

W3-A는 W0의 실제 파일 반영 안전 반례에서 현행 P0 결함이 입증되면 수행한다. W3-B는 승인 후 Git 전달·Identity 사용 지점 복구를 소유한다. W2에서 W3의 책임을 중복 구현하지 않았다. 다음 독립 Wave로 진행하되 W0/W1/W2의 회귀 근거를 재사용한다.
