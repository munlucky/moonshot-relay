# W3 — Finalization 정착과 Ephemeral Work 정리 경계

- 조사/구현일: 2026-10-31
- 기존 기준선: `main / c841b69a`
- 목적: **코드 전달 완료와 작업 저장 이력 정리 가능성을 구분**하여, 검증·Git·Knowledge가 정착되지 않은 Run이 삭제 가능한 것으로 오판되지 않도록 한다.
- 원칙: SQLite 유지, 새 테이블/이벤트 브로커/Host별 예외 없음. 제품 실행 절차에 새 필수 단계를 넣지 않는다. 운영 DB의 삭제·이관·백업 교체 및 활성 Codex 세션 강제 중지는 하지 않는다.

## 1. 현재 동작에서 확인된 경계

`src/kernel/run/finalization.ts`의 `finalizeRun()`은 기존 순서대로 검증·Completion Decision을 기록하고, 요청된 Git Closeout을 처리한 뒤 Knowledge Review 및 Commit을 실행한다. Completion은 실행된 검증·Reviewer·증거를 통해 평가한다.

`knowledgeRequired=false`이면 Knowledge가 `deferred` 또는 `failed`여도 **코드 전달의 `finalizationStatus=completed`**가 유지될 수 있다. 이는 코드 Delivery가 Knowledge 수집 실패에 종속되지 않도록 한 의도적인 경계다. 하지만 해당 Run은 후속 Knowledge Recovery의 출처가 될 수 있으므로 **삭제해도 된다는 뜻이 아니다**.

기존 상태를 단순히 `Run.status=completed` 또는 `finalizationStatus=completed` 한 조건으로 평가하면, 검증되지 않은 Knowledge 정리, pending Git Closeout 또는 부정확한 Completion Authority를 놓칠 수 있다.

## 2. 구현: 읽기 전용 Run Settlement 평가

- `src/kernel/run/finalization.ts`의 `assessRunSettlement(store, runId)`는 현행 Run, Finalization Receipt, Completion Decision, Knowledge Commit Receipt, Git Closeout Receipt를 **조회만** 한다.
- `src/kernel/persistence/knowledge-lifecycle-store.ts`의 `getSettledKnowledgeTransaction(runId, projectId, targetRevision)`은 W2에서 정착한 Run FK 없는 `knowledge_transactions`의 성공 영수증을 **조회만** 한다.
- 기존 Run이 `completed`이고 Finalization이 `completed`이며 Completion이 accepted·증거 digest가 존재하고 `sourceIdentity/mutationRevision`이 동일해야 한다.
- Knowledge는 `committed` 또는 `no_change` 상태로 확정되어야 한다. 선택적 Knowledge `deferred`도 정리 불가이다. `committed`라면 Run FK 없는 영속 Knowledge 트랜잭션의 프로젝트·출처·완료 증거·Revision이 같은지 확인한다. `no_change`는 새 영구 트랜잭션을 만들지 않는 W2 정책을 유지한다.
- Git Closeout이 요청됐다면 해당 Run의 완료 Receipt와 실제 commit SHA를 확인한다. Git Closeout이 요청되지 않은 상태의 `skipped`는 유효하다.
- 결과 `settled`과 `blockers`는 **읽기 전용 진단**이다. 새로운 인증·승인·검증 엔진이 아니다.

## 3. Trust 및 재실행/삭제 제한

- Reviewer/Proof 검증은 기존 `evaluateTrustCompletion()`과 persisted Completion Decision을 그대로 유지한다. Settlement가 Reviewer/Proof를 새로 평가하거나 위조된 보고를 별도로 승인하지 않는다.
- Git 재시도는 기존 Closeout Receipt와 idempotence 경로가 담당한다. 새 호출이 커밋·푸시를 실행하지 않는다.
- Knowledge 지연·오류는 기존 Recovery가 처리한다. Settlement가 `deferred`를 `no_change`로 바꾸거나 증거를 삭제하지 않는다.
- W3는 **Run 데이터 삭제 API를 추가하지 않는다**. 향후 W4/W5의 삭제는 동일 트랜잭션의 원자적 재검증, 진행 중 소유권·Lease·FK 소비자 처리, 격리 복구 테스트를 통과해야 한다. 현재 Settlement 결과만으로 즉시 삭제하는 코드는 허용하지 않는다.

## 4. 검증 매트릭스

- 정상 완료, accepted Completion 및 Knowledge 정착, Git 요청 없음 → `settled`.
- 실제 Git Closeout 부분 실패 후 재시도 성공, 같은 Git commit SHA 유지, 확정 Knowledge → `settled`.
- Completion Decision 누락·증거 불일치 → `completion_authority_unsettled`.
- Knowledge Commit Receipt 존재하나 FK 없는 트랜잭션 영수증 누락 → `knowledge_ledger_unsettled`.
- 요청된 Git Closeout의 실제 Receipt 누락 → `git_closeout_unsettled`.
- 선택적 Knowledge `deferred`이고 Git 완료·코드 Finalization 완료 → **정리 불가**.
- 필수 Knowledge `deferred`이고 Finalization `partial` → **정리 불가**.

## 5. 판정

- `npm run build` 및 `build:check`: **PASS**, Runtime 308 files / 841 edges, generated changed 2 / check changed 0.
- `npm run build:tests`, `build:tests:check`: **PASS**, 289 tests + 8 helpers.
- `npm run check:boundaries`: **PASS**, 9 modules / 308 files / 841 dependency edges.
- Linux/WSL2 Finalization·Knowledge Recovery·Git 재시도 집중: **11/11 PASS**.
- Linux/WSL2 Knowledge Revision·Git closeout 재시도 분리: **7/7 PASS**. 초기 4파일 통합 명령은 새 테스트 파일 전환 지점에서 코드 assertion/오류 메시지 없이 exit 1이었으므로 전체 PASS로 간주하지 않았다. 나머지를 별도 명령으로 재검증해 exit 0·7/7을 확인했다. 초기 exit 1의 직접 원인은 미확정이다.
- Windows Native 동일 Finalization·Knowledge Recovery 집중: **11/11 PASS**, exit 0.
- Git Closeout 성공 재시도 후 Settlement 긍정 수용: Linux 및 Windows Native **각 1/1 PASS** (테스트 빌드 재검증 후 실행).
- 정상 accepted Completion + committed Knowledge + 요청 없는 Git은 `settled=true`, Completion Decision 누락, 독립 Knowledge 영수증 누락, Git Request 증거 누락은 `settled=false`. 선택적 `deferred`와 필수 Knowledge `partial`은 모두 정리 불가.
- 진행 중 Agent/Codex 세션·운영 DB 쓰기·실제 Run 삭제: **실행하지 않음**. Mac Native/MCP 수정본 수용도 **미실행**.

**W3 구현·회귀 판정: PASS (읽기 전용 정착 경계만).** 전체 Ephemeral Work 통합 수용은 W4/W5의 원자적 재검증·FK 제거·실제 삭제 격리 복구 및 W7 실제 Host 검증 전까지 **PARTIAL**로 유지한다.
