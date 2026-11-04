# W0 T24 — 동일 Step 교차 Host 중복 실행 재현 및 최소 수정 (2026-11-04)

## 판정

- **Linux 실제 별도 Host 프로세스 / 동일 Runtime SQLite / provider 스텁:** 수정 전 중복 실행 **재현(RED)**, 수정 후 선점 제어 **PASS**.
- **Mac 실제 Native Codex 동일 Run 동시 실행:** 이번 변경에서는 **NOT VERIFIED**. T29~T31 Native 결과를 이번 경합 검증 PASS로 오인하지 않는다.
- **G0 PARTIAL / W1 DEFER 유지.** 기본 병렬 Dispatcher의 Native OS 샌드박스, 연결 상실 후 원래 RPC 핸들 회수, 전체 후손 종료·안전 폐기, Goals 실제 자동 호출 관계는 여전히 미증명이다.

## 재현 가능한 결함

기존 `src/kernel/run/work-cursor.ts::bindStepAttempt()`는 현재 Step을 `running`으로 갱신한 뒤 `store.recordStepAttempt()`를 별도로 호출했다. 서로 독립적인 Control Plane이 같은 SQLite 파일에서 동일 Step을 `ready`로 관측하면 두 Host 모두 새 Attempt를 생성하고 Provider를 시작할 수 있었다. `src/host/kernel/parallel-dispatcher.ts`의 Owner Mutation Fence는 Worker 실행을 완료한 뒤 통합 결과를 Owner에 적용할 때만 획득한다. 따라서 Owner Revision CAS는 pre-spawn 중복 생성 문제를 해결하지 않는다.

독립 프로세스 두 개가 동일 Canonical Run/Step을 바라보고 파일 barrier가 열릴 때 `dispatchKernelStep()`에 진입하는 테스트 `tests/kernel-parallel-double-entry.test.ts`를 추가했다. 격리된 저장소·DB에서 수정 전 두 Host 모두 Provider stub을 시작했고 서로 다른 Canonical Attempt **2건**을 기록했다. 실패 assertion: 예상 launch=1, 실제 launch=2. Owner Revision은 0으로 유지되었다. 이 재현은 실제 모델 호출이 아니라 제품 Dispatcher의 **Provider 직전 경계**에 대한 Linux 시험이다.

## 변경 내용

1. `src/kernel/persistence/work-attempt-store.ts`: **명시적 `claimReadyStep`에 한해서만** `db.transaction()`으로 `run_steps`의 `ready|failed → running` 조건부 UPDATE, Canonical Attempt INSERT, `attempt_count` 증가를 원자적으로 묶었다. 이미 다른 Host가 선점했다면 `STEP_ATTEMPT_ALREADY_CLAIMED`를 던진다. INSERT가 실패하면 UPDATE도 롤백한다. 같은 Step의 패배한 Host는 Attempt·Workspace ID를 쓰지 못한다.
2. `src/kernel/run/work-cursor.ts`: `bindStepAttempt()`에서 기존 비원자적 Step UPDATE를 제거하고 위 State Store 계약을 호출한다. 일반 `beginAttempt`·Review 등에서 쓰는 `routed` Attempt는 명시적 선점이 아니므로 **기존 의미를 유지**한다.
3. `src/host/kernel/parallel-dispatcher.ts`: 선점 경쟁에서 패배한 Dispatcher는 `failStepAttempt()`를 호출하지 않는다. 해당 함수는 가장 최근 활성 Attempt를 실패시킬 수 있으므로 승자의 실행 상태를 건드리지 않도록 한다. 다른 Worker 실패 처리는 변경하지 않는다.
4. `tests/kernel-parallel-double-entry.test.ts`: 독립 Host 2개, 1회 Provider launch/Attempt, 승자의 Workspace ID 보호, 롤백/Step ready 복원, Owner Revision 0을 검증한다.
5. `tests/kernel-parallel-dispatch.test.ts`: 모든 Step 선점을 잃은 Dispatcher가 기존 승자의 Attempt를 실패 처리하지 않고 Owner Mutation도 수행하지 않는 반례를 추가한다.

이 패치는 새 DB 테이블·Worker Queue·Scheduler·시간 기반 자동 해제·Provider별 fallback·모델-visible 명령을 추가하지 않았다. 원자적 Step 선점은 Writer의 물리 종료 증명이 아니며, `failed` 상태에서의 재실행 가능성과 예약된 Worktree 폐기는 기존 물리 격리 게이트를 별도로 요구한다.

## 검증 증거 및 경계

- **수정 전 RED:** 2 Host / 2 Provider stub start / 2 Attempt, 예상 1건 assertion 실패. Moonremote operation `bdca33fb-69f2-4f40-bcaa-a0f6c0351f9f`.
- **초기 수정 GREEN:** 동일 Step 실제 교차 프로세스 1/1, 병렬 관련 집중 27/27 PASS. operation `8710a1eb-90fc-4785-9d91-8c541351008b`.
- **범위 보정:** 최초의 `provenanceKind='routed'` 일괄 제한은 기존 일반 Host·Review 경로를 잘못 제한했다. 확대 회귀에서 실패 4건을 확인하여 **명시적 `claimReadyStep` 경로만** 제한하도록 수정했다. 수정 후 리뷰 포함 14/14 PASS. 실패 증거를 제품 PASS에 포함하지 않는다.
- **최신 집중 회귀:** 수정 후 TypeScript·제품·테스트 빌드 PASS, 교차 프로세스·병렬 Dispatcher·Review claim·Report replay **25 PASS / 0 FAIL**. operation `56ee61cf-b665-4c71-ae1b-9e3cf2522f99`.
- **최종 확대 회귀·모듈 경계:** 동일 격리 Linux 테스트 Runtime에서 12개 관련 suite **75건 중 74 PASS / 1 Mac 전용 SKIP / 0 FAIL**. `check:boundaries` 9 modules / 311 files / 849 edges **PASS**. operation `6a4a0fae-72ec-4837-8cd2-83f1a0b3347a`.
- **문서·diff 무결성:** 로드맵 30개 Markdown·상대 링크 96개(누락 0), `git diff --check` **PASS**. Test-only 임시 Git 사본에서 빌드·실행하며 운영 Kernel 계정 Runtime·Codex 세션은 수정하지 않았다.

## 남은 검증

1. 동일 Run의 `dispatchKernelParallel()` 전체 경로에 독립 Host 둘을 경쟁시켜 실제 Native Provider 호출이 1회인지 확인한다. 지금 증거는 `dispatchKernelStep()` 수준의 교차 프로세스 시험과 병렬 Dispatcher의 실패 분기 fixture다.
2. 실제 Mac Native Codex App Server로 동일 Run/Step 경합에서 실행 시작 수 및 외부 Host Writer 예약을 확인한다. 운영 Codex 세션·기존 오래 살아 있는 W0 Attempt를 손대지 않는다.
3. 실패 이후 `failed` Step의 재선점과 살아 있는 OS Writer를 구별하고, Attempt별 물리 Worktree/예약을 강제해야 하는 제품 진입점을 정한다. SQLite `running` 또는 Lease 만료를 OS 종료 증거로 취급하지 않는다.
4. Goals/App의 자동 호출과 Kernel Dispatcher가 실제 동일 논리 작업을 중복 개시하는지 별도 Native 사용 시나리오로 검증한다.

**안전 정지 기준:** 이번 소스·Linux 경계는 개선됐지만 Native/재연결·임의 Writer 폐기와 기본 Dispatcher 적용까지 완료됐다는 증거는 없다. 따라서 **G0 PARTIAL / W1 DEFER** 유지.
