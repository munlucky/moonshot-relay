# Kernel 개발과 런타임 빌드

개발 원본은 TypeScript다. `src/`에서 런타임을 수정하고 `tests/*.ts`에서 Kernel 테스트를 수정한다. `package/source-layout.json`이 원본과 설치 출력의 매핑 및 허용 의존성을 정한다. 생성 파일을 직접 수정하지 않는다.

## 새 checkout

Node 20 이상과 npm을 준비한 뒤 저장소에서 실행한다.

```sh
npm ci
npm run typecheck
npm run build:check
npm run dev:kernel -- --help
```

`npm ci`의 prepare 단계는 고정된 compiler CLI로 `dist/tools`에 빌드 도구를 먼저 생성한다. 그 도구가 런타임과 테스트를 생성한다. 기존 생성 도구가 없어도 시작할 수 있다. `--ignore-scripts`를 사용한 clean 원본에서는 `npm run prepare`를 직접 실행한다.

## 원본과 출력

| 수정할 원본 | 생성 출력 | 책임 |
| --- | --- | --- |
| src/contracts/ | scripts/contracts/*.js | 검증된 wire 계약과 owner DTO |
| src/kernel/work/ 및 src/kernel/run/ | scripts/kernel/ 대응 파일 | Work 진행, resume, owner binding |
| src/kernel/trust/ 및 src/kernel/proof/ | scripts/kernel/ 대응 파일 | Trust 증거와 completion 정책 |
| src/kernel/knowledge/ | scripts/kernel/knowledge/ | Knowledge lifecycle과 검색 |
| src/kernel/persistence/ 및 state-store.ts | scripts/kernel/ 대응 파일 | 한 SQLite DB와 transaction, owner store |
| src/host/kernel/ | scripts/host/kernel/ | provider, session, 물리 실행, 설치 |
| src/application/ | scripts/application/ 및 standalone 공개 파일 | CLI 및 독립 명령 조립 |
| src/shared/ | scripts/lib/ 대응 파일 | 공통 runtime 유틸리티 |
| src/cli/ | bin/*.mjs | 공개 CLI 진입점 |
| tools/build/*.ts | tools/build/*.mjs | compiler bootstrap, emit, 경계 검사 |
| tests/*.ts 및 tests/helpers/*.ts | dist/tests/*.mjs 및 helper 출력 | Node 기본 runner용 테스트 |

일반 `.ts` 런타임 출력은 `.js`다. 공개 CLI와 호환 경로에 지정한 출력은 `.mjs`다. 테스트의 공개 `.mjs` 파일은 생성 진입점이며, 테스트 구현은 `dist/tests/`에 있다. 빌드 도구 출력과 테스트 출력은 설치 런타임 원본이 아니다.

`tsconfig.json`은 원본, 테스트, 빌드 도구를 strict 검사한다. `allowJs`는 false다. `tsconfig.build.json`은 production 원본에 `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, 경로 대소문자 검사를 추가한다. 빌드는 두 설정의 진단을 확인한 후 출력한다. 오류가 있으면 이전 산출물로 성공을 보고하지 않는다.

외부 SDK와 JSON 입력은 `unknown`에서 검사한다. 내부 계약을 `any`, 검사 해제 주석, wildcard 선언으로 우회하지 않는다. SQLite SDK의 구조 차이는 작은 persistence adapter에 한정한다.

## 변경과 검증

직렬화 계약은 `schemas/kernel.*.schema.json`과 `catalog/kernel-contracts.json`에 정의한다. Schema를 변경한 뒤 `npm run build:contracts`로 타입과 validator 정의를 생성한다. 일반 build와 prepare는 생성 파일을 자동 승인하지 않으며 drift가 있으면 실패한다. 타입 생성기는 개발 의존성이다. Ajv와 formats는 설치 runtime의 실행 의존성이다.

1. 해당 owner의 원본과 관련 테스트를 수정한다.
2. 타입, 경계, 출력 검사를 실행한다.
3. 관련 테스트를 실행한다.
4. 전체 제출에서는 Kernel이 요구한 검증을 실행한다.

```sh
npm run typecheck
npm run build
npm run check:boundaries
npm run build:check
npm run build:tests
npm run build:tests:check
node --test tests/kernel-report-replay.test.mjs
npm run test:source-runtime
```

`test:source-runtime`은 build 실패 보존, source 없는 설치 실행, 네 가지 owner 변경 시험을 확인한다. Codex 정책은 Host, 검색 정책은 Knowledge, completion 정책은 Trust, resume 정책은 Work에서 변경한다. 시험 변경은 임시 checkout에서 수행하고 제품 원본에 남기지 않는다.

`npm run lint:kernel`, `npm run test:kernel`, `npm test`, `npm run test:package`는 서로 다른 검증 범위를 갖는다. 과거 Relay 호환 테스트는 기능 보존을 검사한다. 해당 테스트가 현재 Kernel authority를 대신하지 않는다.

## Prompt 감사 유지보수

Kernel prompt 감사의 canonical 기록은 `artifacts/kernel-prompt-audit/`에 둔다. 생성된 `scripts/`가 아니라 `src/`, `skills/`, `package/profile-templates/`의 원본 owner를 기록한다. 삭제 후보는 중복이 확인되고 남는 authority와 C01 rubric/eval 연결이 있을 때만 제거한다. C01 baseline은 비교 기준으로 고정하며 C09/C10 live 평가와 C11 gate 전에는 결과에 맞춰 갱신하지 않는다.

다음 변화가 있으면 prompt 감사를 다시 수행한다: 기본 또는 major model family 변경, provider 공식 prompting guidance 변경, tool/provider message 구조 변경, stable prompt byte/token budget 변화, 불필요 tool/subagent 호출률 변화, completion/acceptance rate 변화. 감사 목적만으로 새 workflow stage나 always-on agent를 만들지 않는다. scope·security·compatibility·evidence·review·completion authority는 prompt 길이만을 이유로 제거하지 않는다.

## 패키징과 임시 설치

```sh
npm pack
node bin/moon-relay-kernel.mjs install --help
node bin/moonshot-relay.mjs install --dry-run --runtime codex --json
```

실제 시험 설치는 별도로 만든 임시 target-root와 provider home을 지정한다. 실제 사용자 state와 섞지 않는다. 공개 설치 CLI는 공식 Kernel installer, runtime bootstrap, profile installer를 호출한다. 경로의 물리 identity 검사는 Host가 소유한다.

`npm pack`의 prepack은 빌드, 타입, freshness를 검사한다. 설치 payload에는 개발 원본, compiler, 테스트, 로그, DB, credentials를 넣지 않는다. 배포 archive의 prepare 진입점은 `src/`가 없으면 빌드하지 않는다. 설치 출력은 TypeScript 실행기 없이 Node에서 실행한다.

installer는 원본과 출력 hash가 다르면 `runtime_build_stale`로 중단한다. standalone 출력이 바뀌면 `scripts/kernel/standalone/catalog.js`의 `writeStandaloneLock`으로 lock을 갱신한다. 일반 빌드는 이 lock을 자동 승인하지 않는다.

## 디버깅과 기존 자산

`npm run dev:kernel -- --help`와 `npm run dev:standalone -- --help`는 먼저 빌드한다. sourcemap은 `dist/debug/`에 생성된다. 설치 runtime에는 source text를 넣지 않는다. `dist/runtime-build.json`은 시간과 절대 경로 없이 원본·도구·출력 hash를 기록한다.

[현재 원본 폐쇄집합](roadmaps/typed-authority-architecture/CURRENT_SOURCE_CLOSURE.md)을 기준으로 변경 위치를 확인한다. 과거 계획의 파일 경로는 역사 기록으로 유지한다. runtime state와 provider home은 원본 및 package payload 밖에 둔다.
