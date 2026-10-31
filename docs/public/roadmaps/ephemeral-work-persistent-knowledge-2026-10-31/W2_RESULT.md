# W2 — Knowledge 영속 출처 독립화: 구현·검증 결과

- 기준: `main / 4a11d600`, 2026-10-31.
- 범위: 기존 SQLite Knowledge 저장소에 검증된 출처를 정착시키고, Run/Completion/Review의 조회 없이도 Knowledge 레코드·Revision·Supersession을 해석할 수 있는 상태를 확보한다.
- 상태: **PARTIAL**. 완전한 W2 통과 조건인 'Run 영구 행 없이 Knowledge **Commit**'은 아직 구현·검증되지 않았다.
- 운영 DB, 현재 활성 Run/Agent Session, Mac 계정 설치본 변경 없음. 새 DB·중복 authority·별도 이벤트 스토어 없음.

## 코드 조사 결과

`src/kernel/persistence/knowledge-lifecycle-store.ts`의 기존 `commitKnowledgeTransaction()`은 원자적 SQLite 쓰기 내부에서 `getRun`, `getCompletionDecision`, `getKnowledgeReviewReceipt`로 완료 권한을 확인하고, Knowledge 변경 후 `runs` 및 FK로 연결된 `knowledge_commit_receipts`를 수정한다. 즉, **현재 Commit 시점은 활성 Run을 필요로 한다**.

반면 `knowledge_records`, `knowledge_revisions`, `knowledge_transactions`에는 `runs` 외래 키가 없다. `listKnowledgeRecords`, `getProjectKnowledgeRevision`, `appendKnowledgeEvidence`, 사용자 승인 Import의 기본 데이터 경로는 Run row를 읽지 않는다. 기존 Knowledge 자체의 장기 조회 경계는 독립시키기 쉽지만, 승인되지 않은 커밋을 방지하려면 Run 삭제 전에 Trust 정착이 필요하다.

## 이번에 적용한 최소 개선

`src/kernel/persistence/knowledge-lifecycle-store.ts`에서 다음을 구현했다.

1. **Knowledge Commit의 트랜잭션 내부 Trust 검증 강화**: accepted Completion뿐 아니라 `sourceIdentity`와 `mutationRevision`이 현재 Run과 일치하고 `evidenceDigest`가 존재하는지 확인한다. Review receipt가 존재하면 Project Identity도 함께 확인한다. 실패 시 변경을 롤백한다.
2. **검증 출처의 Knowledge 본문 정착**: `knowledge_records.record_json.knowledgeAuthority`에 Kernel이 확인한 `runId`, `projectId`, `sourceIdentity`, `mutationRevision`, `completionDecisionRef`, `knowledgeReviewRef`, 원본 커밋 콘텐츠 SHA-256 digest를 저장한다. 이 값은 호출자의 `knowledgeAuthority`를 그대로 전달하지 않고 트랜잭션 안의 권위 행을 기준으로 생성한다.
3. **독립 트랜잭션 원본**: 별도 Run 외래 키가 없는 `knowledge_transactions.transaction_json.verifiedAuthority`에 동일한 권위 출처를 남긴다. 완료 Receipt에도 `verifiedAuthority`를 포함한다. 별도 테이블·스키마 마이그레이션 없이 기존 JSON 필드를 재사용한다.
4. **CAS 및 Supersession의 현재 로직 유지**: 프로젝트 Knowledge Revision만 변경하고, 다른 Project나 stale Revision 요청은 허용하지 않는다. Superseded 레코드의 기존 출처는 덮어쓰지 않는다.

SHA-256은 저장된 원본 내용의 식별자이지 서명이나 별도 인증 근거가 아니다. Kernel이 검증한 저장소 상태에서 생성했을 때만 출처로 해석한다.

## W2 통합 통과에 아직 필요한 작업

- **Commit 독립성**: Run·Completion·Review가 작업 정착 후 제거되더라도 Knowledge Commit/재시도를 안전하게 수행할 최소 Trust 근거를 **기존 영속 레코드에** 정착하고, 허위 snapshot 주입·프로젝트 교차 접근·오래된 Revision CAS를 차단해야 한다. 호출자의 자기 보고를 새로운 Trust 권위로 인정해서는 안 된다.
- **FK/작업 정리**: `knowledge_commit_receipts`와 `knowledge_candidates` 등 Run FK를 삭제하려면 W3 완료 정착 및 W5 소비자 전수조사 후 별도로 시행한다. 이번 Wave는 DROP/DELETE/REPAIR/VACUUM 금지.
- **기존 사용자 배포 및 cross-OS 동시성**: Windows Native와 Mac Native/VM에서 수정본의 Host 격리 회귀, 운영 데이터와 분리된 중단·재개 검증. Mac 설치본을 임의로 덮어쓰지 않는다.

## 검증 결과

- `npm run check:boundaries`: **PASS**, 9 modules, 308 files, 841 dependency edges.
- TypeScript runtime `npm run build`: **PASS**, 308 files, 841 dependency edges (generated JS 1 source).
- `npm run build:check`: **PASS**, changed 0, removed 0.
- `npm run build:tests` 및 `npm run build:tests:check`: **PASS**, 289 TypeScript tests, 8 helpers.
- WSL2 Linux 수정본 핵심 집중 5파일: **16/16 PASS**, fail 0, skip 0. 최초 15/16 실패는 이전 CAS fixture의 가짜 `mutationRevision: 1` 때문이었다. 완료 검증을 완화하지 않고 fixture가 실제 Run revision을 사용하도록 바로잡은 후 16/16 통과했다.
- WSL2 Linux 추가 Knowledge Lifecycle/Reuse/Promotion/Import/Completion 테스트 6파일: **17/17 PASS**, fail 0, skip 0.
- Windows Native Node 수정본 Knowledge Revision/Commit/Finalization 집중 3파일: **13/13 PASS**, fail 0, skip 0.
- 수정 전 실데이터 교체 및 운영 DB cleanup: **실행하지 않음**. Mac Native/MCP 변경 후 통합 테스트: **미실행**.

**W2 판정: PARTIAL.** 현재 Knowledge의 독립적 조회·출처 보존·CAS·Supersession은 위 범위에서 확인했다. **Run 없는 새 Commit 승인·재시도 및 실제 Run FK 제거 수용 테스트는 미완료**다. 따라서 W3~W5의 영구 Run 정리는 허용하지 않는다.

## W2 후속 — 완료된 Knowledge의 Run 독립 재조회 (2026-10-31)

### 구조 결정

영구 Run 의존을 줄이기 위해 별도 `prepared` 트랜잭션, 승인 토큰, 추가 영구 테이블 또는 이중 영속화 경로를 도입하지 않는다.

- **새로운 Knowledge Commit**은 활성 Run의 `sourceIdentity`·`mutationRevision`·accepted Completion·필수 증거와 Review를 검증하고 **작업 정리 전에** 완료한다.
- **완료된 Commit의 중복 재조회**는 `runs` FK가 없는 기존 `knowledge_transactions`의 최종 영수증을 읽는다. Run/Completion/Review 테이블 조회는 필요하지 않다.
- **Run 삭제 뒤 승인되지 않은 새 Commit**은 허용하지 않는다. 현재 Knowledge를 보존할 수 있지만 과거 Run이 없다는 이유로 신규 출처를 자동 신뢰하지 않는다.
- `no_change`는 새 Knowledge가 없으므로 `knowledge_transactions`에 별도 행을 추가하지 않는다. 기존 Finalization의 no-change 처리 및 단기 작업 영수증만 유지한다.

### 구현 경계

`commitKnowledgeTransaction()`의 시작에서 동일 `transactionId`가 이미 `completed` 상태인지 검사한다. 그런 경우 저장된 `outcome`과 원래 요청의 `requestDigest`를 사용해 중복 요청을 검증한다. `runId/projectId` 불일치, 제출한 내용의 digest 변경, 선언한 Revision 불일치, 예전 형식의 근거 불충분 트랜잭션은 거부한다. 새 트랜잭션은 종전대로 활성 Run·Completion·Review 권위를 요구한다.

검증에 성공한 *신규 커밋*만 트랜잭션과 Knowledge Revision, 레코드, 완료 Receipt를 원자적으로 기록한다. 기존 `knowledge_transactions`의 JSON에 결과를 넣는다. 별도 스키마, WAL 소유권 변경, Session 권한 폴백은 추가하지 않는다.

이 기능은 후속 W3/W4의 **작업 정리 전 완료 보장**을 대체하지 않는다. 이미 완료한 Commit만 조회 가능하며, 기존 DB의 과거 트랜잭션에는 새 결과 필드가 없을 수 있다. 그런 트랜잭션은 근거를 추측하지 않고 `KNOWLEDGE_TRANSACTION_REPLAY_UNVERIFIED`로 거부한다.

### 격리 반례

테스트 `W2: settled Knowledge replays with no Run, Completion or Review tables; new authority is denied`는 실제 임시 Kernel DB에서 Commit한 Knowledge, Revision, 트랜잭션을 **세 테이블만 있는 독립 SQLite**로 복사해 재조회한다. 여기에 `runs`, `completion_decisions`, `knowledge_review_receipts` 테이블은 존재하지 않는다.

검사 항목은 기존 Commit의 결과·Revision·레코드 보존, 신규 레코드 주입 차단, Project 불일치 차단, 잘못된 Revision 거부, 정착되지 않은 새 Commit의 거부, `no_change` 영구 Knowledge 트랜잭션 0건이다. 이 테스트는 운영 DB를 삭제하거나 호스트 간 SQLite 동시 쓰기를 수행하지 않는다.

### W2 결과 판정

**Kernel Knowledge의 영구 재조회·중복 요청 안전성 구현 범위는 코드 검증 대상이다.** Run 자체를 실제 운영 DB에서 삭제하지 않았으며, 전체 FK 소비자·계정 배포·Local/MCP 인계 수용은 W3/W5/W7에서 별도 확인해야 한다. W2 원래 계획의 'Run 없는 임의 신규 Knowledge Commit'은 별도 준비·인증 절차를 늘리는 방식보다 **정리 전 커밋 필수**로 좁혀야 한다는 설계 결정을 기록한다.

**W2 후속 검증 결과 (수정 최종본)**

- WSL2 Linux: Knowledge/Finalization 집중 **17/17 PASS** (0 FAIL, 0 SKIP)
- WSL2 Linux: Knowledge Lifecycle/Reuse/Promotion 등 추가 **17/17 PASS** (0 FAIL, 0 SKIP)
- Windows Native: 수정본 Knowledge Revision/Commit/Finalization **14/14 PASS** (0 FAIL, 0 SKIP)
- `npm run build`, `build:check`, `build:tests`, `build:tests:check`, `check:boundaries`: **모두 PASS** (런타임 308 files/841 edges, 테스트 289 + helpers 8)
- 새 반례: **Run/Completion/Review 테이블이 없는 Knowledge-only 임시 DB**에서 결과 재조회 성공; tampered records/Project/revision 거부; 미정착된 신규 Commit 거부. `no_change` Run이 Knowledge 영구 ledger 행을 생성하지 않는 점도 검증.
- 운영 DB/운영 Run 삭제: **미실행**. Mac 수정본 Native/MCP 검증: **미실행**. 일반 실행 경로의 DB open 반복 DDL 개선: W6 범위.

**판정:** W2의 이번 Knowledge 재조회·출처 보존·중복 재시도 구현은 집중 테스트 **PASS**. 기존 계획 대비 수정된 Trust 정착 계약이 W3의 작업 종료 시점에서 작동하는지, 실제 완료 뒤 Run FK 소비자 제거가 가능한지는 아직 미검증이므로 **W2 통합 수용 및 전체 Ephemeral Work 전략은 PARTIAL**로 유지한다.
