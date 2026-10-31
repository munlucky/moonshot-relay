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
