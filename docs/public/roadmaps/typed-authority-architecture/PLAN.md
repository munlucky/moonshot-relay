# Moonshot Relay 아키텍처 정리 및 TypeScript 전환 최종 작업 계획

작성일: 2026-10-09 (Asia/Seoul)
기준 커밋: `e3281278d08476587f3e90af37737f56a290b28c`
상태: 실행 계획 확정. 구현 전. 이 문서와 seed에는 실행·검증·완료 승인 권한이 없다.

## 1. 핵심 전략

현재 하네스의 기능을 유지하면서 기능의 소유권, 상태 변경 권한, 의존 방향을 정리한다. 개발자가 변경할 위치를 쉽게 찾고, 작은 변경이 다른 영역으로 퍼지지 않는 구조를 만든다. TypeScript와 런타임 입력 검증은 이 구조를 강제하는 수단이다.

목표 구조는 **Work / Trust / Knowledge + Strong Host**다. 단일 Node 패키지를 유지한다. 세 Authority는 동등한 책임 경계이며, Work → Trust → Knowledge의 일방적 계층 관계를 만들지 않는다. Control Plane은 공개 명령을 조정한다. CLI와 composition root가 구현체를 연결한다.

현재 원본·산출물 분리를 활용한다. 원본은 `.ts`로 통일한다. 기본 산출물은 표준 TypeScript emit의 ESM `.js`다. 기존 공개 `.mjs` 명령은 생성한 호환 진입점으로 유지한다. 계정 루트에는 검증된 배포 artifact와 필요한 자산·실행 의존성만 설치한다. `.mjs` 확장자 자체를 완료 목표로 삼지 않는다.

## 2. 입력과 판단

- 사용자 목표: 현재 하네스를 사용하고 개선하기 쉬운 구조로 정리한다.
- 앞선 작업: `src/`와 생성 runtime을 분리했다. 현재 197개 원본 중 195개는 `.mjs`, 2개는 `.mts`다.
- 추가 입력: 사용자 첨부 의견. SHA-256은 [입력 및 외부 근거](SOURCE_NOTES.md)에 기록한다.
- 현재 코드 확인: [CURRENT_ARCHITECTURE.md](CURRENT_ARCHITECTURE.md).
- 첨부 의견의 채택·수정 사항: [PRD_FIT_GAP.md](PRD_FIT_GAP.md).
- 프로젝트의 실제 `knowledgeAnchors` 항목은 없다. `AGENTS.md`의 YAML은 선언 예시다. 기존 구조 결정과 `docs/decomplexification/`의 상태·소유권 문서를 참고했다. 과거 경로와 수치는 현재 코드보다 우선하지 않는다.

이번 단계에서는 계획 문서만 작성한다. 아래 작업 단위의 실행은 후속 구현 요청에 적용한다. Kernel 실행은 사용자가 해당 모드를 명시한 때 활성화하며, seed를 Host가 실제 Task Contract로 정규화해야 한다.

## 3. 범위와 보존할 기능

범위는 현재 `src/` 197개와 활성 Kernel의 실행·설치에 필요한 참조 폐쇄집합이다. `package/kernel/manifest.json`, installer의 `PAYLOAD_ENTRIES`, profile template, standalone catalog, npm bin, CI를 시작점으로 지원 스크립트와 자산 참조를 추적한다. 두 목록의 차이도 정리한다. 현재 197개만 전환하고 완료로 처리하지 않는다.

유지할 기능은 작업 계약·cursor·resume, Execution Capsule, mutation/workspace fencing, project identity, evidence freshness, review 독립성, completion 판정, Knowledge lifecycle, model routing, session, prompt/cache, Git closeout, 설치·업데이트·복구다. optional capability의 비활성화 동작도 보존한다.

활성 runtime이 호출하는 legacy support는 새 경계로 이관한다. 호출되지 않는 과거 Relay 제품·archive 코드는 이번 전환에서 동결한다. 동결 목록에는 참조가 없다는 근거를 남긴다. 기존 switcher 파일이 payload에 있다는 이유로 새 Kernel 실행을 switcher에 의존시키지 않는다.

Futures Gate 등 새로운 제품 동작, provider/model 교체, 신규 workflow engine, event bus, microservice, 다중 npm package, Knowledge 저장소 교체는 범위 밖이다. 구조 변경 중 발견한 기존 결함은 재현 근거와 별도 수정 항목으로 관리한다. 묵시적 동작 변경을 구조 이동에 섞지 않는다.

## 4. 확정할 아키텍처 계약

상세는 [TARGET_ARCHITECTURE.md](TARGET_ARCHITECTURE.md), [CONTRACTS_AND_STATE.md](CONTRACTS_AND_STATE.md), [BUILD_AND_INSTALL.md](BUILD_AND_INSTALL.md)에 정의한다.

1. Work는 계약·작업·cursor·resume·mutation의 허용 여부를 소유한다.
2. Trust는 evidence 요구, freshness, review 수락, completion 판정을 소유한다. Host가 수행한 명령의 성공만으로 완료를 인정하지 않는다.
3. Knowledge는 프로젝트 지식의 선택·검증·승격·revision을 소유한다. SQLite가 권위이며 파일 projection은 파생물이다.
4. Host는 provider/model/session/process/workspace/Git/prompt/cache와 실제 명령 실행을 소유한다. 설치도 Host 책임이다. Host는 Authority의 결정을 읽고 수행할 수 있으나 새 결정을 만들거나 덮어쓸 수 없다.
5. 계약은 한 정의에서 타입과 외부 입력 검증을 파생한다. 기존 JSON Schema는 schema-first로 유지한다. 의미 검증은 소유 Authority가 수행한다.
6. Control Plane은 명령 순서, 트랜잭션 조정, 공개 결과 조립만 맡는다. 모델 선택, SQL, 명령 실행, 개별 policy 구현을 담지 않는다.
7. 하나의 SQLite 연결·트랜잭션 경계를 유지한다. 모듈을 분리해도 DB를 여러 개 만들거나 projection을 쓰기 권위로 사용하지 않는다.

## 5. 작업 순서

각 작업은 계약 → 실제 구현 → persistence/Host 연결 → 공개 경로 → 테스트를 포함하는 세로 단위다. 아래 순서는 의존 관계다. 한 작업의 종료 기준을 충족한 뒤 다음 작업으로 간다. Host의 공통 실행 port와 transaction seam은 첫 소비 작업에서 필요한 만큼 만든다.

| Task ID | 작업 | 선행 | Owner | Verification Signal |
| --- | --- | --- | --- | --- |
| TASK-001 | 기능·쓰기·실행·설치 기준선 확정 | 없음 | Architecture | V01 |
| TASK-002 | 계약 생성·엄격한 TS·이중 경로 빌드 기반 | TASK-001 | Build | V02 |
| TASK-003 | Work 세로 전환 | TASK-002 | Work | V03 |
| TASK-004 | Trust 세로 전환 | TASK-003 | Trust | V04 |
| TASK-005 | Knowledge 세로 전환 | TASK-004 | Knowledge | V05 |
| TASK-006 | Host와 provider 경계 완성 | TASK-005 | Host | V06 |
| TASK-007 | Control Plane·상태 저장 경계 완성 | TASK-006 | Architecture | V07 |
| TASK-008 | CLI·installer·profile·payload 전환 | TASK-007 | Delivery | V08 |
| TASK-009 | 테스트·개발 도구·호환 경로 정리 | TASK-008 | Developer Experience | V09 |
| TASK-010 | 깨끗한 배포 artifact 검증과 운영 인계 | TASK-009 | Delivery | V10 |

### TASK-001 — 기준선과 소유권

현재 커밋과 작업 트리를 기록한다. 이 문서의 기준선과 다르면 영향 목록부터 갱신한다. [IMPACT_MAP.md](IMPACT_MAP.md)와 [SOURCE_INVENTORY.md](SOURCE_INVENTORY.md)를 출발점으로 각 파일의 exported symbol, public caller, read/write table, 외부 실행, 최종 소유자와 유지 기능을 기록한다. 한 파일에 두 책임이 있으면 함수별로 분할 대상을 정한다.

공개 CLI/MCP의 옵션·JSON·exit code, account-root 환경변수, Node/OS matrix, optional capability, profile 경로를 고정한다. 실제 package와 installer가 복사하는 파일 목록의 합집합을 생성하고 정적 import뿐 아니라 spawn argv, lazy import, manifest 문자열, `import.meta.url` 자산 접근을 추적한다.

종료: 미분류 활성 기능·실행 파일·상태 writer가 0개다. 원본 목록, 외부 입력 목록, runtime payload 목록, public compatibility 목록이 연결된다. 기존 테스트 실패와 환경 SKIP을 기준선으로 기록한다. 전체 회귀를 먼저 무조건 반복하지 말고 기존 근거의 커밋·내용 일치와 필요한 기준선 실행 범위를 판단한다.

### TASK-002 — 계약과 빌드 기반

Work slice에 필요한 최소 계약을 먼저 schema-first로 생성한다. 나머지 모든 계약을 선행 작성하지 않는다. `strict`, `noEmitOnError`, Node ESM, Node 타입, generated-contract drift 검사를 설정한다. 타입 검사는 `noEmit`, 실제 emit은 별도 build config로 수행한다. CI는 두 경로의 실패를 모두 차단한다.

임시 디렉터리에 `lib/**/*.js`를 생성하고 runtime asset·`.mjs` 진입점을 조립한다. 검증 성공 뒤 배포 artifact를 교체한다. 현재 `.mjs` 모듈은 전환 기간에만 기존 graph로 유지한다. 전환한 slice와 미전환 slice의 import/export를 정확한 adapter로 연결한다. legacy 동적 객체가 새 계약으로 들어오는 곳은 `unknown` 검증을 통과해야 한다.

종료: 작은 실제 Work 계약에서 compile-time 실패, runtime-invalid 입력 실패, `.mjs` → 새 `.js` 호출, 배포 artifact 독립 실행이 입증된다. 이전 산출물을 실패한 새 빌드의 성공 근거로 사용할 수 없다.

### TASK-003 — Work 전환

`task/`, `run/`에서 작업 계약·step ledger·cursor·resume·mutation permission·attempt provenance를 Work로 정리한다. 물리 Git/worktree 관찰은 Host port로 옮기되 Work의 scope·CAS·revision 허용 판단은 유지한다. Work SQL 연산은 동일 DB transaction을 소비하는 전용 store로 나눈다.

공개 `next/report`를 통과하는 Work 흐름을 새 서비스에 연결한다. 완료·blocked·active 내부 타입을 판별 union으로 정의하되 기존 persisted/wire 필드와 값은 versioned codec으로 보존한다. resume 시 새 run을 임의 생성하거나 cursor를 초기화하지 않는다.

종료: 중복 report, 재시작, lease 만료, 동시 writer, worktree mismatch, mutation 증가, replan 뒤 이전 통과 이력이 보존되는 실제 회귀를 통과한다. 이 작업이 끝난 Work 경로는 legacy Work 구현을 호출하지 않는다.

### TASK-004 — Trust 전환

obligation·evidence identity·freshness·review·completion을 Trust로 정리한다. child process, timeout, process tree, 네트워크 실행 수단은 Host execution으로 옮긴다. 허용 명령·scope·required review·증거 수락 정책은 Trust에 남긴다. 기존 executor 표기, receipt digest와 서명/인증 의미를 이동 때문에 바꾸지 않는다.

완료 상태와 Git commit admission의 mutation provenance가 서로 다른 revision을 참조하는 재현 fixture를 추가한다. 이번 대화에서 관찰한 `RUN_NOT_FINALIZED`는 복구된 사실로 간주하지 않는다. 완료·revision·provenance가 기록되는 트랜잭션 경로를 조사하고 정상 수락과 stale 거부를 모두 검증한다. 근거를 조작하거나 일반 Git 실행을 Kernel 승인 성공으로 대체하지 않는다.

종료: stale/replayed receipt, 다른 run/workspace/source의 evidence, review 독립성 위반을 거부한다. 같은 최신 근거는 completion과 closeout에서 일관되게 해석한다. 동작 결함을 수정해야 하면 원인과 계약 변경을 별도 커밋 단위로 명시한다.

### TASK-005 — Knowledge 전환

retrieve/select/use/capture/normalize/verify/review/commit/supersede/revision을 Knowledge에 연결한다. Code Index와 projection은 재생성 가능한 보조 자료다. session provider transcript 수집은 Host에 두고 redacted typed input만 Knowledge에 전달한다.

현재 SQLite 쓰기 경로를 유지하면서 Knowledge store를 같은 transaction/session에 연결한다. 프로젝트 namespace·migration recovery·승격 승인·revision CAS를 보존한다. 편의를 위한 새 자동승격 경로는 만들지 않는다.

종료: 재시작·동시 commit·supersession·namespace isolation이 유지된다. projection을 삭제하거나 변조해도 canonical SQLite의 결정이 바뀌지 않는다. 새로운 ranking 정책은 Knowledge 내부와 관련 테스트만 수정해서 적용할 수 있다.

### TASK-006 — Host 전환

provider adapter, 모델 정책, effort, native session, workspace/worktree, process, Git, prompt/cache를 각 Host 기능으로 정리한다. 이전 Work·Trust 단계에서 만든 실행 port 구현을 여기서 통합한다. Host orchestration은 composition root에서 주입한 좁은 Kernel API를 사용한다. provider leaf는 Kernel 내부와 SQLite를 참조하지 않는다.

외부 입력은 한 진입점에서 구조 검증을 수행한다. 출력이 검증됐다는 이유로 evidence의 소유권·freshness 검사를 생략하지 않는다. 모델명과 provider 분기, raw transcript, cache state가 Work/Trust/Knowledge domain으로 새어 들어가지 않는지 검사한다.

종료: provider 교체 fixture와 실제 사용 가능한 native smoke를 실행한다. 설치되지 않았거나 인증되지 않은 surface는 SKIP/BLOCKED 사유를 기록한다. 모의 adapter 통과를 실제 provider 성공으로 기재하지 않는다.

### TASK-007 — 조정과 persistence 경계 완성

Control Plane의 기존 공개 API를 유지하며 새 Work/Trust/Knowledge 서비스와 transaction runner를 연결한다. 앞선 단계마다 옮긴 책임을 최종 점검한다. orchestration을 거대한 helper 파일로 옮겨 크기만 줄이는 방식을 허용하지 않는다.

현재 `state-store.mjs`는 connection/schema/transaction 기술 부분과 소유자별 SQL 연산을 분리한다. 같은 논리 report에 속한 cursor·evidence·completion 변경의 원자성과 rollback을 보존한다. 장시간 provider/process 실행 중 SQLite transaction을 열어 두지 않는다. 실행 intent를 기록하고 실행한 뒤 revision/CAS를 다시 확인해 결과를 반영한다.

종료: Control Plane에서 provider 구현, SQL, `child_process`, Git 실행을 직접 참조하는 경로가 0개다. cross-authority 원자성·crash recovery·idempotency가 유지된다. 예외 두 개는 명시적 composition/Host 책임으로 제거한다.

### TASK-008 — 배포와 설치 전환

CLI는 parse → validate → composition/service 호출 → 결과/exit code 출력으로 제한한다. installer/profile/package manifest를 한 배포 파일 목록으로 연결한다. 현재 CLI가 직접 실행됐는지 확인하는 방식도 wrapper 호출에서 정상 동작하도록 `main(argv, deps)` 계약으로 정리한다.

공개 `.mjs` 경로, profile/skill에 기재된 명령, standalone lock과 optional support를 점검한다. `import.meta.url` 기반 상대 경로를 공통 runtime asset locator로 옮겨 개발·임시 설치·실계정 설치에서 같은 파일을 찾게 한다. 설치는 source compiler를 호출하지 않는다.

종료: npm archive와 직접 installer 경로 모두 source·TypeScript·개발 도구 없이 실행된다. `better-sqlite3` 등 실행 의존성의 Node ABI/OS 배치를 실제로 검증한다. managed artifact의 파일 목록과 hash가 설치 결과와 일치한다. 로그·DB·설정은 비교와 교체 대상에서 제외한다.

### TASK-009 — 개발 경험과 이행 경로 제거

활성 하네스 원본·지원 코드·테스트·개발 도구를 `.ts`로 마무리한다. 테스트는 소스 동작 검사와 배포 artifact 검사로 나눠 둘 다 유지한다. Node 기본 runner를 유지할 수 있도록 테스트를 별도 디렉터리로 컴파일하는 방식을 우선한다. 개발 도구 실행기는 개발 의존성에만 둔다.

새 개발자는 한 문서에서 bootstrap, typecheck, build, focused test, 임시 설치, 디버깅을 수행할 수 있어야 한다. 생성 sourcemap은 개발/진단 artifact로 제공하고 runtime에는 source text를 넣지 않는다. 기존 capability catalog·문서·테스트의 경로를 갱신하되 과거 evidence의 경로는 역사 기록으로 보존한다.

종료: 유지보수 대상 원본에서 `.mjs/.mts/.js` 잔여, 무분류 `any`, `@ts-ignore`, `@ts-nocheck`, wildcard ambient declaration은 0개다. 외부 SDK의 불가피한 느슨한 타입은 Host 내부의 최소 adapter에서 `unknown`으로 봉합하고 사유·테스트를 기록한다. 공개 `.mjs` shim은 생성물로 남는다. 내부 이행 shim은 caller가 0개임을 증명한 뒤 제거한다.

### TASK-010 — 최종 검증과 인계

깨끗한 checkout과 고정 dependency lock으로 typecheck → build → test → pack → 임시 계정 루트 설치 → native smoke를 실행한다. 세부 절차와 판정은 [VERIFICATION.md](VERIFICATION.md)를 따른다. 개발 PC의 기존 생성물이나 실제 계정 state가 검증에 섞이면 해당 검증을 무효로 한다.

Codex 모델 정책 변경, Knowledge ranking 변경, Completion policy 변경, Resume policy 변경의 네 가지 시험 변경을 임시 checkout에서 수행한다. 핵심 구현 변경이 각각 지정 소유자 내부에 한정되는지 확인한다. 공유 계약을 의도적으로 바꾸는 경우에만 소비자 변경을 허용한다. 시험 변경은 제품 변경에 포함하지 않는다.

종료: 모든 REQ의 V 신호가 현재 artifact에 연결된다. 필수 환경 미검증은 완료로 치환하지 않는다. 실제 계정 적용이 후속 요청 범위에 있으면 같은 artifact의 hash, 실행 중 process 교체, rollback을 검증한다. 없으면 결과를 `배포 artifact 검증 완료 / 실계정 미적용`으로 구분한다.

## 6. 완료 판단

- 활성 production 기능·상태 writer·외부 입력·설치 파일의 소유자가 모두 지정됐다.
- 새 기능의 위치를 Work / Trust / Knowledge / Host / Delivery 중에서 선택할 수 있다.
- 관련 slice의 원본과 테스트는 엄격한 TypeScript 검사 범위에 있다.
- Kernel ↔ provider implementation 직접 의존, 하위 계층의 역방향 import가 없다. type-only import도 검사한다.
- 실제 유지보수 시험 네 개가 소유권 경계를 지킨다.
- public 명령·resume·evidence·completion·Knowledge lifecycle·설치/복구 회귀가 통과한다.
- 검증한 runtime artifact가 그대로 설치된다. 개발 소스·compiler·state는 payload에 없다.

파일 전환율, 파일 수, 줄 수 감소는 보조 지표다. 위 조건을 대신하지 않는다. 기존 완료 로그는 기준선 정보이며 새 구현의 통과 근거가 아니다.

## 7. 실패·복구·변경 관리

각 task는 통과한 slice 단위로 커밋할 수 있어야 한다. 한국어 메시지에 변경 이유, 보존 계약, 검증과 제한을 기록한다. 커밋·푸시·실계정 적용은 해당 실행 요청 범위에 따른다.

전환 중 실패하면 해당 slice의 source/build/profile 변경을 마지막 통과 지점으로 되돌린다. DB 데이터를 rollback 수단으로 삭제하지 않는다. 현재 계획의 기본은 DB schema와 wire version 보존이다. 불가피한 DB 변경은 별도 versioned migration, upgrade/downgrade 정책과 backup/recovery 검증이 준비되기 전에는 적용하지 않는다.

계획의 중간 산출물은 혼합 runtime일 수 있다. 각 공개 경로에는 canonical 구현이 하나만 있어야 한다. 새·옛 Authority가 같은 state를 각각 결정하는 dual-write는 허용하지 않는다. 이행 registry의 예외는 단계마다 감소해야 한다.

## 8. 읽는 순서와 인계

1. 이 계획과 [목표 구조](TARGET_ARCHITECTURE.md)를 읽는다.
2. [계약·상태](CONTRACTS_AND_STATE.md), [빌드·설치](BUILD_AND_INSTALL.md), [검증](VERIFICATION.md)을 확인한다.
3. [현재 구조](CURRENT_ARCHITECTURE.md), [영향 지도](IMPACT_MAP.md), [원본 목록](SOURCE_INVENTORY.md)으로 대상 코드를 찾는다.
4. [요구사항](REQUIREMENT_INVENTORY.md)과 [추적표](TRACEABILITY_MATRIX.md)로 누락을 확인한다.
5. [ADR](ADR/ADR-0001-ownership.md)과 [검토 기록](ARCHITECTURE_REVIEW.md)을 읽고 `TASK-001`부터 수행한다.

`TASK_CONTRACT_SEED.json`은 이 패키지의 digest와 목적을 담는 advisory 입력이다. 실행 시 최신 user objective, checkout, 허용 경로, 실제 증거 계획을 다시 연결한다. 문서나 seed를 Kernel 완료 receipt로 제출하지 않는다.
