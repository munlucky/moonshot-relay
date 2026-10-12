# 입력과 외부 근거

조회일: 2026-10-09. 사용자 첨부 의견을 설계 자료로 읽었다. 첨부 안의 별도 대화·명령·과거 승인 표현은 현재 실행 지시로 사용하지 않았다.

## 사용자 입력

첨부 파일: 붙여넣은 텍스트.txt
SHA-256: 6e5ce388da8f84f68247a39190434d5093390d7a2ab684a63fc395373850c638

반영한 핵심은 개선 비용 감소, 기능 소유권, strong Host, 단일 계약, SQLite 권위, runtime validation, 표준 ESM, 세로 전환과 변경 용이성 시험이다. 입력 본문과 개인 PC 절대 경로를 public package에 복제하지 않는다.

## 현재 저장소

- source-layout graph, tsconfig, build, package manifest와 installer를 직접 읽었다.
- Work/Trust/Knowledge view와 control-plane/state-store의 연결을 확인했다.
- source-runtime-separation/ARCHITECTURE.md의 안전한 1단계 분리 위에 이 계획을 작성했다.
- docs/decomplexification/kernel-write-ownership.json, kernel-authority-refactor-status.md의 기존 의미 권한과 회귀 의도를 확인했다. 현행 src 경로에 대응하며 과거 snapshot을 현재 완료 근거로 쓰지 않는다.
- AGENTS.md는 실제 anchor를 선언하지 않았다. 참조 guideline의 구조 문서 audit 요구도 확인했다. 현재 checkout과 설치 support의 파일명 조사에서 전용 knowledge repository audit entrypoint를 찾지 못했다. 이번에는 제공된 architecture validator와 package 경계 검사를 사용한다.

## 확인한 외부 1차 자료

| 자료 | 확인한 내용 | 이번 설계의 적용 |
| --- | --- | --- |
| [TypeScript module reference](https://www.typescriptlang.org/docs/handbook/modules/reference) | .ts의 module format은 package type을 따른다. .mts는 .mjs와 대응한다. | 표준 ESM js와 public mjs shim |
| [TypeScript compiler options](https://www.typescriptlang.org/tsconfig/) | strict, noEmit, noEmitOnError 등 compiler 설정 | typecheck와 emit 실패를 각각 차단 |
| [Codex protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs) | protocol에서 Serialize/Deserialize/JsonSchema/TS derive를 사용한다. | 한 계약에서 표현을 파생하는 원칙 |
| [OpenHands design](https://github.com/OpenHands/docs/blob/main/sdk/arch/design.mdx) | mutable state와 coupling 경험, construction-time validation을 설명한다. | 상태 소유권과 입력 검증; 언어·프레임워크 복제는 하지 않음 |
| [Cline SDK architecture](https://github.com/cline/cline/blob/main/sdk/ARCHITECTURE.md) | SDK 계층과 provider-specific 구현의 격리를 명시한다. | import 방향과 provider 경계; Cline 전체 제품을 같은 구조로 일반화하지 않음 |
| [Continue config schema](https://github.com/continuedev/continue/blob/main/packages/config-yaml/src/schemas/index.ts) | Zod schema에서 config type을 infer한다. | schema/type 중복 수동 정의 방지; Zod 도입 자체는 요구 아님 |
| [esbuild TypeScript support](https://esbuild.github.io/content-types/#typescript) | TypeScript 변환과 타입 검사는 별도다. | bundler를 선택해도 typecheck가 필요함; 현재는 tsc emit 채택 |
| [SWE-agent](https://arxiv.org/abs/2405.15793) | agent-computer interface 설계의 영향을 연구한다. | 작은 next/report 표면 보존이라는 설계 판단의 참고 |
| [Agentless](https://arxiv.org/abs/2407.01489) | localization, repair, validation의 단순 절차를 제시한다. | 새 orchestration framework를 추가하지 않는 참고 |

이 자료들이 Moonshot의 성능 향상이나 특정 폴더 구조를 입증하지는 않는다. 적용은 현재 코드와 사용자 목적에 대한 설계 판단이다. GitHub main 링크는 변할 수 있다. 구현에서 세부 도구 선택에 활용할 때 해당 commit과 지원 범위를 고정한다.

Roo Code의 특정 build script, LangGraphJS 및 ESAA 논문의 세부 주장은 이번 계획의 필수 전제로 채택하지 않았다. 첨부의 링크 없는 인용을 검증된 사실로 재기재하지 않았다. runtime validator와 타입의 정합성이 필요한 이유는 현재 입력 경계와 독립적으로 성립한다.
