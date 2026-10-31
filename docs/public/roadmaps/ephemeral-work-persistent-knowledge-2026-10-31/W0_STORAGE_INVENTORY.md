# W0 — SQLite tables, indexes, foreign keys and source consumers

- 조사: 2026-10-31 / checkout main c53bcd63 (clean at start).
- 범위: Windows 계정 Runtime SQLite 사용자 테이블 38개, 인덱스/FK, 소스 파일 206개의 정적 테이블 식별자 검색.
- 읽기 전용: Python sqlite3 mode=ro + immutable=1. SQL 데이터 수정, DB 복구, checkpoint, migration은 수행하지 않음.
- **주의:** 텍스트 검색은 SQL 실행 경로, 런타임 분기, 프로세스별 소유권을 완전히 입증하지 못한다. 컬럼/프로퍼티와 이름이 겹치는 경우 거짓 양성이 있을 수 있다.

## 분류 계약 (모두 제거 승인 전 가설)

K=영구 Knowledge 권위, P=프로젝트 Identity 영구 메타데이터, A=활성 작업 한정, S=정착(Git/검증/지식) 이전의 짧은 Trust 상태, D=검증 후 파생/재생성 가능, Q=추가 결합 조사 필요, L=구형 이관 후보(삭제 승인 아님).

## 모든 사용자 테이블과 코드 참조

| 테이블 | 후보 수명 | 인덱스 | FK | 주요 소스 참조(스키마 선언 제외) |
|---|:---:|---:|---:|---|
| `attempts` | Q | 0 | 1 | `src/host/kernel/host-routing.ts:96`, `src/host/kernel/model-routing.ts:28`, `src/host/kernel/turn-dispatcher.ts:700` |
| `candidate_evidence_bindings` | S | 1 | 2 | `src/kernel/persistence/knowledge-lifecycle-store.ts:825` |
| `completion_decisions` | S | 1 | 1 | `src/kernel/persistence/run-journal.ts:55`, `src/kernel/persistence/trust-store.ts:452`, `src/kernel/persistence/work-lifecycle-store.ts:618` |
| `evidence_lineage` | S | 0 | 1 | `src/kernel/persistence/trust-store.ts:333` |
| `evidence_packs` | S | 0 | 1 | `src/kernel/persistence/trust-store.ts:438` |
| `finalization_receipts` | S | 1 | 1 | `src/kernel/persistence/finalization-store.ts:50` |
| `git_closeout_receipts` | S | 1 | 1 | `src/kernel/persistence/host-execution-store.ts:304` |
| `knowledge_approvals` | S | 1 | 1 | `src/kernel/persistence/knowledge-lifecycle-store.ts:1285` |
| `knowledge_candidates` | A | 1 | 1 | `src/kernel/persistence/knowledge-lifecycle-store.ts:181` |
| `knowledge_commit_receipts` | S | 1 | 1 | `src/kernel/persistence/knowledge-lifecycle-store.ts:914`, `src/kernel/persistence/run-journal.ts:60` |
| `knowledge_context_receipts` | D | 1 | 1 | `src/kernel/persistence/knowledge-lifecycle-store.ts:769` |
| `knowledge_imports` | Q | 2 | 0 | `src/kernel/persistence/knowledge-lifecycle-store.ts:252` |
| `knowledge_records` | K | 1 | 0 | `src/kernel/persistence/knowledge-lifecycle-store.ts:235` |
| `knowledge_review_receipts` | S | 1 | 1 | `src/kernel/persistence/knowledge-lifecycle-store.ts:195` |
| `knowledge_revisions` | K | 1 | 0 | `src/kernel/persistence/knowledge-lifecycle-store.ts:202`, `src/kernel/state-store.ts:467` |
| `knowledge_transactions` | Q | 1 | 0 | `src/kernel/persistence/knowledge-lifecycle-store.ts:1138` |
| `leases` | A | 1 | 1 | `src/kernel/persistence/work-lifecycle-store.ts:486`, `src/kernel/bridge/coordinator-surface.ts:4` |
| `meta` | Q | 1 | 0 | `src/application/kernel-cli/account-install.ts:10`, `src/host/kernel/cache-replay.ts:71`, `src/host/kernel/model-route-policy.ts:61` |
| `model_route_decisions` | S | 1 | 1 | `src/kernel/persistence/host-execution-store.ts:65`, `src/kernel/persistence/work-attempt-store.ts:529` |
| `model_usage_receipts` | Q | 2 | 2 | `src/kernel/persistence/host-execution-store.ts:123` |
| `mutation_provenance` | S | 1 | 1 | `src/kernel/persistence/work-attempt-store.ts:708`, `src/kernel/control-plane.ts:2550` |
| `project_identities` | P | 2 | 0 | `src/kernel/persistence/knowledge-migration-recovery.ts:21`, `src/kernel/persistence/project-identity-store.ts:60`, `src/kernel/state-store.ts:339` |
| `project_identity_aliases` | P | 3 | 0 | `src/kernel/persistence/project-identity-store.ts:79` |
| `project_workspaces` | Q | 2 | 0 | `src/kernel/persistence/work-lifecycle-store.ts:671`, `src/kernel/state-store.ts:464` |
| `review_receipts` | S | 4 | 1 | `src/kernel/persistence/run-journal.ts:53`, `src/kernel/persistence/trust-store.ts:502` |
| `route_admissions` | S | 3 | 1 | `src/kernel/persistence/host-execution-store.ts:245` |
| `run_capsules` | D | 2 | 1 | `src/kernel/persistence/work-attempt-store.ts:825`, `src/kernel/persistence/work-lifecycle-store.ts:616` |
| `run_journal` | Q | 1 | 0 | `src/kernel/persistence/run-journal.ts:19`, `src/kernel/persistence/work-lifecycle-store.ts:901` |
| `run_obligations` | A | 1 | 1 | `src/kernel/persistence/trust-store.ts:339` |
| `run_step_attempts` | A | 5 | 1 | `src/kernel/persistence/work-attempt-store.ts:348`, `src/kernel/persistence/work-lifecycle-store.ts:615`, `src/kernel/run/attempt-provenance.ts:3` |
| `run_steps` | A | 2 | 1 | `src/kernel/persistence/run-journal.ts:42`, `src/kernel/persistence/work-attempt-store.ts:983`, `src/kernel/persistence/work-lifecycle-store.ts:619` |
| `runs` | A | 3 | 0 | `src/kernel/persistence/finalization-store.ts:42`, `src/kernel/persistence/host-execution-store.ts:59`, `src/kernel/persistence/knowledge-lifecycle-store.ts:751` |
| `session_bindings` | A | 5 | 1 | `src/kernel/persistence/work-lifecycle-store.ts:759`, `src/kernel/run/run-locator.ts:519` |
| `verifications` | S | 0 | 1 | `src/kernel/persistence/durable-state.ts:79`, `src/kernel/persistence/run-journal.ts:48`, `src/kernel/persistence/trust-store.ts:283` |
| `waivers` | S | 0 | 1 | `src/kernel/persistence/trust-store.ts:711`, `src/kernel/control-plane.ts:856`, `src/kernel/proof/trust-authority.ts:215` |
| `workspace_mutation_locks` | L | 1 | 0 | **source token absent** |
| `workspace_mutation_locks_v2` | A | 1 | 0 | `src/kernel/persistence/work-lifecycle-store.ts:731` |
| `worktree_mutation_leases` | A | 1 | 1 | `src/kernel/persistence/work-lifecycle-store.ts:718`, `src/kernel/run/run-locator.ts:521` |

- 합계: 38 사용자 테이블 / 56 인덱스 / 28 FK 엔트리.
- 소스 토큰이 없는 테이블: `workspace_mutation_locks` (구버전 설치본·외부 소비자 미확인; 단독 삭제 불가).

## 모든 인덱스 이름

- `candidate_evidence_bindings`: `sqlite_autoindex_candidate_evidence_bindings_1`
- `completion_decisions`: `sqlite_autoindex_completion_decisions_1`
- `finalization_receipts`: `sqlite_autoindex_finalization_receipts_1`
- `git_closeout_receipts`: `sqlite_autoindex_git_closeout_receipts_1`
- `knowledge_approvals`: `sqlite_autoindex_knowledge_approvals_1`
- `knowledge_candidates`: `sqlite_autoindex_knowledge_candidates_1`
- `knowledge_commit_receipts`: `sqlite_autoindex_knowledge_commit_receipts_1`
- `knowledge_context_receipts`: `sqlite_autoindex_knowledge_context_receipts_1`
- `knowledge_imports`: `sqlite_autoindex_knowledge_imports_2`, `sqlite_autoindex_knowledge_imports_1`
- `knowledge_records`: `sqlite_autoindex_knowledge_records_1`
- `knowledge_review_receipts`: `sqlite_autoindex_knowledge_review_receipts_1`
- `knowledge_revisions`: `sqlite_autoindex_knowledge_revisions_1`
- `knowledge_transactions`: `sqlite_autoindex_knowledge_transactions_1`
- `leases`: `sqlite_autoindex_leases_1`
- `meta`: `sqlite_autoindex_meta_1`
- `model_route_decisions`: `sqlite_autoindex_model_route_decisions_1`
- `model_usage_receipts`: `idx_model_usage_receipts_attempt`, `sqlite_autoindex_model_usage_receipts_1`
- `mutation_provenance`: `sqlite_autoindex_mutation_provenance_1`
- `project_identities`: `sqlite_autoindex_project_identities_2`, `sqlite_autoindex_project_identities_1`
- `project_identity_aliases`: `idx_project_identity_aliases_project`, `sqlite_autoindex_project_identity_aliases_2`, `sqlite_autoindex_project_identity_aliases_1`
- `project_workspaces`: `sqlite_autoindex_project_workspaces_2`, `sqlite_autoindex_project_workspaces_1`
- `review_receipts`: `idx_review_receipts_obligation`, `idx_review_receipts_run`, `uq_review_receipts_subject`, `sqlite_autoindex_review_receipts_1`
- `route_admissions`: `idx_route_admissions_attempt`, `idx_route_admissions_run`, `sqlite_autoindex_route_admissions_1`
- `run_capsules`: `idx_run_capsules_run`, `sqlite_autoindex_run_capsules_1`
- `run_journal`: `idx_run_journal_run`
- `run_obligations`: `sqlite_autoindex_run_obligations_1`
- `run_step_attempts`: `idx_run_step_attempts_review_claim`, `idx_run_step_attempts_lineage`, `idx_run_step_attempts_step`, `uq_run_step_attempts_report_key`, `uq_run_step_attempts_attempt_id`
- `run_steps`: `idx_run_steps_run`, `sqlite_autoindex_run_steps_1`
- `runs`: `idx_runs_project_worktree_status`, `uq_runs_successor_key`, `sqlite_autoindex_runs_1`
- `session_bindings`: `idx_session_bindings_project`, `idx_session_bindings_lookup`, `uq_project_session_workspace_active_owner`, `uq_run_active_owner`, `sqlite_autoindex_session_bindings_1`
- `workspace_mutation_locks`: `sqlite_autoindex_workspace_mutation_locks_1`
- `workspace_mutation_locks_v2`: `sqlite_autoindex_workspace_mutation_locks_v2_1`
- `worktree_mutation_leases`: `sqlite_autoindex_worktree_mutation_leases_1`

## 모든 외래키 연결

- `attempts.run_id` → `runs.run_id` (id=0, seq=0)
- `candidate_evidence_bindings.run_id` → `runs.run_id` (id=0, seq=0)
- `candidate_evidence_bindings.candidate_id` → `knowledge_candidates.candidate_id` (id=1, seq=0)
- `completion_decisions.run_id` → `runs.run_id` (id=0, seq=0)
- `evidence_lineage.run_id` → `runs.run_id` (id=0, seq=0)
- `evidence_packs.run_id` → `runs.run_id` (id=0, seq=0)
- `finalization_receipts.run_id` → `runs.run_id` (id=0, seq=0)
- `git_closeout_receipts.run_id` → `runs.run_id` (id=0, seq=0)
- `knowledge_approvals.run_id` → `runs.run_id` (id=0, seq=0)
- `knowledge_candidates.run_id` → `runs.run_id` (id=0, seq=0)
- `knowledge_commit_receipts.run_id` → `runs.run_id` (id=0, seq=0)
- `knowledge_context_receipts.run_id` → `runs.run_id` (id=0, seq=0)
- `knowledge_review_receipts.run_id` → `runs.run_id` (id=0, seq=0)
- `leases.run_id` → `runs.run_id` (id=0, seq=0)
- `model_route_decisions.run_id` → `runs.run_id` (id=0, seq=0)
- `model_usage_receipts.run_id` → `runs.run_id` (id=0, seq=0)
- `model_usage_receipts.decision_id` → `model_route_decisions.decision_id` (id=1, seq=0)
- `mutation_provenance.run_id` → `runs.run_id` (id=0, seq=0)
- `review_receipts.run_id` → `runs.run_id` (id=0, seq=0)
- `route_admissions.run_id` → `runs.run_id` (id=0, seq=0)
- `run_capsules.run_id` → `runs.run_id` (id=0, seq=0)
- `run_obligations.run_id` → `runs.run_id` (id=0, seq=0)
- `run_step_attempts.run_id` → `runs.run_id` (id=0, seq=0)
- `run_steps.run_id` → `runs.run_id` (id=0, seq=0)
- `session_bindings.run_id` → `runs.run_id` (id=0, seq=0)
- `verifications.run_id` → `runs.run_id` (id=0, seq=0)
- `waivers.run_id` → `runs.run_id` (id=0, seq=0)
- `worktree_mutation_leases.holder_run_id` → `runs.run_id` (id=0, seq=0)

## 실무 판단과 추적 필요성

1. Knowledge commit은 getRun / getCompletionDecision / getKnowledgeReviewReceipt를 검사하고 Knowledge DB 트랜잭션에서 Run도 업데이트한다. K와 A의 독립화가 W2의 필수 선행이다.
2. 완료 Trust/Receipt를 Run FK에서 해제하려면 현재 보호된 Reviewer·Approval·Git closeout의 증거 정착과 외부 원본 출처를 증명해야 한다.
3. K(2개) 외에도 P(2개)는 프로젝트/지식 소유 범위에 필요한 영속 상태 후보다. Knowledge-only라는 표현을 Project ID 삭제로 확대하지 않는다.
4. D(2개)는 재계산 가능성을 검증해야 한다. 재생성의 입력이 삭제할 Run에만 존재하면 D가 아니다.
5. A, S는 정착 조건을 확보한 후에만 정리한다. 진행 중 작업·미완료 승인·push 재시도·필수 Knowledge pending은 삭제하지 않는다.
6. Q 항목 중 attempts, meta, project_workspaces, knowledge_imports, knowledge_transactions, model_usage_receipts, run_journal은 실제 사용 의미를 분리해 다음 Wave에 인계한다.
7. source tokens 없는 workspace_mutation_locks는 legacy 추정일 뿐이다. 구형 빌드/계정 설치본의 SQL 소비자를 확인하기 전 DROP 금지.
8. Agent Session 로그는 영구 공통 저장소가 아니다. Session 재시작/인계와 Trust 증거 재조회 능력을 입증하기 전에 영속 Run 삭제 금지.

## 재현 방법

- SQLite: sqlite_master에서 사용자 테이블 수 확인; 각 테이블 PRAGMA index_list, foreign_key_list만 조회.
- 코드: src/kernel, src/host/kernel, src/application/kernel-cli의 TS/MJS/JS에서 SQL 테이블명 완전 일치 검색. schema.ts와 schema-migrations.ts는 선언 경로로 별도 확인.
- 완료 판단: 이 목록은 W0 정적 기준선이다. reader/writer 실행 그래프·실측 DB writes/latency·Windows/Mac/MCP Host 소유권이 미확인인 동안 W0 전체는 PARTIAL.
