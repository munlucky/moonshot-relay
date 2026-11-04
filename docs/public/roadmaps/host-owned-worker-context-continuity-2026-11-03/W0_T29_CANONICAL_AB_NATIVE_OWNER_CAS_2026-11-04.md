# W0 T29 — 실제 Canonical Attempt A/B 동시 Native 격리와 Owner CAS 단일 Delivery 검증

- 검증일: **2026-11-04**
- Linux 작업 기준: `main / c8260d010a9386ff30fc7797a4b763d5336912c1`
- 실제 Mac Native Host: Darwin, Node `v24.6.0`, Codex CLI `0.162.1`, 격리된 W0 `CODEX_HOME`.
- 판정: **Mac 실제 Kernel Run + 두 Canonical Attempt + 두 물리 Git Worktree + 실제 Native `command/exec` + 기존 Owner Mutation Fence/CAS 통합 1/1 PASS.** A Writer의 OS 프로세스가 계속 기록하는 동안 B 작업과 Owner 단일 반영이 진행되고, A/B의 외부 쓰기 시도는 모두 거부됐다. **Worker Report·Proof 검증, 임의 OS 후손 전체 종료와 안전 폐기, 기본 Dispatcher 자동 적용은 여전히 미완료. G0 PARTIAL / W1 DEFER.**

## 목적과 실제 실행 경계

앞선 [T28](W0_T28_NATIVE_DETACHED_WRITE_CONFINEMENT_2026-11-04.md)은 임시 A/B/Host 센티널의 macOS Sandbox 쓰기 격리만 검증했다. 이번 T29는 실제 제품 Runtime의 **`createKernelControlPlane`, `beginAttempt`, `failStepAttempt`, `prepareHostWriterAttemptWorktree`, `registerExecutionWorkspace`, `updateStepAttempt`, `reserveHostWorkspaceWriter` 및 `recordOwnerWorkspaceMutation`**을 함께 사용했다.

실제 Mac Native Codex App Server에는 모델이 생성한 코드를 실행하지 않고, 검증 도구가 직접 지정한 `command/exec` 명령만 제출했다. 두 명령 모두 명시적 `workspaceWrite` 및 각 Attempt의 유일한 `writableRoots`가 적용됐다. **이번 단계는 Native 명령 실행·물리 격리·Owner CAS 검증이지 모델 기반 Worker Report 수용 검증은 아니다.**

검증 순서:

1. 매 테스트에서 임시 Git Owner를 만들고 `shared.txt=base`를 커밋한다. 격리 Kernel Runtime에서 Run과 Canonical Attempt A를 생성한다.
2. A만의 Git Worktree를 준비하고 실제 Workspace ID·기준 Identity를 기존 Kernel Attempt에 기록한다. A 전용 Host 외부 Writer 예약을 독점 생성한다.
3. 실제 Native App Server `command/exec`가 별도 Process Group의 **유한 수명(300회·40ms 간격)** Node Writer A를 생성한다. App Server를 종료한 뒤에도 실제 A 기록이 증가하는지 확인한다.
4. **A Writer가 살아 있는 상태**에서 Kernel은 기존 Attempt A를 `failed`로 처리한다. 이는 OS Writer 종료 영수증이 아니다. 같은 Run·Step에서 Canonical Attempt B를 발급받아 **서로 다른** 물리 Git Worktree·Workspace ID 및 Host 예약을 생성한다.
5. A Writer가 A에 로그를 쓰는 동안 B의 tracked `shared.txt`, Owner tracked `shared.txt`, Host 전용 예약 시험 파일 수정을 반복 시도하도록 한다. A의 각 외부 쓰기는 실제 macOS Native Sandbox로 거부돼야 한다.
6. 별도 실제 Codex App Server에서 B `command/exec`를 실행한다. B는 자체 `shared.txt`를 `B:only`로 변경하고, A·Host 외부 경로 수정은 각각 거부돼야 한다.
7. **기존 Kernel Owner CAS만 사용**하여 B의 Git patch를 검사하고 Owner에 적용한다. 기존 `acquireOwnerWorkspaceMutationFence` → `assertOwnerWorkspaceMutationReady` → Host `git apply` → `recordOwnerWorkspaceMutation` 순서로 Revision을 한 번 증가시킨다.
8. 동일한 옛 Revision의 두 번째 Delivery 기록은 `delivery_mutation_revision_stale`로 거부한다. A Writer가 여전히 자신의 Worktree에 기록하는 중에도 Owner 내용은 `B:only`를 유지한다.
9. 테스트용 A Writer는 자체 유한 수명 뒤 실제 PID 부재와 300줄 기록 정착을 확인한다. **이 테스트에서 생성한 임시 Git Worktree/Runtime만 정리**한다. 운영 Native Attempt Worktree/Host 예약에는 자동 폐기나 TTL을 적용하지 않는다.

## Mac 실측 결과

실제 Mac Node 테스트 `W0_NATIVE_CANONICAL_AB_CONFORMANCE=1`, `CODEX_HOME`, `W0_CODEX_EXECUTABLE=/opt/homebrew/bin/codex` 사용.

| 조건 | 결과 |
| --- | --- |
| 실제 Canonical Kernel A/B Attempt ID가 각각 발급됨 | PASS |
| A/B의 물리 Git Worktree·Workspace ID가 서로 다름 | PASS |
| 실제 Native A 명령 `command/exec` | exit 0 |
| 실제 Native B 명령 `command/exec` | exit 0 |
| 실제 A Writer가 B 시작·Owner Delivery 중 살아 있음 | PASS, PID `4231` |
| A의 B/Owner/Host 쓰기 시도 | **각 25회 거부**, 성공 0회 |
| B의 A/Host 쓰기 시도 | **각 1회 거부**, 성공 0회 |
| B의 실제 Git 변경 | `shared.txt=B:only` |
| Owner의 최초 `shared.txt` | `base` |
| 기존 Owner CAS를 통한 단일 B patch 반영 | PASS, `shared.txt=B:only` |
| 기존 Mutation Revision | `0 → 1` |
| 동일 이전 Revision으로 다시 적용하려는 요청 | `delivery_mutation_revision_stale` 거부 PASS |
| 이후에도 A Writer가 A만 기록, Owner·B·Host 결과 불변 | PASS |
| Kernel Attempt A 상태 | `failed` (OS Writer는 당시 생존) |
| Kernel Attempt B 상태 | `started` (Native 명령 완료를 Report 승인으로 승격하지 않음) |
| Worker Report/Proof 자동 승인 여부 | **실행하지 않음** |
| 테스트용 유한 Writer 종료 및 임시 파일 정리 | PID 부재·300줄 정착 확인 후 수행 |
| 전체 Native 통합 검사 | **1/1 PASS**, exit 0 |

Mac MCP 영수증 `operationId=9c4978b2-1715-4827-b66d-576e4e3ffb5a`, 실행 `~14.7초`, exit 0. 구조화된 로그에 Attempt ID, Workspace ID, OS PID, 차단 건수, Mutation Revision·Stale Delivery 거부를 기록했다.

첫 Mac 실험 `operationId=3757fb7d-44d9-41e1-adde-8ba5af5f4b72`는 A Writer의 PID가 나타난 직후 heartbeat 첫 기록이 생기기 전에 테스트가 파일을 읽어 `ENOENT`가 났다. **샌드박스·Owner CAS 실패가 아니라 테스트 동기화 경쟁**이었다. Linux MCP 테스트에서 `ENOENT`를 처리하고 최초 기록 증가를 관측하도록 수정했다. 첫 실험에서 생성된 test-owned PID `1146`은 유한 루프 300회로 자체 종료하고 300줄이 안정화됐으며, 지정한 임시 Git Worktree와 Root만 Mac Native Node에서 제거했다(`operationId=32cb3ba1-b420-4141-86c5-0d941d28d9b5`, exit 0).

실제 Mac에서 사용한 임시 Checkout은 이전 검증과 동일한 `b6054a146e7d37b5d5a22b5f97f9ae3de46c51f5` 기반이다. **그 버전에서 이번 `c8260d01`까지 `src/host/kernel`·`src/kernel` 제품 소스의 Git diff가 0개**임을 Linux main에서 확인했다. 이번 검증 소스와 컴파일된 테스트만 별도로 Mac Native 실행기의 임시 Clone에 배치했다. 사용자 Mac 원본 Checkout `3797c60f`는 변경하지 않았다.

## Linux MCP 빌드와 회귀

새 `tests/kernel-native-canonical-attempt-delivery.test.ts`는 **명시적 macOS conformance 플래그가 없는 환경에서는 SKIP**이다. 실제 모델을 호출하지 않는다.

- 필요한 조건: macOS, `W0_NATIVE_CANONICAL_AB_CONFORMANCE=1` 및 격리된 `CODEX_HOME`. 선택적 `W0_CODEX_EXECUTABLE`.
- Linux 격리 `npm ci --include=dev`, TypeScript `typecheck`, `build:tests` **PASS**.
- Linux 기존 Owner CAS + macOS 선택 테스트 집중: **11건 중 9 PASS·2 SKIP·0 FAIL**.
- Linux 확대: **98건 중 95 PASS·3 OS 전용 SKIP·0 FAIL**.
- `check:boundaries`: **9 modules / 311 files / 849 dependency edges PASS**.
- 기본 Native/Parallel Dispatcher, Kernel Report/Proof, 프로덕션 예약 해제, DB/Queue/Scheduler/Provider 분기 **변경 없음**. 한 개의 선택적 테스트만 추가했다.

## 검증된 사실과 아직 검증되지 않은 사항

**검증됨:** 실제 Mac Native Sandbox 아래에서 A의 독립 PGID Writer가 살아 있을 때 B의 별도 Canonical Attempt는 자신만의 물리 Git Worktree에 작업할 수 있었다. A의 B/Owner/Host 파일 쓰기는 차단됐고, B의 A/Host 쓰기도 차단됐다. 기존 Kernel Owner Mutation Fence/CAS를 사용해 B의 결과만 한 번 Owner에 적용됐으며, 옛 Mutation Revision의 재적용은 거부됐다.

**아직 미검증:** 이 결과는 별도의 `command/exec` 및 명시적 격리 정책 테스트다. 일반 모델 Tool의 모든 하위 프로세스가 같은 강제 Sandbox 범위로 묶이는지, 임의 후손의 실제 종료·쓰기 정착 및 자동 폐기, Worker Outcome→Kernel Report/Proof 승인, Main/MCP/Host 중단 후 권위 복구, T24 Goals/Dispatcher 중복 실행, Windows/다른 OS·다른 머신의 격리·Owner CAS는 수용되지 않았다.

**운영 조건:** 기존 A Worktree를 물리적으로 폐기하려면 A의 실제 OS Writer·후손 종료 증거가 별도로 필요하다. **A가 불확실하다는 이유로 B의 별도 격리 작업까지 항상 막을 필요는 없지만, B의 신규 Attempt 허가·검증된 Worker 결과 채택은 기존 Kernel/Owner 권위를 통과해야 한다.** Mac 실험만으로 운영 기본 경로에 기능을 강제 적용하지 않는다.

**G0 PARTIAL / W1 DEFER 유지.**
