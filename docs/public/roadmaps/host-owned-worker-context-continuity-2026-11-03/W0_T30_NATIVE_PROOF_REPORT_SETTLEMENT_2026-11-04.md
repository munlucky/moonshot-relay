# W0 T30 — 실제 Native Worker → 사전 검증 → Owner CAS → Kernel Report/Proof 정착

- 날짜: **2026-11-04**
- 코드 기준선: `main / 4f1ed1b0a84cd51f07e8ed06f9882fa4dfa9a129`
- 최종 판정: **Mac 실제 Native 병렬 Worker 2개 및 기존 Kernel Proof·Report·Owner CAS E2E 2/2 PASS** (정상 승인과 통합 Proof 거부). **Host–Kernel 메서드 수신자 누락 버그 1건을 최소 코드 변경으로 해결**. 임의 Native OS 후손 전체 종료·안전 폐기, 운영 기본 Dispatcher 전환, T24/T26 재시작은 **NOT VERIFIED**. **G0 PARTIAL / W1 DEFER.**

## 1. T29와 구분하는 목표

[T29](W0_T29_CANONICAL_AB_NATIVE_OWNER_CAS_2026-11-04.md)는 실제 Canonical Attempt A Writer가 살아 있을 때 B의 Native `command/exec` 변경을 Owner CAS로 한 번만 반영했다. 하지만 Worker Report 및 Kernel Proof 승인까지 확인하지 않았다.

T30은 기존 **`dispatchKernelParallel`**이 소유한 신뢰 경계를 직접 시험한다. 순서를 새로 정의하지 않는다.

1. Kernel은 독립된 두 Step·Attempt, 물리 Git Worktree 및 Workspace ID를 만든다.
2. Host는 두 실제 Codex App Server의 격리 `command/exec`를 각각 실행한다. 모델 호출은 하지 않고 실행 명령을 테스트가 고정한다.
3. Worker는 자신의 변경 경로·검증 힌트를 Report에 제출한다. Host는 Git 결과를 커밋하고 Canonical Attempt에 **원본 Worker Report·결과 커밋·경로·Patch Digest**를 정착한다.
4. Host의 통합 Worktree에서 **실제 `test:ok` 프로젝트 검증 명령**을 실행한다. **실패 시 Owner에 패치를 적용하지 않는다.**
5. 통합 검증이 통과하면 기존 Owner Mutation Fence의 취득·갱신·적용 전 검증과 `git apply`·Mutation CAS로 Owner의 변경을 한 번 반영한다.
6. **Owner Delivery 이후** `settleParallelResult`가 영속 Attempt 영수증, Delivery provenance·Identity·Revision·변경 경로를 비교하고 Kernel이 정한 Proof를 실행한다. 통과한 Report만 Step `passed`를 얻는다.

중요한 순서 제약: **일반 `Kernel.report()`로 분리된 B Worktree를 Owner Delivery 전에 승인할 수 없다.** 그 경로는 Owner의 실제 Git 상태를 권위로 삼는다. 병렬 Worker의 사전 허가 조건은 *통합 검증*, Report의 최종 정착은 *Owner CAS 이후의 `settleParallelResult`*이다. 이를 바꾸려고 새 Report DB·승인 API·모델 규칙을 추가하지 않았다.

## 2. 실제 Mac 검증 중 발견한 Host–Kernel 결함

첫 정상 Native 실행은 Worker 두 명령과 통합 검증·Owner CAS를 통과한 뒤, **`settleParallelResult`에서 TypeError**로 중단됐다.

- 원인: `src/host/kernel/parallel-dispatcher.ts`가 `const settleParallelResult = controlPlane.settleParallelResult`로 메서드를 꺼내 비결합 함수로 호출했다.
- 실제 `src/kernel/control-plane.ts`의 `settleParallelResult`는 `this.resolveParallelSettlementStep` 및 `this.reportUnderLease`를 참조한다. `this`가 소실되면 실제 Control Plane은 동작하지 않는다.
- 앞선 real Control Plane 회귀는 `settleParallelResult`를 별도 Arrow 래퍼로 감싸 호출했기 때문에 이 문제가 드러나지 않았다.
- 수정: 기존 메서드를 **`controlPlane.settleParallelResult.bind(controlPlane)`**로 한 번 바인딩한다. 다른 Delegate 계층·재시도·폴백·새 DB는 추가하지 않는다.
- Linux 재발 방지: `tests/kernel-parallel-dispatch.test.ts`에 **래퍼 없이 진짜 Control Plane을 전달**하는 회귀를 추가했다. 영속 Worker Result, Owner CAS, 두 Step Report/Proof 및 Mutation provenance를 확인한다.

첫 Mac 실패 영수증: `operationId=dad4ebf4-cb19-4fa6-bc6c-97e3e133425f`, 정상 케이스에서 `TypeError: Cannot read properties of undefined (reading 'resolveParallelSettlementStep')`. 이 상태는 **Owner CAS 완료·Report 정착 미완료**였고, 성공으로 판정하지 않았다. 해당 테스트는 모든 명령이 동기 종료한 독립 임시 디렉터리에서 실행됐으며, 테스트 전용 Git Worktree 세 개와 Root만 별도로 검증 후 정리했다(`operationId=714cbe5c-e08e-43c4-80ce-10c5900905ba`, exit 0). 운영 Native Attempt/예약을 폐기하지 않았다.

## 3. 수정 후 실제 Mac Native E2E

Mac Node `v24.6.0`, Codex CLI `0.162.1`, W0 전용 `CODEX_HOME` 및 임시 Clone에서 **실제 Native `command/exec`**를 호출했다. 두 Test Case 모두 실제 Codex App Server Worker **2개씩** 실행됐다. `node verify.cjs`가 실행하는 프로젝트 소유 `test:ok`는 통합 소스의 `src/alpha/result.txt=alpha`, `src/beta/result.txt=beta`를 검사한다.

| 확인 항목 | 정상 Report/Proof 수용 | 통합 Proof 실패 |
| --- | --- | --- |
| 실제 Native Worker 2개 | PASS | PASS |
| 두 독립 Canonical Workspace ID | PASS | PASS |
| 통합 Worktree `test:ok` | PASS | **FAIL을 정확히 검출** |
| Owner CAS Delivery | **1회 적용** | **미실행** |
| Owner Mutation Revision | `0 → 1` | `0 유지` |
| Kernel Worker Report 정착 | **2건, Step passed** | **0건** |
| 영속 Worker Result/Proof Evidence | PASS | 승인되지 않음 |
| 중복 정착 요청 | 기존 상태를 두 번째 Step passed로 만들지 않음 | 해당 없음 |
| 사용자 Owner Git 내용 | alpha/beta 정확한 값 | 변경 없음 |
| 결과 | **PASS** | **PASS(거부 기대 동작)** |

- 실제 Mac 재시험 **2 PASS / 0 FAIL / T29 전용 1 SKIP**.
- 영수증 `operationId=ab1d7418-4d1f-4a7f-9367-0537e8be1bcf`, exit 0.
- 정규 재사용 테스트는 `tests/kernel-native-canonical-attempt-delivery.test.ts`에 추가했다. `W0_NATIVE_PROOF_CONFORMANCE=1`, macOS, **격리된 CODEX_HOME**이 있어야만 실행된다. 제품 실행에는 영향을 주지 않는다.
- 실패 경로도 실제 Native Worker가 성공적으로 파일을 생성한다. 단, `invalid-alpha`를 쓴 채 통합 Proof로 들어가므로 Owner에 적용되기 전에 거부된다. **Native exit 0을 승인으로 혼동하지 않는다.**
- 증거는 임시 Mac W0 Clone의 `t30-native-proof-test-2.log`에 남겼다. 기존 사용자 Mac 저장소는 clean 상태로 유지했다.

## 4. Linux 회귀와 복잡도 검토

Linux MCP는 소스 변경을 임시 `git archive` checkout에 Overlay하고 별도 `npm ci --include=dev`를 수행했다. 운영 Codex 설치·node_modules는 변경하지 않았다.

- TypeScript `typecheck` PASS
- 제품 Runtime `build` PASS
- `build:tests` PASS
- 실 Control Plane 무래퍼 메서드 회귀 포함 집중: **20건 중 17 PASS·3 OS 전용 SKIP·0 FAIL**.
- 확대 11개 Test Suite: **101건 중 96 PASS·5 OS 전용 SKIP·0 FAIL**.
- `check:boundaries` PASS, **9 modules / 311 files / 849 dependency edges**.
- Roadmap 문서·링크와 Git diff 검증 후 main에 단계별 상세 커밋·푸시한다.
- 제품 코드 변경은 **Host Dispatcher의 Receiver 바인딩 한 곳**뿐이다. 두 Test File의 회귀·Mac Opt-in 시나리오와 결과 문서를 제외한 추가 상태·스키마·환경 분기는 없다.

## 5. 수용 범위·다음 단계

**통과:** 실제 Mac Native Worker가 만든 결과를 기존 Host가 통합·검증하고 Owner CAS로 한 번 반영한 뒤, 기존 Kernel이 영속 Worker Receipt와 Delivery를 대조하여 Report/Proof를 승인하는 흐름. 잘못된 결과는 Owner 적용 이전 통합 Proof에서 거부한다. Host–Kernel 메서드 Receiver 결함은 격리 회귀로 제거했다.

**여전히 미검증:** 정상 모델 Tool 호출로 생성한 임의 OS 자식·후손 전체 격리 및 종료·쓰기 정착, 기존 T25~T29 운영 Attempt 예약·Worktree의 안전 폐기, Main/MCP/Host 연결 상실 시 동일 명령 중복 방지, T24 Goals/Dispatcher 중복 실행, Linux/Windows Native 및 분산 파일시스템, 일반 Native Dispatcher의 기본 적용. 이번 `command/exec`는 테스트 코드가 고정한 동기 Node 작업이며 모델이 임의로 프로세스를 생성한 것은 아니다.

**다음 권고:** 실제 Native 연결 상실과 Worktree 보존·재조회(T26), 기존 T24 중복 진입 확인 및 모든 Writable 경로의 OS 샌드박스 수용 범위를 순차 검증한다. G0가 PASS 전까지 W1 기본 전환은 보류한다.

**최종 G0 PARTIAL / W1 DEFER.**
