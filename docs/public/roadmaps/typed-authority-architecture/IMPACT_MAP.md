# 소스 이동과 실행 영향 지도

Current Evidence는 현행 파일·graph다. Target은 이후 구현 위치다. 모든 파일 이동은 export, asset path, persistence, 실제 caller를 대조해야 한다. 아래 경계가 하나의 파일에서 섞여 있으면 함수별로 나눈다.

| 현재 경계 | 목표 책임 | Task | 주의할 Compatibility / Migration |
| --- | --- | --- | --- |
| src/kernel/task + run/work-* + cursor/ledger | kernel/work, contracts/work | TASK-003 | public run/step id와 revision 보존 |
| run/attempt-provenance, mutation-guard, binding | Work 판단 + Host 관찰 + typed persistence | TASK-003 | CAS/lease/physical process 권한 분리 |
| run/obligation-compiler, completion-*, execution-capsule | Work capsule + Trust obligations/completion | TASK-003 / TASK-004 | 수락된 capsule/evidence 의미 보존 |
| proof/trust-authority, evidence-reuse, review-* | kernel/trust | TASK-004 | digest, enforcement, freshness의 의미 불변 |
| proof/proof-executor, process-tree, network-policy | host/execution; 허용 정책은 Trust | TASK-004 / TASK-006 | same executor origin receipt와 timeout 정리 |
| kernel/knowledge, knowledge-ingestion | kernel/knowledge; 외부 수집은 Host | TASK-005 | SQLite 권위·승인·namespace 유지 |
| kernel/codebase | host/codebase + Knowledge read interface | TASK-005 / TASK-006 | index는 파생물; Git 실행은 Host |
| kernel/run/model-*, host-session, session-holder | contracts/host + host/providers/sessions | TASK-006 | 논리 binding 검사는 Work에 남김 |
| host/kernel/adapters, prompts, dispatcher | host/providers, prompt, execution | TASK-006 | provider별 native semantics 보존 |
| kernel/git + shared/git-safe | host/git; Work scope와 Trust admission은 contracts | TASK-006 | 일반 Git 성공과 Kernel admission 구분 |
| kernel/state-store, sqlite-adapter, persistence | persistence connection/tx + owner별 SQL | TASK-003~TASK-007 | DB 수·transaction·journal authority 유지 |
| kernel/control-plane | kernel/control-plane + owner 서비스 | TASK-007 | 중간 report commit 또는 이중 판단 금지 |
| kernel/bridge + cli | composition + cli | TASK-007 / TASK-008 | MCP/public result와 main 실행 보존 |
| kernel/standalone | application + owner public API + cli | TASK-008 | prework는 authority를 얻지 않음 |
| kernel/installer, profile-*, package-build | host/install | TASK-008 | profile 생성, native deps, package 목록 통합 |
| shared/skills-lock → standalone/catalog | host/install/catalog tooling | TASK-008 | 하위 shared의 역방향 의존 제거 |
| bin/moonshot-relay + scripts/install-account-root-harness | Kernel install에 도달하는 support를 TS로 이관 | TASK-008 / TASK-009 | Relay public command를 손상시키지 않고 active closure 분리 |
| scripts/switcher 및 기타 support | 실제 active caller만 TS Host/Delivery로 이관 | TASK-001 / TASK-009 | 기존 파일 존재만으로 새 switcher 의존을 만들지 않음 |
| tools/build + source-layout + package.json/lock | 표준 TS emit + artifact assembly | TASK-002 / TASK-009 | 실패한 빌드가 이전 artifact를 재사용하지 않음 |
| tests, schemas, catalog, docs, CI | 계약/회귀/지원 matrix/기여자 문서 갱신 | TASK-001~TASK-010 | 과거 evidence 경로를 현재 경로로 덮어쓰지 않음 |

## Rollback

slice별 통과 커밋과 artifact를 유지한다. runtime 업데이트는 관리 파일만 교체하고 DB·native provider home은 보존한다. 실제 운영 data migration은 별도 승인된 설계와 호환성 proof가 없는 한 수행하지 않는다.

## 미래 구현 편집 범위

기본 대상은 src, tools, tests, schemas, package, catalog, 필요한 bin/scripts support, package.json/lock, tsconfig, CI, 관련 public docs다. runtime state, credentials, sessions, 기존 unrelated worktree는 편집 대상이 아니다. 정확한 allowedPaths는 TASK-001 closure 결과로 실행 contract에 묶는다. 이 표가 실행 범위를 무제한 허용하지 않는다.
