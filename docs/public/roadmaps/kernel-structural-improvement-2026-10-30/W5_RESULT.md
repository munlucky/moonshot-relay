# W5 결과 — 실패 이력과 Knowledge 승격 분리

- 기준: W4 `4142c353`, Linux 격리 SQLite/영속 Knowledge. **W5-A SOURCE PASS(확인된 결함 수정), W5-B 운영 migration 선택 보류**.

## 실제 영속 결함과 수정

`src/kernel/persistence/knowledge-lifecycle-store.ts`의 `commitKnowledgeTransaction`은 canonical identity 비교에서 `type/statement/scope`만 전달했다. 기존 `knowledge/identity.ts`가 구별하는 `verification.commandRefs`와 절차 `practiceJson` 등을 버려 동일 문장/범위의 서로 다른 검증 의무를 한 건으로 오인했다.

**수정 전 격리 재현:** `required_verification` 2개(`test:unit`, `test:integration`)를 함께 제출했으나 committed 기록 **1건**만 남았다. 이것은 단순한 로그 중복이 아니라 유효한 의무 손실이다.

**수정:** 저장된 기존 레코드와 새 제출 레코드에서 **동일한** `canonicalKnowledgeIdentity`의 모든 의미 필드(`practiceJson`, `verification`, `obligation*`)를 사용하게 단일 helper로 통일. 새 hash DB/별도 dedup 계층·마이그레이션·Fallback 없음.

**수정 후 테스트:** 두 의무 모두 보존됨, 동일 의무 재제출은 `no_change`, project revision `2` 유지, committed 2건. 집중 회귀 **34/34 PASS**(Knowledge revision/reuse/concurrency/transaction/cross-run/context/candidate). 기존 추가 원본 Knowledge 시험 **30/30 PASS**.

## 100 Run 실패 이력 및 운영 백업

`buildCrossRunEvidenceGroups`에 동일 교정 실패 100개 Run을 격리 입력으로 전달하면 `runCount=100`, `failureEvidenceRefs=100`, `status=repeated_failure`이고 후보는 `episodic_observation`이다. 검증된 해결책 없이 `known_failure_pattern`으로 승격하지 않았다. 이 검사는 기존 cross-Run 함수 입력 실험이며 계정 DB 100개 Run을 실제 실행한 것은 아니다.

W0 Online Backup 사본(`/tmp/moonshot-w0-backup-.../runtime-state-backup.sqlite`)을 **mode=ro / query_only**로 읽은 결과: `known_failure_pattern` **1,915건**, 유일 statement 텍스트 **34개**, 프로젝트·문장·scope 기준 **38개 그룹**, 중복 후보 **1,877건**, 출처 참조 필드 있는 기록 **1,915건**. 과거 생성 기록과 지금 생성 결함을 동일시하지 않는다.

W5-B 실사용 DB 정리·승인 필요성: **선택 작업으로 제외**. 현재 조회 시 `canonical_duplicate` 제거 경계와 Knowledge reuse 테스트가 존재하며, 운영 이력 삭제의 품질·복구 이득은 입증되지 않았다. 원본 Run·provenance·approval 계보 손실 위험 때문에 운영 migration은 적용하지 않는다. 추후 실제 read/query 비용 또는 지식 품질 저하가 증명될 때 사용자 소유권/승인·일관 백업·dry-run/rollback 후 재평가한다. 승인 대기를 `external_owner`로 둔갑시키지 않는다.

**판정:** W5-A 검증 범위 PASS, W5-B 운영 병합은 비필수 제외(영향: 운영 DB 물리 용량 그대로), 통합 계획은 진행 중. W6에서 Receipt 실제 중복 비용을 별도 계측한다.
