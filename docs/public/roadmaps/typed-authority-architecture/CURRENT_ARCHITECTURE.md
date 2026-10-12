# 현재 구조와 근거

기준 commit: e3281278d08476587f3e90af37737f56a290b28c. 2026-10-09 현재 checkout을 읽었다. 작업 시작 시 clean이었다. 전체 source graph는 197 files / 450 edges다. Kernel 155, Host 36, Shared 4, CLI 2다. 확장자는 mjs 195, mts 2다.

## Evidence

| Evidence Path | Observation | Confidence |
| --- | --- | --- |
| package/source-layout.json | 네 모듈과 두 예외를 선언한다. Kernel bridge→Host, Shared lock→Kernel catalog가 남아 있다. | high |
| tsconfig.json | strict이나 checkJs false이며 include는 mts와 타입 테스트다. 전체 JS의 강타입 상태가 아니다. | high |
| tools/build/runtime.mjs | 타입 진단 후 transpile과 경로 rewriting을 수행하고 freshness·orphan output을 검사한다. | high |
| src/kernel/control-plane.mjs | 약 4,883줄. proof 실행, Git closeout, context, routing과 Authority 조정을 함께 참조한다. | high |
| src/kernel/state-store.mjs | 약 6,292줄. SQLite 구현과 Work/Trust/Knowledge/Host 관련 저장, 일부 Git 관찰이 함께 있다. | high |
| src/kernel/run/work-authority.mjs | provider-free Work read model을 구성한다. 실제 Work mutation 경계와 구분해야 한다. | high |
| src/kernel/proof/trust-authority.mjs | evidence freshness와 completion 수락 관점을 제공한다. 전체 proof 실행 코드가 분리된 상태는 아니다. | high |
| src/kernel/knowledge/knowledge-authority.mjs | SQLite 권위를 가진 Knowledge lifecycle의 파생 view를 검증한다. | high |
| src/kernel/proof/proof-executor.mjs | Kernel 경로에서 child_process.spawnSync를 호출한다. Host 이동 시 Trust 정책을 보존해야 한다. | high |
| src/kernel/installer.mjs | 별도 PAYLOAD_ENTRIES를 가지며 source checkout의 생성 runtime을 복사한다. | high |
| package/kernel/manifest.json | package include 목록과 public mjs entrypoint를 선언한다. installer 목록과 완전히 같지 않다. | high |
| docs/decomplexification/kernel-write-ownership.json | 기존 쓰기 소유자와 SQLite single persistence 원칙을 기록한다. 경로는 이전 generated 위치다. | high |
| .github/workflows/ci.yml | Node 20/22 × Ubuntu/Windows/macOS matrix, npm ci/test/package/eval와 임시 home dry-run이 있다. | high |

줄 수는 위치를 찾는 관찰값이다. 크기 자체를 결함이나 완료 기준으로 사용하지 않는다. 기능별 전체 body의 독립 리뷰는 이번 계획 작성에서 수행하지 않았다. 197개 목록은 정적 import inventory이며 dynamic/spawn/manifest closure는 TASK-001에서 실행 전 확정한다.

## Owned Paths

아래는 이번 계획 작성의 문서 소유 범위다. 미래 구현 허용 범위는 IMPACT_MAP과 실제 실행 contract가 정한다.

| Path | Purpose |
| --- | --- |
| docs/public/roadmaps/typed-authority-architecture | 최종 계획과 설계 문서 |

## Read-only Paths

| Path | Purpose |
| --- | --- |
| src | 현재 실행·저장·Authority 구현 근거 |
| tools/build | 현재 source graph와 build 근거 |
| schemas | 기존 wire/state schema |
| package | 설치·package contract |
| tests | 기존 회귀와 source package 정책 |
| AGENTS.md | 실제 instruction과 anchor 확인 |
| .github/workflows/ci.yml | 지원 환경과 release gate |
| docs/decomplexification | 기존 책임·회귀 의도 |
| docs/public/roadmaps/source-runtime-separation | 선행 구조 결정 |

## Staged Paths

이 표는 planning handoff 후보 파일을 뜻한다. Git index에 stage했다는 의미가 아니다.

| Path | Purpose |
| --- | --- |
| docs/public/roadmaps/typed-authority-architecture/TASK_CONTRACT_SEED.json | 문서 digest가 묶인 advisory seed |

실제 knowledgeAnchors 선언은 없다. AGENTS의 예시를 프로젝트 agreement로 오인하지 않았다. 원격 자료는 SOURCE_NOTES에서 조회일과 함께 구분한다.
