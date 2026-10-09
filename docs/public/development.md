# Kernel 개발과 런타임 빌드

개발 코드는 `src/`에서 수정한다. 설치되는 코드는 빌드한 `.mjs` 파일이다.
기존 실행 명령, Kernel 상태 경로, Host 실행 권한은 유지한다.

## 새 checkout

Node 20 이상과 npm을 준비한 뒤 저장소에서 실행한다.

```sh
npm ci
npm run build:check
npm run dev:kernel -- --help
```

`npm ci`의 prepare 단계가 런타임을 생성한다.
`--ignore-scripts`로 의존성을 설치했다면 `npm run build`를 직접 실행한다.
빌드 전에는 생성된 CLI 파일이 없을 수 있다.

## 원본과 산출물

| 수정할 원본 | 생성되는 설치 경로 | 책임 |
| --- | --- | --- |
| src/kernel/ | scripts/kernel/ | Work, Trust, Knowledge, 상태 저장, standalone 기능 |
| src/host/kernel/ | scripts/host/kernel/ | provider 실행, session, worktree, prompt |
| src/shared/ | scripts/lib/의 대응 파일 | 공통 runtime 유틸리티 |
| src/cli/ | bin/의 대응 파일 | 공개 CLI 진입점 |
| tools/build/ | 설치 런타임에 포함하지 않음 | 빌드, 타입 검사, 경계 검사 |
| skills/, kernel/, schemas/, package/ | 기존 package contract가 지정한 경로 | 정책, schema, 배포 자산 |

`package/source-layout.json`이 소스와 출력의 매핑 및 모듈 의존성을 소유한다.
매핑에 속하지 않는 기존 scripts/, bin/, tools/ 파일은 기존 support source다.
scripts/kernel/와 scripts/host/kernel/는 빌드 전용 경로다.
해당 경로에 파일을 직접 추가하거나 수정하지 않는다.

빌드는 TypeScript Compiler API 6.0.3에 고정한다.
7.x의 compiler API는 다르므로 의존성 버전만 올리지 않는다.
새 버전을 적용하려면 AST 변환과 출력의 회귀 검증을 함께 수행한다.

기존 ESM JavaScript는 유지한다. execution-class.mts와
optional-capabilities.mts에는 strict TypeScript를 적용했다.
JavaScript 전체가 타입 검사되는 것은 아니다.
새 계약 또는 수정하는 계약부터 .mts와 타입 테스트를 추가한다.
타입 검사를 끄거나 광범위한 any 선언으로 파일 확장자만 바꾸지 않는다.

## 개발 순서

1. src/ 원본과 필요한 정책·테스트를 수정한다.
2. `npm run build`를 실행한다. 빌드는 타입 오류, 누락 import, 경계 위반을 거부한다.
3. 관련 테스트 또는 `npm run test:source-runtime`을 실행한다.
4. 제출 전에 `npm run lint:kernel`과 `npm test`를 실행한다.

```sh
npm run build
npm run typecheck
npm run check:boundaries
npm run build:check
npm run test:source-runtime
```

dev:kernel과 dev:standalone은 빌드 후 기존 CLI를 실행한다.
소스 파일을 직접 실행하는 대신 이 명령을 사용한다.
import.meta.url 기반 자산 경로는 설치 경로를 기준으로 한다.

빌드 결과는 Git에서 제외한다. dist/runtime-build.json은 소스·도구·출력 hash를
기록하며 시간과 절대 경로를 넣지 않는다. 같은 입력은 같은 출력과 receipt를 만든다.
새 소스와 삭제한 소스도 검사한다. 사라진 소스의 이전 출력은 빌드가 제거한다.
공유 출력 폴더에서는 매핑에 속한 파일만 관리한다.

## 패키징과 설치

기존 설치 진입점을 사용한다. checkout에서 먼저 npm ci 또는 npm run build를 실행한다.
Kernel installer와 package materializer는 소스·출력·빌드 도구 hash가 바뀌면
runtime_build_stale로 중단한다. 빌드한 뒤 다시 실행한다.

npm pack의 prepack도 빌드·타입·freshness 검사를 실행한다.
소스와 컴파일러는 배포 payload에 넣지 않는다.
배포 archive의 작은 prepare 진입점은 src/가 없으면 아무 작업도 하지 않는다.
설치된 .mjs는 TypeScript 실행기 없이 Node에서 실행한다.

standalone 진입점의 출력이 바뀌면 기존
scripts/kernel/standalone/catalog.mjs의 writeStandaloneLock으로
package/kernel/standalone-skills.lock.json을 갱신한다.
일반 빌드는 이 lock을 자동 승인하거나 다시 쓰지 않는다.

## 후속 구조 개선

[구조 결정과 Futures 적용 지도](roadmaps/source-runtime-separation/ARCHITECTURE.md)를 따른다.
Futures Gate 상태, reviewer 추가, 계측과 데이터 migration은 이번 구조 개편에 포함하지 않는다.
기존 대형 control-plane을 더 작은 서비스로 분리하는 작업도 별도 동작 보존 계약으로 수행한다.
