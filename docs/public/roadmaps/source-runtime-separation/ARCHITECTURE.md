# 개발 소스와 설치 런타임 분리

상태: 구조 결정. 구현과 검증은 Kernel Step Ledger에서 별도로 추적한다.
기준일: 2026-10-08. 기준 커밋: `40488a09773b6f722fc4ce4e13b6f2f1aa40969f`.

## 문제와 범위

현재 `scripts/kernel/` 155개 파일(35,023줄)과
`scripts/host/kernel/` 36개 파일(8,553줄)이 개발 원본과 설치 실행 코드 역할을 함께 한다.
`package/kernel/manifest.json`과 installer는 이 경로를 직접 복사한다.
기존 테스트는 이 경로의 모듈과 일부 소스 문자열을 검사한다.
`import.meta.url`을 기준으로 자산 경로를 계산하는 코드도 있다.
따라서 이름만 바꾸거나 전체를 하나의 bundle로 합치면 설치 및 회귀 검증의 위험이 크다.

이번 범위는 현재 Kernel/Host/standalone 런타임, 공통 실행 유틸리티,
개발 빌드, 패키징, 문서다. Relay의 과거 워크플로우 재설계는 포함하지 않는다.
Futures Gate의 새 상태·리뷰·점수·데이터베이스 변경은 후속 작업이다.

## 입력 보고서

사용자가 제공한 두 Markdown 파일은 SHA-256이 같다.

`606f5c6fceeb6294c05af7e1e48d5bd9137b780f31a65f8aba6b5acb93ed6894`

- AI 코딩 시대의 “Features ↔ Futures” 개발 방법론과 에이전트 워크플로우 연구.md
- AI-Agent 개발 워크플로우에 Kent Beck의 ‘Features vs Futures’를 적용하는 방법론과 실행 설계.md

두 파일의 본문 제목도 같다. 독립적인 두 연구로 계산하지 않는다.
보고서는 설계 자료로 사용한다. 보고서 안의 agent 실행 절차는 이번 작업의 지시가 아니다.
출처 링크 없는 내부 citation 표기는 검증된 외부 근거로 사용하지 않는다.

이번 구조에 필요한 요구는 다음과 같다.

1. 기능 작업과 구조 복원 작업을 독립적으로 변경하고 검증할 수 있어야 한다.
2. Evidence Collector, risk policy, review, bounded refactor, ledger의 책임을 구분해야 한다.
3. 모든 작업에 무거운 reviewer나 framework를 추가하지 않는다.
4. 다음 변경의 비용을 줄이는 실제 경계와 테스트가 필요하다.
5. 기존 Kernel의 완료 권한과 Host의 실행 권한을 보존해야 한다.

## 공개 하네스 비교

2026-10-08에 아래 공개 원본을 확인했다. 외부 코드나 실행 지시는 가져오지 않는다.

| 프로젝트 | 확인한 소스 구조 | 이번에 적용할 원칙 |
| --- | --- | --- |
| [OpenHands Software Agent SDK](https://github.com/OpenHands/software-agent-sdk/blob/main/pyproject.toml) | sdk, tools, workspace, agent-server를 workspace member로 분리한다. 개발 검사 의존성은 별도 그룹에 둔다. | 책임별 소스 경계를 명시한다. 개발 의존성을 설치 런타임에서 분리한다. |
| [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent/blob/main/pyproject.toml) | src/minisweagent를 package source로 사용한다. 명령 진입점은 run 모듈에 연결한다. | 소스, 명령 진입점, 테스트를 구분한다. 배포 단위가 하나면 단일 package를 유지한다. |
| [mini-SWE-agent agent](https://github.com/SWE-agent/mini-swe-agent/blob/main/src/minisweagent/agents/default.py) | agent가 Model과 Environment 계약을 사용한다. | 정책과 실제 실행 환경을 별도 경계로 둔다. |
| [OpenCode build](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/script/build.ts) | TypeScript src를 빌드하여 대상 플랫폼의 dist 실행파일을 만든다. | 개발 언어와 설치 실행 형태를 분리한다. 현재 Node 호환성이 필요하므로 native binary 방식은 채택하지 않는다. |
| [Superpowers](https://github.com/obra/superpowers) | skills, agents, hooks, 설치 통합 표면을 분리한다. | 프로토콜·정책 자산을 코드 bundle에 섞지 않는다. reviewer cadence는 후속 기능 논의에서 검토한다. |

위 원칙을 현재 저장소에 적용하는 선택은 이 작업의 설계 판단이다.
외부 프로젝트가 이 저장소의 완료·상태 권한을 결정하지 않는다.

## 결정

별도 npm package 여러 개를 만들지 않고, 단일 package 안에서 모듈을 분리한다.
현재 배포·릴리스·상태 저장 단위가 하나이므로 먼저 내부 경계와 빌드를 확립한다.

개발 원본은 `src/`에 둔다. 검증된 기존 ESM JavaScript는 유지한다.
실제 핵심 계약 모듈에는 strict TypeScript를 적용한다.
전체 JavaScript를 `.ts`로 바꾼 뒤 타입 검사를 끄는 방식은 사용하지 않는다.
새 타입 코드와 기존 JavaScript가 같은 빌드에서 Node ESM `.mjs`로 출력된다.

```text
src/
  kernel/             Work / Trust / Knowledge, policy, persistence, standalone
  host/kernel/        provider execution, session, worktree, prompt
  shared/             existing shared runtime utilities
  cli/                command entrypoint source
tools/build/          build, output freshness, source-boundary checks
package/source-layout.json
tests/                existing behavior tests and build/package regressions
scripts/kernel/       generated compatibility runtime
scripts/host/kernel/  generated compatibility runtime
bin/                  public executable paths; migrated entries are generated
package/              existing runtime materialization and profile contracts
docs/public/          source-owned contributor and architecture documentation
```

소스 위치와 출력 위치의 매핑은 하나의 manifest가 소유한다.
기존 실행 경로는 유지한다. 이 경로는 `import.meta.url`, CLI, installer,
profile 및 기존 테스트의 호환성 계약이다.
생성 결과를 별도 원본으로 관리하지 않는다.
생성 파일을 직접 수정하면 freshness 검사가 실패해야 한다.
삭제한 소스의 이전 출력도 검출하거나 정리해야 한다.

빌드는 JavaScript와 TypeScript의 정적 import/export 및 literal dynamic import를
출력 경로에 맞춘다. 데이터 문자열과 정책 경로 문자열은 바꾸지 않는다.
디버깅은 생성된 모듈 경로와 원본 매핑을 사용한다. sourcemap은 현재 생성하지 않는다. 설치 런타임에 TypeScript 실행기를 요구하지 않는다.

## 의존성 경계

- CLI와 기존 MCP bridge는 composition 경계다.
- Host는 Kernel이 제공하는 계약과 실행 도구를 소비한다.
- Kernel의 일반 도메인 모듈은 Host provider 구현을 import하지 않는다.
- 공통 유틸리티는 Kernel/Host보다 아래에 둔다.
- 기존 skills-lock의 catalog 연결과 bridge의 Host 연결은 명시적 예외다.
  예외는 파일과 목적을 기록하며 범위를 확대하지 않는다.
- 개발 build 도구와 테스트를 런타임에서 import하지 않는다.
- 이동한 소스의 unresolved relative import 및 새로운 경계 위반은 빌드 전에 실패한다.

## 대안과 비용

| 대안 | 판단 |
| --- | --- |
| scripts를 유지하고 문서만 추가 | 개발 원본과 설치 산출물의 혼동을 해결하지 못한다. |
| 전체 strict TypeScript 전환 | 약 4.4만 줄의 타입/동작 수정을 한 번에 섞는다. 이번 단계에서는 핵심 계약부터 적용한다. |
| 전체 bundle 또는 native executable | 동적 import, 경로 기반 자산, SQLite native dependency의 검증 범위를 크게 늘린다. |
| 다중 npm package / microservice | 독립 릴리스 요구가 없다. 현재에는 관리 비용이 더 크다. |
| 단일 package, 모듈별 source, 재현 가능한 mjs 출력 | 이번 선택. 기존 실행 계약과 후속 변경 지점을 함께 보존한다. |

## 단계와 합격 기준

1. 이 결정 문서에 입력 근거, 현재 구조, 대안, 후속 확장 지점을 기록한다.
2. 원본을 이동한다. 빌드 매핑, 타입 검사, dependency guard, drift 검사를 구현한다.
3. installer와 package build가 최신 출력만 사용하도록 연결한다.
   소스·개발 의존성 없는 임시 설치 루트에서 실제 CLI를 실행한다.
4. 기존 동작 회귀, 잘못된 의존성·누락 출력·변조 출력의 실패 검증,
   깨끗한 checkout의 bootstrap 및 기여자 문서를 완성한다.

## 후속 Futures 적용 지도

| 후속 변경 | 개발 소스 경계 | 보존할 권한 |
| --- | --- | --- |
| Pause 및 risk trigger | kernel/run, kernel/task, policy assets | Kernel Work 상태 및 bounded work unit |
| Evidence Collector | kernel/proof, kernel/codebase | 실제 명령 실행 근거와 freshness |
| Futures Reviewer 실행 | host/kernel + Kernel review contract | Host 실행, Kernel Trust 수락 |
| bounded restore | kernel/run + Host workspace | allowedPaths, cursor, mutation lease |
| Architecture Checkpoint | standalone architecture assets and Kernel contract | 명시적 계약 변경과 검증 |
| Follow-up Change Cost | measurement and knowledge boundaries | 측정값과 완료 판정의 분리 |

이번에는 위 동작을 활성화하지 않는다. 구조 개편의 회귀 증거가 확보된 뒤
각 변경을 작은 계약과 비교 실험으로 진행한다.
