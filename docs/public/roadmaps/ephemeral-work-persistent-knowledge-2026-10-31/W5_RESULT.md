# W5 — Step 정착·Run Journal 누적 제거와 FK 소비자 검토

- 기준: `main / 35765cda58e27f9e5b05896ade5fa0b431b79156`
- 작업 경계: 단일 Step 파일럿의 원인 두 가지(승인된 Run에 남은 `ready` Step, 정리 후에도 영구 누적되는 `run_journal`)를 코드에서 해결하고 격리 검증한다.
- 판정: 측정 후 확정. 이 Wave도 운영 DB 삭제·계정 배포·기존 사용자 Codex 세션 종료는 수행하지 않는다.

## 1. FK 및 실소비자 조사

W0 조사에서 `runs`를 참조하는 외래 키 28개가 확인됐다. 해당 Run별 임시 실행/증거/검토/호스트 테이블은 W4의 `purgeRunChildRows()`가 FK 의존 순서로 정리한다. 영구 `knowledge_records`, `knowledge_revisions`, Run FK가 없는 `knowledge_transactions`은 FK 기반 정리 대상에서 제외한다. Project Identity도 별도 보존한다.

`run_journal`은 Run FK가 없는 append-only 이벤트 이력이다. 주요 조회는 Kernel의 `listRunJournal()`과 `host-tooling/kernel-eval/historical-replans.ts`의 과거 Replan 분석이다. 핵심 Knowledge 조회·Revision CAS·완료 Commit 재조회는 이 저널을 사용하지 않는다. 따라서 **활성 작업의 이벤트는 보존하되, 정착한 작업의 저널만 원자적 정리**할 수 있다. 대신 정리한 Run의 히스토리 분석은 Kernel DB에서 더 이상 할 수 없으므로, 필요한 경우 정리 전 별도의 외부 Agent 기록을 이용해야 한다. 해당 분석의 기능 저하는 자동 정리 활성화의 별도 수용 조건으로 남긴다.

`run_journal_no_update`는 계속 무조건 수정 금지다. `run_journal_no_delete`는 활성 및 일반 완료 Run에 대해 기존 append-only 금지를 유지한다. 단, 이미 검증된 원자적 정리 함수가 같은 트랜잭션 안에서 `runs.finalization_status='retiring'`으로 임시 변경한 Run의 기록만 삭제할 수 있도록 조건을 좁혔다. 이 중간 상태는 커밋되지 않는다. 기존 DB의 구형 트리거는 실제 SQL 정의를 확인해 필요한 경우에만 일회성 업그레이드한다. 새로운 테이블·스토리지·이중 이벤트 경로는 없다.

## 2. Step 정착 불일치 수정

기존 `persistCompletionDecision()`에서 `accepted`를 기록해도 `run_steps`는 `ready`로 남을 수 있었다. Completion은 코드 전달의 신뢰 결정이고, `passed`는 개별 Step을 실제 실행·검증했다는 기록이므로 둘을 혼동하면 안 된다.

수정 후 같은 SQLite 트랜잭션에서 **실행 Attempt가 전혀 없는** `planned/ready` Step만 `cancelled`로 정착하며 `blocked_reason='completion_accepted_without_step_execution'`을 기록한다. 실제 시도가 있는 Step이나 `running/reported/verifying/failed/blocked` 상태는 자동 성공·취소 처리하지 않는다. W4 수동 정리는 정확히 1개 Step이 `passed`이거나, 위 사유로 취소되고 Attempt가 없는 경우에만 허용한다.

이는 완료한 코드에 새 검증을 요구하거나 기존 Completion 결과를 무효화하지 않는다. 오래된 DB의 기존 `ready` Step은 소급 조작하지 않고 정리하지 않는다.

## 3. 정리 경계

`retireSettledSingleStepRun()`은 계속 명시적인 단일-Step 파일럿이다. 기존 W3 Settlement, 프로젝트/Revision CAS, 활성 Owner/Lease/Lock/후속 세션 참조 거부를 유지한다. `purgeSettledRunRows()`는 하나의 `BEGIN IMMEDIATE` 내부에서만 `retiring`을 설정한 뒤 해당 Run의 journal과 FK 자식 및 Run을 삭제한다. 삭제 중 오류가 발생하면 Run·Evidence·journal 삭제를 포함한 트랜잭션 전체가 롤백된다.

완료 후 영구 Knowledge/Project Identity는 보존된다. 다른 활성 Run의 journal/실행 상태는 건드리지 않는다. 정상 `next/report`에는 이 정리 기능을 연결하지 않는다.

## 4. 남은 통합 조건

- 정리 후에도 `knowledge_transactions`에는 영구 지식 출처를 위한 `run_id`가 남을 수 있다. 이는 보존할 최소 검증 출처이며, 실행 이벤트 저널과 다르다.
- 이미 정리된 Run ID로 다시 시작하려는 요청의 idempotence, 다른 Host 세션 인계, 미종료 Worker, 과거 분석 보존 요구를 전체 환경에서 확인해야 한다.
- 모든 Step이 적절한 종료 상태인지, 수동 파일럿 이상의 자동 정리 범위를 늘릴 수 있는지 판단하기 전 실제 운영 DB 정리는 허용하지 않는다.
- SQLite 일반 Open의 반복 Migration/DDL 분리와 다중 OS 파일 소유 문제는 W6에 남아 있다.
- Windows Native·Mac Native/MCP 및 실제 계정 재시작/복구 수용 이전에는 전체 Ephemeral Work 전략은 `PARTIAL`이다.

## 5. 검증 결과

- TypeScript Runtime 빌드 및 build:check: PASS (308 files, 842 dependency edges, 최종 생성물 불일치 0).
- 테스트 생성 및 build:tests:check: PASS (289 tests, 8 helpers, 최종 생성물 불일치 0).
- check:boundaries: PASS (9 modules, 308 files, 842 dependency edges).
- Linux W5 트리거 업그레이드·Step 정착·Run 삭제 원자성·초기화 롤백 집중: 6/6 PASS.
- Linux Knowledge Revision/Transaction Recovery/Finalization optional·required Knowledge/Git 재시도 회귀: 17/17 PASS.
- Windows Native Finalization·Knowledge·W5 두 반례: 17/17 PASS.
- 최초 긴 빌드 중 새 테스트 소스를 추가하여 build:tests:check가 stale test build로 종료한 결과는 반영 전 상태였다. 이후 테스트 빌드를 다시 실행하여 build:tests:check PASS로 확인했다.
- Linux 전체 실사용 회귀(Wave 18 Journal append-only/atomic 포함): 6/6 PASS.
- 트리거 SQL 단일화 최종 리팩터링 후 Linux Runtime build/build:check/Boundary PASS, Finalization·Step·구형 Journal 업그레이드 집중 3/3 PASS. 새 DB/구형 DB 경로가 동일한 SQL 상수를 재사용한다.

**판정:** 이번 W5 Step 정착과 원자적 저널 정리 범위는 측정된 집중 회귀 기준 PASS. 자동 정리 활성화, 전체 FK/Host 소비자의 전방 호환, 과거 이력 사용성, Run ID 재사용 정책, 실제 운영 데이터 정리 및 모든 Host E2E는 아직 PARTIAL이다.


## W5 후속: 정리된 Run ID 재사용과 멱등적 수동 Retire (2026-11-01)

기존 수동 Retire는 활성 runs/영수증/저널을 삭제했다. 이후 동일 Run ID를 재사용하면 영구 Knowledge 출처를 가장할 위험이 있고, 정리 재시도는 not found로 실패했다.

최소 변경:
- 기존 SQLite meta(key,value)에 retired-run ID 식별자와 projectId/mutationRevision을 기록한다. 새 테이블·DB·이벤트 이력은 추가하지 않는다. 이는 상세 Run 이력이 아니라 최소 재사용 방지 식별 정보다.
- 기존 W4/W5 정리의 BEGIN IMMEDIATE 트랜잭션 안에서 마커와 저널·FK 자식·Run 삭제를 함께 처리한다. 하나라도 실패하면 모두 롤백한다.
- insertRun은 기존 meta 기본 키에서 정리된 Run ID가 존재하는지만 확인하고 해당 ID의 재생성을 거부한다. 인덱스가 없는 영구 Knowledge Ledger 전체 검색은 추가하지 않는다.
- 동일 프로젝트·Mutation Revision의 Retire 재시도는 기존 마커를 확인해 retired를 재조회한다. 다른 프로젝트/Revision은 거부한다.

**트레이드오프:** Retire된 Run당 최소 식별 마커 한 행이 영속한다. 이는 실행 이벤트 이력과 구분해야 한다. 구형 수동 Retire에 마커가 없는 경우 해당 Run ID의 소급 재사용 차단까지 보장할 수 없다. historical-replans 소비자는 삭제된 저널을 조회할 수 없으므로 자동 Cleanup은 계속 비활성이다.

**검증:** 삭제 실패 시 마커·저널·Run 동시 롤백, 정리 재실행의 멱등성, 프로젝트/Revision 경계, Run ID 재생성 거부, 프로세스 재Open 후 식별 유지.
