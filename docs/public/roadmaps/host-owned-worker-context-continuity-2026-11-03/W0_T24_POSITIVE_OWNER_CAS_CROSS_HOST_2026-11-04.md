# W0 T24 — 두 독립 Host의 정상 Worker 결과 및 Owner CAS 경쟁 (2026-11-04)

## 판정

- **Linux 실제 독립 Host 2개 / 동일 Canonical SQLite Runtime:** 전체 정상 배치 1회 Owner Delivery + Step Report/Proof 2건 PASS. 분할 선점의 충분한 통합 Proof 실패 시 Owner Revision 0 PASS.
- **약한 Proof를 사용하는 분할 선점:** 수정 전 **RED** — 하나의 정상 Worker만 포함한 부분 결과가 Owner Revision **0→1**로 반영됐다. 수정 후 **GREEN** — 명시적 `STEP_ATTEMPT_ALREADY_CLAIMED` 감지 시 integration/Delivery를 건너뛰며 Rev 0 유지, 두 Host의 Step·Worker 상태와 Worktree 보존.
- **Mac 실제 Native Codex App Server `command/exec` 최종 수정본:** 첫 전체 실행에서 **2 PASS / 1 FAIL**. 전체 배치 소유 Host A의 alpha Native 성공 기록이 없고 `worker-report-missing`으로 실패했다. 당시 원래 Native 예외 메시지는 저장되지 않아 원인 미확정이다. 같은 소스와 제품 수정으로 진단 단일 소유 **1 PASS**, 추가 단일 소유 **3회 PASS**, 마지막 전체 세 시나리오 **3 PASS / 0 FAIL**을 확인했다. 실패 기록은 성공 결과로 덮어쓰지 않는다.
- **전체 G0 PARTIAL / W1 DEFER.** 이 검증은 Step 선점·부분 Delivery 차단을 증명하지만, 앱 Goals 자동 진입, 유실 Native RPC 핸들 재연결, 임의 OS 후손의 물리 종료·안전한 폐기, 분산 Worker 결과의 자동 회수·합류를 증명하지 않는다.

## 실제 경쟁 시나리오

추가된 `tests/kernel-parallel-positive-two-hosts.test.ts`는 테스트 소유 임시 Git 저장소·SQLite Runtime·물리 Worktree를 만든다. 두 독립 Host 프로세스가 동일한 두 Step 목록을 받은 다음 진입 barrier를 연다. 기존 Control Plane의 Step·Attempt·Owner Fence/Mutation 경로를 그대로 사용한다.

1. **one-owner:** Host A가 두 Step을 모두 선점하고 Host B는 이미 선점된 Step을 다시 시작하지 않는다. 두 Worker가 정상 결과를 반환하면 실제 `test:ok` 통합 검증, Owner CAS `0→1`, 두 Report/Proof의 `passed` 정착 및 정확한 통합 변경 경로를 확인한다. Owner 변경은 1회만 수행된다.
2. **split-owners:** Host A는 alpha, Host B는 beta Step을 선점한다. 각각 정상 Worker 결과를 만들지만, 통합 검증 명령이 두 결과 파일 모두를 요구하므로 서로의 부분 통합을 거부하고 Owner Rev 0을 유지한다.
3. **split-weak-proof:** 같은 분할 선점에서 검증 스크립트가 항상 exit 0을 반환한다. Host A의 결과 처리를 먼저 완료하고 Host B를 늦게 풀어 교차 Git Worktree 작업이 우연히 실패하는 상황과 구별했다. **수정 전** Owner CAS가 불완전한 한 Step 결과를 반영해 Revision 1을 기록하는 실패를 재현했다. 이 실패를 테스트의 요구조건인 Rev 0과 대조했다.

## 최소 제품 수정

`src/host/kernel/parallel-dispatcher.ts`의 기존 `dispatchFailures`에서 **정확히** `STEP_ATTEMPT_ALREADY_CLAIMED`를 감지한 경우, 이후 `integrateParallelResults()`를 호출하지 않도록 한다. 기존 `parallel_step_claim_conflict` 실패 상태를 반환하고 Worktree와 Canonical 결과 기록을 보존한다.

이 조건은 동일한 배치를 **다른 Host가 실제 선점 중임을 나타내는 기존 타입드 오류**에만 적용된다. 일반 Worker 실패가 발생했으나 선점 충돌은 없는 경우, 기존 프로젝트의 `partial-failure`와 부분 Delivery 정책을 변경하지 않았다. 작업 성공/실패에 따라 새 원장, 배치 스케줄러, in-memory 소유권 Map, Provider별 폴백을 도입하지 않았다.

## 검증 기록

| 검증 | 결과 |
| --- | --- |
| 기존 약한 Proof 교차 Host 분할 진입 | **RED**, 실제 Owner Rev `1` (기대 `0`) |
| 수정 후 강한 Proof 분할 진입 | PASS, Rev `0` |
| 수정 후 약한 Proof 분할 진입 | PASS, Rev `0` / 2 Host `parallel_step_claim_conflict` / Worktree retain |
| 전체 배치 정상 Worker 2개 | PASS, Owner Rev `0→1` 한 번 / Report·Proof 2건 passed |
| Linux TypeScript, 제품·테스트 빌드 | PASS |
| Linux 확대 회귀 | **56 PASS / 3 OS SKIP / 0 FAIL** |
| Module boundaries | PASS, 9 modules / 311 files / 849 edges |
| Mac Native 최종 전체 3개 시나리오 | 3 PASS / 0 FAIL, 선점 충돌 시 Rev 0·전체 소유 시 Rev 1 |
| Mac Native 초기 실행 | 2 PASS / 1 FAIL; 실패한 alpha `worker-report-missing`, 원래 RPC/실행 예외 상세 미확보 |
| Mac Native 단일 소유 추가 재검증 | 진단 1 PASS + 별도 3회 반복 PASS |
| Mac 테스트 원본 저장소 | 원본 checkout clean, 별도 임시 소스/격리된 빈 CODEX_HOME 사용 |

관측: Linux 소스 경로 반례 RED operation `ee5856e3-6c89-4101-8a95-bbc9a0e5174f`, 수정 후 GREEN operation `c8d7d12b-a792-43db-af89-8e65ebf91cd2`, 확대 회귀 operation `91cdb1cc-45bf-4b2e-a177-8c9a2d172522`. Linux 최초 정상 경쟁 증거 `b50d5e25-d59d-48bd-9c6e-cd1d23bd5784`.

Mac 증거: 최종 제품·테스트 빌드 operation `65089f70-4982-4aad-a107-6e1ec6a38c31`, 첫 2 PASS/1 FAIL 원본 operation `9ea0870c-a6c8-4fbd-a6b6-f5841e43b125`, 실패 당시 두 App Server PID 종료·각 Native 예약과 1건 성공 기록 확인 `1c7f26c1-6432-49b3-b1bd-ddb93f77a0e6`, 진단 단일 소유 PASS `0c5d55a5-7aec-4e30-8e23-7c88ee8a2514`, 동일 단일 소유 3회 연속 PASS `04a4ea2a-76a5-4f41-900e-94724086cfb3`, 전체 3 PASS `d22fe386-cf3b-496c-a7ac-1b4ee202e35a`, 결과 로그 재대조 `8c08255c-479d-446f-b52d-e9b7ad29188a`. 최초 실패 당시 테스트 전용 Worktree는 두 Native App Server PID 소멸을 확인한 뒤 안전하게 폐기했다 (Mac operation `5353a293-8b90-40ab-8f56-646e460ea8cb`). 빈 격리 CODEX_HOME·임시 복제본도 함께 정리했고 운영 Codex 세션과 Mac 원본 checkout은 그대로 유지했다.

제품 수정 커밋: `16ee06ce0c7cb369d5db551bc6e57145bd0348a2`. 독립 정상 경쟁 회귀의 최초 커밋: `156d24d5f0a38a52048c580e2ef3be29df5e69d3`.

## 재시작 후 Canonical 결과 재조회 검증 (T24 후속)

두 Host가 서로 다른 Step의 Worker를 정상 완료한 경우, **두 Dispatcher가 모두 Owner Delivery를 중단한 뒤 새로운 Control Plane으로 같은 Run을 재조회**하는 Linux 회귀를 기존 `tests/kernel-parallel-positive-two-hosts.test.ts`에 추가했다. 이 테스트는 저장소 및 Runtime을 격리하고 별도 결과 원장이나 임의 복구 마커를 만들지 않는다.

- `run_steps`의 `resultAttemptId`, `resultCommitSha`, `executionWorkspaceId`가 최신 Canonical Attempt와 정확히 일치한다. 각 Step의 Attempt는 재시작 후에도 **1건**뿐이다.
- Attempt에는 `workerReport`와 검증 항목, `resultWorkspaceIdentity`, `patchDigest`, `changedPaths`가 남아 있다. 실제 Step Worktree의 `HEAD`는 기록된 `resultCommitSha`이고, `git show --binary`의 SHA-256은 `patchDigest`와 같다. `git diff-tree`의 변경 경로와 작업 공간 식별자도 기록과 일치한다.
- 새 Control Plane의 `getExecutableSteps()`는 두 `running` Step을 새 실행 대상으로 돌려주지 않는다. 재조회만으로 새로운 Writer나 Attempt가 생기지 않는다.
- 이 과정에서 Owner Revision `0`과 원본 Owner 파일의 무변경 상태를 유지한다. **새 Proof 실행, 최종 Owner CAS, Report settlement는 수행하지 않았다.** 이는 결과 재조회 가능성에 대한 증거이며 완료 판정이 아니다.

### 기존 구조로 후속 정착을 구현하기 위한 조건

1. **권위 있는 후보 조회:** 현재 plan revision과 mutation revision이 같은 Step별 최신 Canonical Attempt에서만 commit SHA·patch digest·report를 구성한다. `failed`/불완전한 Attempt, plan 변경, 누락·중복 Step, Worktree HEAD/identity/patch의 불일치는 거부한다. Host 메모리의 성공 응답은 권위로 사용하지 않는다.
2. **물리 Writer 종료 확인:** 단지 Host 프로세스가 종료됐거나 SQLite에 결과가 남았다고 해서 이탈한 OS Writer 및 후손이 종료됐다고 판단하지 않는다. 이미 존재하는 Native Host 실행/예약 증거로 해당 Attempt에 대한 종료를 확인하기 전에는 결과 Worktree를 변형하거나 삭제하지 않는다.
3. **단일 통합 진입:** 결과가 모두 유효하고 물리 Writer가 정착된 경우에만 기존 Owner fence 아래에서 한 조정자만 통합 Worktree를 사용할 수 있어야 한다. fence TTL 만료·두 Host 동시 복구·검증 도중 작업 공간 변경을 반례로 검증한다. 이를 충족하지 못하면 별도 Coordinator, Queue, 타임아웃 폴백을 만들어 우회하지 않는다.
4. **기존 통합/정착 재사용:** 검증된 `resultCommitSha`들을 Step 순서로 합쳐 기존 `integrateParallelResults()`의 변경 경로·통합 Proof 검사를 사용한다. `recordOwnerWorkspaceMutation`의 CAS가 한 번만 성공해야 하며, 이후 각각의 저장된 Worker Report를 기존 `settleParallelResult()`로 정착한다. 미완료/충돌 때 Writer를 재실행하지 않고 Worktree를 보존한다.
5. **실패 창 검증:** Owner apply 전·후, CAS 후 Report 이전, 두 Host가 복구에 동시 진입하는 경우를 격리된 실제 Run으로 재현한 뒤에만 자동 정착을 허용한다. 현재의 `recoverPendingDeliveryMaterialization()` 차단 동작을 약화시키지 않는다.

**추가 Linux 검증:** TypeScript 타입 검사·제품·테스트 빌드 PASS. 분할 Host 재시작 재조회 3/3 PASS (operation `4c368c1b-8e3f-4a30-95f1-5e6f38659825`, `ec94f639-4cb4-4d05-b6c8-35f8716b487d`). 확대 회귀 56 PASS / 3 OS SKIP / 0 FAIL, 경계 검사 9 modules / 311 files / 849 edges PASS (operation `352c6b7e-f1fb-40b3-a7ba-b84679bfc8b0`). Mac 실제 Native Codex App Server `command/exec` 동일 소스(`3e0e23913f2aad3425545e3cddbc391e87def2d0`) 빌드 PASS (operation `8fdbed5d-66be-4ee5-880c-26ad240d5ec4`), 전체 경쟁/분할/약한 Proof와 재시작 Canonical 무결성 검증 **3 PASS / 0 FAIL / 0 SKIP** (operation `b69ecdb5-f55f-4a9f-9168-ef65ef7f0051`, 로그 재확인 `e3c01bb2-0bd9-4bb8-b9ee-a18fa1c0ea62`). 테스트 전용 Git 복제본과 빈 `CODEX_HOME`은 안전 조건 확인 후 정리했고 원본 Mac checkout은 clean을 유지했다 (operation `e19d5e2c-699e-4e7c-9eae-923ac87eb4e3`).

**현 단계 결론:** Canonical 결과 재조회와 Git 무결성 검증은 PASS다. 물리 Writer 종료 증명과 fence 하에서의 통합·CAS 중복 실행 차단은 아직 PASS가 아니므로 **자동 결과 합류/Owner Delivery는 활성화하지 않았다.** G0 `PARTIAL`, W1 `DEFER` 유지.

## 남은 항목

1. 서로 다른 Host에서 성공한 Canonical Worker 결과들을 안전하게 재조회·합류시켜 최종 통합 Proof와 Delivery를 완료하는 **회수 경로**는 아직 존재한다고 증명하지 못했다. 현재는 충돌 시 fail-closed 후 Worktree를 보존한다.
2. 정상 결과의 물리 OS Writer 안전 종료는 테스트에서 실행한 단발성 명령까지만 확인한다. 기존에 이탈한 Writer/OS 후손의 수명과 재접속은 별개다.
3. Codex App Goals 자동 호출, Windows Native와 Linux sandbox 보안, 전체 Writable 진입점 필수 예약은 미검증이다.
4. 초기 Mac Native 성공 기록 부족/`worker-report-missing` 1건은 원래 Native 예외 원인을 확보하지 못했다. 재발하면 시험의 `workerErrors`를 확인하고 실제 App Server RPC/OS 종료를 근거로 분리한다. 오류를 숨기는 Provider 재시도·폴백을 추가하지 않는다.
5. G0 `PARTIAL`, W1 `DEFER`를 유지하며 기본 Native Dispatcher 전환을 승인하지 않는다.
