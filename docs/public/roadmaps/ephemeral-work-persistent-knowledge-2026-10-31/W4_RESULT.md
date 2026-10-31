# W4 — 단일 Step Ephemeral Work 격리 구현 및 검증

- 기준: `main / 49120e565bcc43d096e452edf2543cec5fdb2fc7`
- 범위: 작업 정착 이후 한 개의 Step만 있는 완료 Run의 관련 SQLite 작업 행을 격리 Runtime에서 트랜잭션으로 정리하는 **수동 파일럿**.
- 판정: **PARTIAL**. 일반 `next/report`에 자동 연결하지 않았고, append-only `run_journal`과 영구 Run ID 중복 처리/외부 소비자 문제를 포함한 W4 전체 수용은 아직 미완료.
- 영향: 기존 사용자 운영 DB, 활성 Codex 세션, Mac 계정 설치본, 일반 Runtime 데이터 삭제 **없음**.

## 구조 조사

W0 기준서에서 `runs`와의 FK 연결 28개가 확인됐다. `run_journal`은 `BEFORE DELETE` 트리거가 `run_journal_append_only`로 삭제를 금지한다. `knowledge_transactions`에는 `run_id`가 있지만 `runs` FK는 없으며, W2에서 **Run 없이도 완료된 Knowledge를 재조회하는 영구 기록**으로 사용한다.

기존 `rollbackRunInitialization`의 동적 청소 방식은 `run_id` 컬럼 존재를 근거로 행을 선택했다. 이를 완료 Run의 청소에 재사용하면 영구 Knowledge 트랜잭션까지 지울 수 있는 구조적 위험이 있다.

또한 실제 Finalization 테스트에서 `Run.status=completed`, `finalizationStatus=completed`이면서 `run_steps.state=ready`가 유지되는 사례가 재현됐다. 따라서 **Run 완료 판정만으로 Step 데이터를 버리면 안 된다.**

## 구현

1. `src/kernel/persistence/work-lifecycle-store.ts`의 기존 FK-aware 자식 테이블 삭제 코드를 `purgeRunChildRows()`로 공유한다. `runs`를 직접 참조하는 FK 테이블과 `holder_run_id` 소유 잠금 행만 대상이다. 외래 키 없는 `knowledge_transactions`, append-only `run_journal`은 보존한다. 기존 초기화 롤백도 같은 경로를 사용한다.
2. `src/kernel/state-store.ts`에 `retireSettledSingleStepRun(runId, {projectId, expectedMutationRevision})`을 추가했다. **수동/격리 파일럿용 메서드**이며 현재 CLI나 자동 완료 동작에서는 호출하지 않는다.
3. SQLite `BEGIN IMMEDIATE` 트랜잭션 안에서 Project Identity와 Mutation Revision을 확인한다. W3 `assessRunSettlement()`가 Completion, Knowledge, Git의 정착을 확인해야 한다. 또한 Step은 정확히 1개이며 해당 Step은 `passed`여야 한다.
4. 활성 Run Lease, 활성 Session Binding, Worktree/Workspace Mutation Lock 또는 후속 Session의 참조가 있으면 정리하지 않는다.
5. 위 검사가 모두 통과할 때만 FK 자식 행을 제거한 뒤 `runs`의 `completed/finalization_status=completed` 조건으로 마지막 CAS 삭제를 수행한다. 어느 시점에서든 실패하면 SQLite 트랜잭션 전체를 롤백한다.
6. Knowledge Records/Revision/Transaction은 건드리지 않는다. 외래 키 의존 순환이 발견되면 임의 삭제 순서를 선택하지 않고 거부한다. `run_journal`은 현행 append-only 계약대로 유지한다. 새 테이블, 별도 영속 저장소, OS별 폴백, 이중 쓰기, 신규 프롬프트 규칙은 만들지 않는다.

## 격리 검증

`tests/kernel-finalization-lifecycle.test.ts`의 실제 Finalization fixture를 사용한다. 증거에 의해 승인된 코드 완료 상태에서도 Step이 `ready`이면 정리가 거부된다. 격리 fixture에서 해당 Step을 명시적으로 `passed`로 정착시킨 후 프로젝트 불일치·stale revision·활성 Lease를 거부하는지 검사한다.

Run 삭제를 막는 임시 SQLite 트리거로 자식 행 제거 뒤 실패를 주입하고, Run·Completion·Knowledge가 롤백/보존되는지 확인한다. 트리거 제거 후 정착된 Run을 제거하고 `getRun()==null`, Run Steps 0, Knowledge Records/Revision 불변, `run_journal` 불변을 확인한다.

`tests/kernel-finalization-knowledge-nonblocking.test.ts`에서는 optional deferred Knowledge와 required incomplete Knowledge에 대해 정리 거부를 확인한다. `tests/kernel-session-run-lifecycle.test.ts`와 `tests/kernel-lifecycle-doctor.test.ts`에서 기존 초기화 롤백의 FK 정합성을 확인한다.

## 통합 미완료 및 W5 연결

- `run_journal`은 여전히 Run별 이벤트를 영구 축적한다. `runs` 행을 제거한 것과 **영구 실행 이력 누적 0**은 다르다.
- 기본 Finalization 경로에서 accepted Completion과 Step `passed`가 항상 함께 정착되는지 재검증·개선해야 한다. W4 파일럿의 수동 Step 상태 보정은 운영 자동 정착으로 인정하지 않는다.
- 현재 메서드의 자동 호출은 보류한다. Run ID 재사용/이미 정리된 Run 재요청, 후속 세션, 조회/Doctor, 보존할 provenance 및 FK-free consumer를 W5 전수조사·수용 테스트로 확인하기 전 일반 실행 경로에 연결하지 않는다.
- 원래 요청의 Local↔MCP 소유권 인계·Mac 수정본 네이티브 E2E도 별개로 미완료다.
- **W4 통합 판정 PARTIAL**이며 운영 DB cleanup, 기존 Run migration, 자동 영구 삭제는 수행하지 않는다.

## 검증 명령 및 결과

- Runtime `npm run build` **PASS** (308 files, 842 dependency edges), `build:check` **PASS** (변경 0).
- 최종 내부 삭제 함수의 안전한 상태 사전 검사 추가 후 Linux Runtime build/build:check/Boundary **PASS**, 정상 완료 정리 및 중첩 FK 롤백 집중 **2/2 PASS**. 외부 호출에서 완료되지 않은 Run의 자식 행을 먼저 삭제하지 않는다.
- `npm run build:tests` 및 `build:tests:check` **PASS** (289 tests, 8 helpers, 정합성 변경 0).
- `npm run check:boundaries` **PASS** (9 modules, 308 files, 842 edges).
- Linux 격리 파일럿 `Finalization Wave 5` / `S-18` / 정상 단일-Step 정리+SQL fault 주입 / 초기화 롤백 / 중첩 FK 롤백: 첫 소스 수정 후 5/5 PASS. 마지막 정확히 1개 Step 제한 수정 후 결합 실행에서 첫 4개 PASS, 이후 테스트 파일 전환 중 assertion 메시지 없이 exit 1. 마지막 FK 롤백은 같은 최종 소스로 **단독 1/1 PASS**. 결합 실행 종료 원인은 **미확정**이고 전체 결합 PASS로 처리하지 않았다.
- Windows Native 최종 동일 5개 집중 파일럿 회귀 **5/5 PASS**, exit 0.
- Linux Knowledge Revision/Transaction Recovery/Git 재시도 추가 회귀 **8/8 PASS**. 이후 파일럿의 정확히 1개 Step 제한과 FK 순환 거부만 추가했으며 Knowledge Commit 로직은 변경하지 않았다.
- 출처 검증: 격리 fixture에서 SQL 삭제 실패 후 기존 Run/Completion이 롤백됐다. 성공 시 `getRun()`은 null, `getRunSteps()`은 [], 독립 `knowledge_transactions`, `knowledge_records`, `knowledge_revisions`, `run_journal`은 보존됐다.

**결론: W4 수동 단일-Step 파일럿의 측정한 수정·회귀 범위는 PASS, W4 통합은 PARTIAL.** 자동 Cleanup 활성화, 모든 Step Lifecycle의 실제 `passed` 정착, `run_journal`/파생 실행 기록 축소, Session 복구·Mac E2E, FK 소비자 제거 및 일반 workload 측정이 남아 있다.
