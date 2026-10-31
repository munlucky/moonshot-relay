# W0 결과 — 작업 영속성 제거를 위한 현행 권위/소비자 기준선

- 기준: `main / c53bcd63`, 시작 시 clean
- 조사일: 2026-10-31, WSL2 Moonremote / Windows Runtime 공유 경로
- 범위: W0 정적 스키마 및 소스 분석, 기존 Native/격리 시험 증거 대조
- 최종 판정: **W0 PARTIAL — 정적 목록과 격리 SQL 비용 실측 완료, 실제 병렬 writer·작업 인계 E2E 미검증**. 후속 결과는 §9 참조.
- 저장소 변경: 실행 계약 및 조사 문서만. 제품 코드, SQLite 스키마, 운영 DB, 계정 설치, Active Agent/Kernel Session 미변경
- 관련 문서: [실행 계약](PLAN.md), [38개 테이블 + 전체 인덱스/FK 목록](W0_STORAGE_INVENTORY.md)

## 1. 최초 검증된 사실

1. 운영 SQLite의 `sqlite_master` 사용자 테이블은 38개, `PRAGMA index_list`에서 인덱스 56개, `PRAGMA foreign_key_list`에서 FK 행 28개였다. 데이터 행 자체를 읽거나 변경하지 않았다.
2. 대상 DB는 `C:\Users\moon\.moon-relay-kernel\state\runtime-state.sqlite`이고 WSL2에서는 `/root/.moon-relay-kernel/state/runtime-state.sqlite`로 보인다. 실제 파일시스템은 Windows C:를 통한 9p 마운트다. SQLite 접근은 소유 Host가 명확해야 한다.
3. `src/kernel/state-store.ts:102-125`의 `openKernelStateStore()`는 SQLite 열기 후 `initializeKernelSchema`, `migrateKernelSchema`, `recoverKnowledgeMigrations`, `runJournalSchema`를 수행한다. 읽기 성격의 Control Plane 진입도 이 구성 경로를 사용한다.
4. `src/kernel/control-plane.ts:1339-1490`의 `startRun()`은 Run/Obligations/Steps를 만든 뒤 FRAME Knowledge Context를 구축하고 Receipt를 DB에 저장한다. 그 처리 실패는 bootstrap rollback 범위에 있다. 선택적 Context 오류를 핵심 Run 시작 오류로 확대할 수 있는 결합이다.
5. `src/kernel/persistence/knowledge-lifecycle-store.ts:949-1195`는 Knowledge 승격 트랜잭션 안에서 `getRun`, `getCompletionDecision`, `getKnowledgeReviewReceipt`를 사용한다. 동일 트랜잭션은 `knowledge_records`, `knowledge_revisions`, `knowledge_transactions`, `knowledge_commit_receipts`, `runs`도 변경한다. 영구 Run 없이 Knowledge를 저장할 계약을 W2에서 먼저 만들 필요가 있다.
6. `src/kernel/state-store.ts:923`는 기존 Run을 영구 사용자 기록으로 취급한다. `docs/public/guidelines/kernel-execution-capsule-and-step-ledger.md`는 영속 Run/Step과 Receipt lineage를 완결성의 근거로 정의한다. 따라서 이번 개선은 단순 구현 교체가 아니라 **기존 영속 계약의 의도적 변경**이다.
7. 이미 존재하는 일부 비차단 처리: `src/kernel/run/finalization.ts:683-740`는 필수 Knowledge 누락을 `partial`로, 비필수 저장 실패를 조건에 따라 계속 진행하도록 처리한다. `src/kernel/control-plane.ts:515`도 Telemetry 오류로 Run Lifecycle을 변경하지 않는다. 해당 경계를 확대하되 별도 런타임 시스템은 만들지 않는다.
8. DB 스키마의 FK는 Knowledge Candidate/Approval/Receipt, Verification, Review, Completion 등 여러 테이블을 `runs`에 결합한다. `runs`만 먼저 삭제하거나 완료 뒤 정리하면 FK 또는 지식 provenance가 깨진다.
9. `workspace_mutation_locks`에는 검색한 현행 소스 206개 파일에서 직접 토큰이 없고, `workspace_mutation_locks_v2`는 `work-lifecycle-store.ts`에 SQL 소비자가 있다. 이전 설치본까지 조사하기 전에는 legacy 테이블 삭제를 승인하지 않는다.

## 2. 현재 실제 호출/권위 그래프

```text
kernel next / report
  src/application/kernel-cli/main.ts
    -> createKernelControlPlane
       src/host/kernel/control-plane-runtime.ts
    -> openKernelStateStore
       src/kernel/state-store.ts
       -> openSqliteDb
       -> initializeKernelSchema
       -> migrateKernelSchema
       -> recoverKnowledgeMigrations
       -> runJournalSchema
       -> Work + Trust + Knowledge + Host + Finalization Store

new Run
  -> project/worktree identity + Task Contract
  -> Run + Obligation + Step
  -> Context projection + Knowledge Context Receipt
  -> Locator/Run projection
  -> initial rollback boundary

Knowledge commit
  -> Run / Completion / Review DB rows
  -> Knowledge Records + Revision CAS
  -> Knowledge Commit Receipt + Run update
```

**이 그래프는 소스 호출 관계이지 실제 SQL 실행 횟수 측정이 아니다.** `next/report`당 write 증가는 별도 격리 실험으로 입증해야 한다.

## 3. 보존 / 축소 가설

| 현행 소유 | 유지할 의미 | 전환 방향 | 제거 가능 조건 |
| --- | --- | --- | --- |
| Work Run/Step/Attempt | 현재 작업 정체성, 진행 중 step, 중단 복구 | Agent/Host + 필요한 최소 active checkpoint | 동일 작업의 중단·재개·인계가 검증되고 외부 증거가 안정적일 것 |
| Lease/Fencing | 두 writer의 충돌 방지 | 실행 범위 안에서만 유지 | active owner 없음, 미정착 부작용 없음 |
| Trust Verification/Review/Completion | 실제 실행·Reviewer·완료의 증명 | 실행 중 보존, 정착 뒤 최소 출처/해시 | Git/CI/외부 불변 증거로 재검증 가능하고 허위 PASS 불가능할 것 |
| Git closeout | push 실패/성공/재시도 중복 방지 | 정착 전 짧은 영수증 | remote parity와 approved SHA 확인 |
| Knowledge | 검증된 내용, scope, provenance, CAS, supersession | **계속 영속화** | 제거 대상 아님 |
| Project Identity | namespace 독립성과 정확한 지식 적용 | 최소 영속 메타 유지 | alias/migration 권위 입증 전 축소 불가 |
| Context / Usage | 프롬프트 Projection, 통계, 캐시 | 파생 캐시·진단 데이터로 취급 | 입력 원본으로 같은 출력을 다시 만들 수 있어야 함 |
| Historical improvement | 과거 실패/성공으로 재귀 개선 | Agent session·Git·읽기 전용 archive 분석 | 기존 DB 이력을 먼저 보존하고 개선 후보 회수력 대조 |

현재의 저장량 218 MiB가 곧 제거 가능한 218 MiB라는 뜻은 아니다. 특히 지식 승격의 근거가 현재 `runs` 또는 Review/Proof 테이블에만 있을 수 있다. 이를 검증하지 않은 크기 중심 삭제는 금지한다.

## 4. Host/파일시스템 소유 조사

| Surface | 확인한 사실 | 남은 증거 / 판정 |
| --- | --- | --- |
| Windows native Codex | 과거 W8 Native GitHub Runner 성공 및 Windows 사용자 계정 설치 SHA 검증; 10/28·10/31 운영 DB 손상 기록 보존 | 사용자 Windows 계정의 실제 Native Agent 재시작/동시 DB writer E2E는 미검증 |
| Windows WSL2 Moonremote | 현재 WSL2의 `/root/.moon-relay-kernel`은 C:의 9p 파일과 동일 | 서로 다른 OS VFS의 동시 WAL writer·파일 핸들에 대한 실제 관측 미확보 |
| Mac native Codex | 기존 W8 Mac native, 계정 Runtime, Profile Doctor, Kernel CLI 격리 테스트 성공 | 새로운 ephemeral work 실험과 진행 중 실제 세션 인계는 아직 미실시 |
| Mac MCP | 별도 MCP 실행 표면 존재 | Mac 로컬과 MCP의 runtimeHome realpath, DB 실제 writer, session handoff 측정 필요 |

Windows와 WSL2가 같은 파일을 직접 열 수 있다는 사실은 확인됐다. **두 프로세스가 동시에 같은 WAL을 실제로 기록했다는 인과관계는 미확정**이다. 제품 코드에 새로운 Host별 경로 폴백을 추가하지 않는다.

## 5. 고정된 실패 반례와 코드 변경 전 게이트

| 반례 | 필요한 확인 |
| --- | --- |
| optional Context 생성/저장 실패 | 핵심 코드 실행은 진행, 지식 누락은 명확하게 표시 |
| required Knowledge 승격 실패 | code accepted와 finalization partial 구분, false done 0 |
| Git push 성공·receipt 저장 실패 | 이미 반영한 commit SHA 재검증, 재커밋/재푸시 0 |
| 유효하지 않은 Reviewer/route/usage identity | 보호된 리뷰/판정 PASS 0 |
| Step 변경 후 과거 Evidence 재사용 | workspace identity·mutation revision 불일치 검출 |
| Agent 세션 유실 / native↔MCP 인계 | 작업 선택 오류·무단 쓰기 0, unsupported이면 명시 |
| Active Run owner 경쟁 / stale lease | 단일 허용 writer, fencing 유지 |
| DB 손상 / busy / IO | 실패 원인 보존; optional Knowledge 격리, 필수 authority 위조 금지 |
| 지식 Revision CAS 충돌 | 동일 지식 중복 승격 0, supersession 원자성 |
| 완료 뒤 pending closeout | 정착 이전 checkpoint/영수증 삭제 금지 |

기존 검증 기준: `tests/kernel-session-run-lifecycle.test.mjs`, `kernel-run-locator-fail-soft.test.mjs`, `kernel-knowledge-revision.test.mjs`, `kernel-knowledge-lifecycle-e2e.test.mjs`, `kernel-report-replay.test.mjs`, `kernel-finalization-knowledge-nonblocking.test.mjs`, `kernel-owner-mutation-recovery.test.mjs`, `kernel-concurrent-commit.test.mjs`, `kernel-git-closeout-retry.test.mjs`, `kernel-bridge-mcp.test.mjs`, `kernel-review-receipt-completion.test.mjs` 등.

## 6. 최초 작성 당시 미실행 항목 (후속 실측은 §9에서 갱신)

- 격리 Runtime에서 `next` 신규/재개, `report` 검증/재시도, `done`, Git closeout, Knowledge required/optional의 SQL write 횟수·DB bytes/Run·latency p50/p95 (같은 HEAD, 양 arm).
- 4개 Host의 native/MCP 세션을 모두 포함한 실제 동시 사용, 프로세스 중단·인계/재시작 연속성.
- 각 테이블의 쓰기/읽기 메서드를 SQL callsite까지 완결한 실행 경로 조사. 현재 inventory 파일의 검색 결과는 exact token 기반 정적 앵커로만 사용한다.

기존 v2 W9의 stable `next` p50 11.154ms / p95 18.661ms와 이전 282/282 Reliability 통과는 **역사적 참고값**이다. 현재 W0의 동일 조건 신규 실측이나 새 아키텍처 효과의 증거가 아니다.

## 7. 최초 판정과 다음 행동 (작성 당시 기록)

**W0 PARTIAL**: 정적 38/56/28 인벤토리와 구조적 결합, 안전성 반례, 유지/제거 후보, 이전 검증 근거는 작성했다. 단, Host 실제 인계와 단위 실행별 SQL writes·latency가 누락돼 아직 W0 PASS가 아니다.

가장 작은 후속 범위는 W0 격리 성능 프로브와 실제 Native/MCP DB realpath/세션 소유권 측정이다. 그 결과를 반영해 수명 계약을 승인하고, W1 Agent/Host 재개 실험과 W2 Knowledge 독립화로 진입한다. **현재 W0 문서만으로 W2부터 생산 코드를 바꾸거나 운영 Run을 정리하지 않는다.**

기존 활성 MCP v2 W0~W10 체크포인트는 별도 범위로 보존하며 이번 W0로 완료 상태를 덮어쓰지 않는다.

## 8. 격리 회귀 검증 결과

실행: Windows 계정 Runtime을 사용하지 않는 WSL2의 임시 `HOME` / `TMPDIR` / `XDG_CACHE_HOME`에서 다음 기존 제품 테스트 실행.

```bash
node --test --test-concurrency=1 \
  tests/kernel-run-locator-fail-soft.test.mjs \
  tests/kernel-knowledge-revision.test.mjs \
  tests/kernel-finalization-knowledge-nonblocking.test.mjs \
  tests/kernel-report-replay.test.mjs
```

- 결과: **23 PASS / 0 FAIL / 0 SKIP**, 종료 코드 0, 76,999.594ms.
- 범위: optional vs required Knowledge, Knowledge Revision CAS, Git 보고 재실행/중복 방지, locator stale/new-task 안전성.
- 한계: 테스트는 **기존 SQLite 기반 구현의 회귀 기준선**을 검증했다. Ephemeral Work 전환의 성능·개선 또는 실제 Windows/Mac/MCP 인계 성공을 입증하지 않는다.
- 실행 추적: MCP 작업 `a90ce9d1-b759-4888-a6f2-30acc3657898`, operation `b61c0fc8-8f7e-410f-93d9-0a654e2f5107`.

## 9. W0 Native/MCP 경로 및 SQL 실행 비용 후속 실측 (2026-10-31)

새 근거: [W0_RUNTIME_MEASUREMENT.md](W0_RUNTIME_MEASUREMENT.md).

- **Windows Native**: 현재 Host 실행이 가능해 직접 확인했다. 운영 DB는 `C:\Users\moon\.moon-relay-kernel\state\runtime-state.sqlite`(228,564,992 B). WSL2의 `/root/.moon-relay-kernel`은 같은 Windows 홈을 `9p` 공유 경로로 사용한다.
- **Mac Native**: `/Users/seokgimoon/.moon-relay-kernel/state/runtime-state.sqlite`(48,054,272 B). **Mac MCP Linux VM**의 `/root/.moon-relay-kernel/state/runtime-state.sqlite`는 `virtiofs` Host 공유 볼륨이며 파일 크기·mtime이 동일하다. Mac MCP에는 0 B WAL / 32 KiB SHM 파일이 관측되었다.
- **반복 SQLite 오픈:** 기존 격리 DB 재연결 4회에서 매회 `DatabaseSync.exec` 156회, SQL 텍스트의 `CREATE` 70개·`ALTER TABLE` 143개가 기록됐다. 이는 SQL 성공/물리적 쓰기 수가 아니라 **시도된 SQL 구문 수**다.
- **실제 Control Plane:** 재시작 시 `exec` 162회, `CREATE` 70개·`ALTER` 143개. `startRun`과 두 `report`에서 다수 DML 기록, `next`/재시작 후 `next`에서는 이 fixture의 DML 0. Run은 `implement` → `in-progress` → `completed/done` → 재시작 `done`으로 정상 진행.
- **지연 기준선:** 동일 격리 Runtime에서 안정 `next` 20회 p50 10.38ms/p95 15.22ms, Control Plane reopen 20회 p50 29.39ms/p95 36.46ms. 아직 최적화 전후 비교는 없다.
- **W0 판정:** 정적 목록과 Native/MCP 공유 경로 조사, 격리 Store/Control Plane 호출·지연 기준선은 확보했다. 실제 양 OS의 SQLite 동시 writer, 강제 중단, 인계/복구 E2E는 미실행이므로 **통합 W0 PARTIAL**을 유지한다. 해당 위험 검증은 W1/W7의 필수 항목으로 인계한다.
- 운영 SQLite/WAL, 사용자 Codex 세션, 제품 소스와 기존 체크포인트의 권위를 수정하지 않았다.
