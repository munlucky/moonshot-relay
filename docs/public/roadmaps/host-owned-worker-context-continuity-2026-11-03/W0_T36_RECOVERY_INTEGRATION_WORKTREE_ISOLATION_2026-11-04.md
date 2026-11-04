# W0 T36 — 복구 시도별 물리 통합 Worktree 분리와 만료된 Proof 후손 반례

- 날짜: 2026-11-04
- 기준선: `main / 5559424577592d01486e924b2a60e63fc4bf0864`
- 대상: 기존 `src/host/kernel/workspace/physical-worktree.ts` 재사용, 테스트 `tests/kernel-recovery-integration-worktree.test.ts`
- 판정: **각 복구 Host가 이전 Proof의 물리 Worktree를 재사용하지 않는 기반 도입**. 자동 Canonical Report·Owner Delivery는 미활성화이며 G0 `PARTIAL`, W1 `DEFER` 유지.

## 구현 경계

`prepareRecoveryIntegrationWorktree()`는 현재 프로젝트·Run·Runtime에 대해 **새로운 물리 Git Worktree**를 한 번만 생성한다. 경로에는 표준 `runtimeHome`과 기존 SHA-256 기반 프로젝트/Run 네임스페이스를 사용하고, 생성마다 OS의 `randomUUID()`로 독립 경로를 만든다. UUID는 Kernel Fence Token이나 Writer 종료 증거가 아니다.

- **기존 `prepareIntegrationWorktree()`와 `prepareExecutionWorkspaces()`의 기본 경로는 변경하지 않는다.** T35의 `executeTrustedProof({writeScope})` 역시 명시적으로 전달되지 않으면 이전 동작 그대로다.
- Owner repository의 실제 경로(`realpath`) 내부에 새 Worktree를 만들지 않는다. OS 경로 별칭을 보존하려고 `path.resolve`만 사용하지 않는다.
- 새 복구 Worktree는 일반 실행의 `executionRoot()` 바깥에 두어 `cleanupExecutionWorkspaces(retain:false)`의 Run 단위 정리가 이전 Proof 후손을 모르는 상태에서 이 Worktree를 삭제하지 않도록 한다. 임의 TTL 만료나 Clean 여부만으로 Worktree를 재사용/삭제하지 않는다.
- 이전 복구 Host가 같은 Run에서 성공 혹은 실패했는지와 무관하게 새로운 Proof 시도는 이전 물리 디렉터리를 재사용하지 않는다. 별도 DB/Queue/스케줄러/수동 폴백을 추가하지 않는다.

## 수용 시험

1. 실제 Kernel SQLite Run과 기존 Owner Fence를 두 Control Plane으로 열어 A가 Fence를 먼저 획득하면 B를 거부하는지 확인한다. A의 Worktree를 만든 뒤 A의 Fence를 해제하고 B가 새 Epoch로 확보했을 때 B의 Worktree가 **A와 다른 실제 Git 경로**인지 확인한다.
2. 두 Worktree가 동일한 Owner `HEAD`를 기준으로 생성됐고, 둘 다 `reused=false`인지 확인한다. 이전 Worktree에 남긴 시험 파일은 일반 배치 정리가 실행돼도 유지돼야 한다. Owner Revision은 `0`이며 Provider/Worker가 다시 시작되지 않는다.
3. **macOS OS 강제 시험:** T35의 선택형 Seatbelt `writeScope=A`로 Trusted Proof를 시작한다. Proof Launcher가 Timeout되고 A의 분리된 유한 Writer가 살아 있는 동안 최초 Owner Fence를 만료시킨 뒤 B가 새 Fence를 얻는다. B의 새로운 통합 Worktree를 만든 뒤 A Writer가 `A`에는 파일을 쓰되 `B`와 Owner 파일에는 쓰지 못하는지 (`EPERM`) 검증한다. 이전 Token은 갱신이 거부되고 Owner Revision은 `0`이다.
4. 시험 Writer의 PID와 한정 수명에 의한 자체 종료를 확인한 경우에만 해당 시험 A/B Worktree를 `git worktree remove --force`로 정리한다. 실제 운영 환경에서 Writer/Proof 후손의 종료를 모르면 새 경로는 **보존**한다.

## 범위 밖

- macOS 보호 경계는 OS 강제 정책이 실제 활성화된 **해당 Proof 호출과 해당 Worktree**에 대해서만 유효하다. Linux/Windows에서 새 경로를 만들었다는 이유만으로 쓸 수 없는 OS 후손이 생긴 것은 아니다. OS 강제 수단이 없다면 T35는 typed 오류로 실행을 거부한다.
- 기존 Host Native Writer의 `writerExitVerified:false` 및 영구 외부 예약을 해제하지 않는다. 기존 두 Host의 Canonical 결과를 Recovery Worktree에서 자동 Proof/Owner CAS에 정착하는 것은 이 단계에 포함하지 않는다.
- 아무 Fence 없이 함수를 호출하는 것으로 물리 Worktree 생성을 승인할 수는 있으나, **동시 복구 조정자 판정은 여전히 기존 Owner Fence를 호출자가 획득하고 검증해야 한다.** 이후 전 구간 Fence 사용을 통합하는 작업이 필요하다.

## 검증 기록

| 검증 | 결과 |
| --- | --- |
| Linux 타입·제품·테스트 빌드 | **PASS**. 초기에 테스트의 `Run.projectId` nullable 계약 누락을 strict TypeScript가 검출해 값 검증을 추가했다. |
| Linux 독립 Worktree 2개와 기존 Run cleanup 비간섭 | **집중 4 PASS / 2 OS SKIP / 0 FAIL** (`operationId=d3220b3f-a872-4102-8ce6-5c0bc91b4e16`) |
| Mac 실제 OS 늦은 Writer가 새 통합 Worktree/Owner 쓰기 차단 | 동일 커밋의 Mac 네이티브 후속 실증 대기 |
| Linux 확대 회귀 및 모듈 경계 검사 | **60 PASS / 3 OS SKIP / 0 FAIL**, 9 modules / 312 files / 850 edges PASS (`operationId=90d17218-23f7-44a8-b8e3-cac2eb984cff`) |
| 두 Host 독립 프로세스·만료·Owner CAS·Report 정착 통합 | 아직 미검증/자동 활성화 금지 |

## 다음 단계

이미 검증된 macOS `writeScope`와 복구 시도별 새로운 물리 Worktree를 하나의 **기존 Owner Fence 기간**에 묶어야 한다. 첫 `cherry-pick` 이전의 Fence와 Proof, Owner CAS, `settleParallelResult`까지 검증한다. Fence 만료·Host Crash·CAS 후 Report 중단을 각각 반례로 통과하지 못하면 자동 Canonical 결과 회수/Owner Delivery를 활성화하지 않는다. 임의 Native Writer 후손의 종료·예약 해제까지 추론해서는 안 된다.

전체 **G0 PARTIAL / W1 DEFER**.
