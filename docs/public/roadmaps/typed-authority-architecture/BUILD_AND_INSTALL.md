# 빌드와 계정 루트 설치 계약

## 최종 출력 결정

TypeScript 기본 emit을 사용한다. `.ts` 원본은 `.js`로 출력하고 가까운 `package.json`의 `type: module`로 ESM을 선언한다. TypeScript의 `.mts → .mjs` 규칙은 [공식 문서](https://www.typescriptlang.org/docs/handbook/modules/reference)에 따른다. 전체 `.mjs` 출력을 위해 새 bundler를 도입하지 않는다.

```text
src/**/*.ts + canonical schemas + runtime assets
    │ typecheck / contract generation / boundary check
    ▼
temporary build directory
    │ tsc emit + asset/shim materialization + validate
    ▼
dist/runtime/
  package.json              type: module, runtime dependency contract
  bin/*.mjs                 생성한 기존 public CLI 진입점
  lib/**/*.js               실제 구현
  schemas/ kernel/ skills/ catalog/ package/ ...
  runtime-manifest.json     파일 목록과 hash, source/build identity
    │ 동일 managed artifact를 검증 후 설치
    ▼
account-root managed runtime payload
```

`dist/runtime`는 배포용 조립 디렉터리다. 테스트 출력은 `dist/tests`, 개발 도구 출력은 별도 디렉터리에 둔다. 설정·로그·SQLite·provider home은 payload 밖의 현재 위치를 유지한다. 실제 installer의 버전별 release 경로는 현행 계약을 조사해 그대로 사용한다. 이 문서가 새 account-root 경로를 임의 지정하지 않는다.

## TypeScript 설정

- production: strict, noEmitOnError, NodeNext module/resolution, 명시한 ES target, verbatimModuleSyntax, forceConsistentCasingInFileNames.
- internal import는 실행될 `.js` specifier를 사용한다. TypeScript의 extension substitution으로 `.ts`를 해석한다.
- 개발 compiler는 현행 6.0.3을 출발점으로 고정한다. 최신 major 업그레이드는 별도 결정이다.
- Node 타입과 native dependency 타입을 명시적으로 관리한다. production lib는 최종 `allowJs: false`이며 모든 활성 원본이 include에 들어가야 한다.
- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`는 각 slice를 닫을 때 적용한다. 최종 production config에서는 활성화한다. 기존 wire default 의미를 먼저 테스트한다.
- `skipLibCheck`는 외부 declaration 검사 선택일 뿐 자체 코드 면제가 아니다. 내부 generated 계약은 검사한다.

## 이행 중 동작

개발 도구 자체를 TS로 전환할 때 bootstrap 순환을 만들지 않는다. checkout에서는 `npm ci`로 고정 compiler를 설치하고, compiler CLI가 먼저 tools project를 emit한 뒤 생성한 build 도구를 실행한다. compiler가 없는 배포 package에는 source용 prepare/prepack을 넣지 않는다. source checkout의 자동 prepare 유지 여부와 새 개발 명령을 TASK-002에서 함께 변경·문서화한다. 깨끗한 checkout에서 기존 생성 도구 없이 bootstrap되는 것이 합격 조건이다.

현재 source-layout의 `.mjs/.mts` graph는 전환이 끝나기 전까지 동작한다. 새 `.ts` slice는 별도 strict project로 emit한다. 전환 registry가 old path → new implementation → compatibility consumer를 소유한다. 동일 기능의 canonical writer는 매 시점 하나다.

기존 모듈의 public export·default export·CLI 부작용을 inventory에 기록한다. module shim은 명시한 export만 연결한다. CLI shim은 `main(argv)`를 직접 호출한다. 단순 import만으로 direct-execution guard가 실행된다고 가정하지 않는다.

기존 `.mjs` 경로 보존은 두 종류로 나눈다. 사용자·profile·공개 tool 호출 계약인 진입점은 생성 shim으로 계속 유지한다. 내부 import 이동을 위한 임시 shim은 모든 caller가 바뀌고 fixture/manifest/asset 검사가 통과한 뒤 제거한다. 동적 caller를 확인하지 않고 파일이 오래됐다는 이유로 삭제하지 않는다.

## 단일 payload 목록

현재 package manifest, installer `PAYLOAD_ENTRIES`, npm files, standalone lock은 서로 다른 목록을 가진다. TASK-001에서 실제 합집합과 차이를 산출한다. TASK-008에서 runtime payload manifest가 설치 파일의 단일 목록을 소유하도록 연결한다. npm archive에는 installer bootstrap이 필요할 수 있으므로 archive 전체와 runtime payload를 동일하다고 간주하지 않는다.

installer는 payload를 다시 transpile하거나 source에서 재생성하지 않는다. payload의 파일·hash·실행 의존성을 검증하고 복사한다. 설치 과정이 생성하는 machine-specific profile은 입력 template hash와 렌더링 결과를 별도 검증한다. native `better-sqlite3`는 실행 의존성으로 관리하고 compiler와 구분한다. Node ABI와 플랫폼에 맞는 배치·해석 경로를 기존 runtime resolver와 함께 검증한다.

공통 asset locator는 설치된 manifest 기준으로 schema, skills, policy, native runtime을 찾는다. 개발 checkout의 절대 경로가 산출물에 남지 않아야 한다. Windows 공백·한글 경로, Linux/macOS 파일명 대소문자와 executable bit를 검사한다. debug sourcemap은 별도 진단 artifact로 남길 수 있으며 runtime에 `sourcesContent`와 개발 소스를 포함하지 않는다.

## freshness, 실패, 원자적 교체

source·schema·lock·도구·template 입력을 digest에 포함한다. timestamp와 절대 경로는 content identity에서 제외한다. 동일 입력의 managed runtime file bytes와 manifest digest가 일치해야 한다. tar timestamp까지 bit-identical을 요구하는 것과 구분한다.

typecheck 또는 emit 실패 시 배포 포인터를 갱신하지 않는다. 오래된 dist를 새 빌드 결과로 설치하지 않는다. 새 파일 누락, 예상하지 않은 출력, 변조, 삭제 소스의 잔여 출력을 검출한다. 현재 stale-output/symlink containment 보호를 보존한다.

업데이트는 현재 설치 transaction/backup 경로를 우선 사용한다. 실행 중 runtime은 이전 generation에서 작업을 끝내거나 명시적 안전 종료 후 전환한다. 새 파일과 옛 파일을 한 실행에서 섞지 않는다. 상태 데이터와 provider 인증은 교체 대상에 넣지 않는다. rollback은 이전 artifact와 호환 state schema를 사용한다.

## 합격 근거

source가 없는 임시 계정 루트에서 공개 `.mjs` 진입점이 새 `.js` 구현을 실행해야 한다. developer `node_modules`나 `NODE_PATH` 우회가 없어야 한다. 임시 루트에는 필요한 runtime dependency만 있어야 한다. npm archive 설치와 직접 runtime installer 모두 검사한다.

managed runtime 파일은 artifact와 byte hash가 같아야 한다. timestamp·local profile rendering·state·logs는 별도 계약으로 검증한다. 설치 후 `help`만 확인하지 않는다. 임시 project의 next/report/resume과 SQLite persistence를 실행한다.
