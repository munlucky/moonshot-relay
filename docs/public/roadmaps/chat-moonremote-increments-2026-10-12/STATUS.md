# 작업 진행표

현재 개발 상태: IN_PROGRESS. 이 파일은 계획 인덱스이며 runtime authority가 아니다.

허용 표기: NOT_STARTED, IN_PROGRESS, BLOCKED, EVAL_PENDING, COMPLETE, VERIFIED_EXISTING, NOT_APPLICABLE.
필수 카드의 완료는 COMPLETE/VERIFIED_EXISTING과 현재 유효한 증거가 있어야 한다. 조건부 카드만 NOT_APPLICABLE을 허용한다. 모델-backed 검증이 원격 필수 조건인 카드만 미실행 시 EVAL_PENDING이다. 현재 운영 surface인 Codex의 모델-backed 품질 검증은 LOCAL_CODEX_VALIDATION.md의 릴리스 전 후속 검증으로 분리한다.

| ID | Wave | 목표 | 선행 | 상태 |
| --- | --- | --- | --- | --- |
| [C00](cards/C00.md) | W0 | 원격 실행 환경과 선행 작업 기준선 | 없음 | COMPLETE |
| [C01](cards/C01.md) | W0 | Prompt 비교 코퍼스와 측정 기준 고정 | C00 | COMPLETE |
| [C02](cards/C02.md) | W1 | 공통 의미 계약과 기존 Envelope 매핑 | C01 | COMPLETE |
| [C03](cards/C03.md) | W1 | OpenAI 표현 방식 분리 | C02 | COMPLETE |
| [C04](cards/C04.md) | W1 | Codex capability delta 정리 | C03 | COMPLETE |
| [C05](cards/C05.md) | W1 | Claude 표현 방식 분리 | C02, C04 | COMPLETE |
| [C06](cards/C06.md) | W1 | Claude capability delta 정리 | C05 | COMPLETE |
| [C07](cards/C07.md) | W1 | Context 계층과 캐시 경계 보존 | C06 | VERIFIED_EXISTING |
| [C08](cards/C08.md) | W1 | Prompt Debt 중복 제거와 감사 규칙 | C07 | COMPLETE |
| [C09](cards/C09.md) | W1 | Codex 로컬 Prompt A/B 검증 계약 | C08 | COMPLETE |
| [C10](cards/C10.md) | W1 | 비운영 Provider 평가 범위 정리 | C09 | NOT_APPLICABLE |
| [C11](cards/C11.md) | W1 | Prompt gate 판정과 후속 기준선 고정 | C09, C10 | COMPLETE |
| [C12](cards/C12.md) | W2 | Futures Evidence 순수 수집 계약 | C11 | COMPLETE |
| [C13](cards/C13.md) | W2 | Green Yellow Red 평가와 mutation 제한 | C12 | COMPLETE |
| [C14](cards/C14.md) | W2 | Fresh review와 기존 Work 경로 연결 | C13 | COMPLETE |
| [C15](cards/C15.md) | W3 | Bounded Restore 실행과 fresh regression | C14 | NOT_STARTED |
| [C16](cards/C16.md) | W3 | Architecture escalation 기존 경로 재사용 | C15 | NOT_STARTED |
| [C17](cards/C17.md) | W4 | Knowledge type 표현 가능성 판정 | C16 | NOT_STARTED |
| [C18](cards/C18.md) | W4 | 최소 Procedure 표현과 점진적 로드 | C17 | NOT_STARTED |
| [C19](cards/C19.md) | W5 | Feedback root-cause 분류 계약 | C18 | NOT_STARTED |
| [C20](cards/C20.md) | W5 | 분류 결과를 기존 candidate lifecycle에 연결 | C19 | NOT_STARTED |
| [C21](cards/C21.md) | W6 | Improvement Pair identity와 원자성 | C20 | NOT_STARTED |
| [C22](cards/C22.md) | W6 | Pair replay와 promotion gate | C21 | NOT_STARTED |
| [C23](cards/C23.md) | W7 | Cross-run 반복 근거 묶음 | C22 | NOT_STARTED |
| [C24](cards/C24.md) | W7 | Episodic에서 durable로 승격 | C23 | NOT_STARTED |
| [C25](cards/C25.md) | W8 | Retrieval 정답셋과 지표 | C24 | NOT_STARTED |
| [C26](cards/C26.md) | W8 | Retrieval 단일 병목 개선과 비교 | C25 | NOT_STARTED |
| [C27](cards/C27.md) | W9 | Hidden follow-up 평가 프로토콜 | C26 | NOT_STARTED |
| [C28](cards/C28.md) | W9 | 전략별 순차 평가 실행 | C27 | NOT_STARTED |
| [C29](cards/C29.md) | W9 | Follow-up 비용 비교와 Adaptive 판정 | C28 | NOT_STARTED |
| [C30](cards/C30.md) | W10 | Projection interoperability 가치 판정 | C29 | NOT_STARTED |
| [C31](cards/C31.md) | W10 | 단일 Projection adapter | C30 진행 판정 | NOT_STARTED |
| [C32](cards/C32.md) | 마감 | 전체 계약 추적과 통합 검증 | C29 및 C30/C31의 조건 처리 | NOT_STARTED |

## 실행 결과 기록 형식

카드가 끝나면 아래 형식으로 짧은 기록을 추가한다. 상세 로그는 runtime 증거 경로에 남긴다. credential, 전체 prompt, provider home, DB를 이 폴더에 넣지 않는다.

```text
card: Cxx
status: COMPLETE / VERIFIED_EXISTING / BLOCKED / EVAL_PENDING / NOT_APPLICABLE
workspace: 실제 원격 경로
baseHead:
resultHeadOrDiffDigest:
taskId:
kernelRunId: 있으면 기록. 없으면 없음.
scope: 변경 원본과 테스트 경로
acceptance: AC-1/AC-2/AC-3/AC-4별 결과와 증거 참조
checks: 명령, operationId, exit, report path, 검증 시점의 digest
liveEval: 완료 / 미실행 / 미지원, 근거
remaining:
nextCard:
```

대량 evidence, 로그, verdict JSON은 package payload에 넣지 않는다. 문서에 COMPLETE를 적는 행위가 Kernel 또는 Moonremote task를 자동 완료하지 않는다.

```text
card: C00
status: BLOCKED
workspace: /shared/moonshot-relay
baseHead: d0c07ade7f4f46499a5a95350e2654a4f93515e2
resultHeadOrDiffDigest: HEAD unchanged; plan folder is untracked and STATUS.md records this baseline
taskId: dd57f37f-a585-4fb8-8687-4f7f6f9cf826
kernelRunId: 기존 Kernel work는 continuity checkpoint에 존재하나 이 카드에서 run 계약/ID를 재조회·재발급하지 않음
scope: docs/public/roadmaps/chat-moonremote-increments-2026-10-12/STATUS.md only; product source unchanged
acceptance: AC-1 baseline 확인, 단 기존 Typed Authority continuity가 active라 dependent 작업 차단; AC-2 prepared/running/unknown 0건 및 기존 Kernel 작업 보존; AC-3 git/toolchain/build:check fresh evidence 확보; AC-4 STATUS/checkpoint 기록
checks: git baseline c0000000-0000-4000-8000-000000000001 exit 0; toolchain c0000000-0000-4000-8000-000000000002 exit 0; npm run build:check c0000000-0000-4000-8000-000000000003 exit 0 (289 files, 768 edges, changed 0, removed 0)
liveEval: 미실행; C00 범위 아님
remaining: 기존 task revision 65의 Typed Authority 잔여 3개 항목 완료 및 authoritative Kernel 종료 근거 확인 후 C00 재판정
nextCard: C00 재개; C01 자동 진입 금지
```

```text
card: C00
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: d0c07ade7f4f46499a5a95350e2654a4f93515e2
resultHeadOrDiffDigest: HEAD=origin/main; 계획 폴더만 untracked이며 제품 원본 변경 없음
taskId: 76e12e39-3ded-4c66-b935-1f7750cc3a8f
kernelRunId: 없음; MCP runtime run-locator에서 해당 workspace 연결 run 0건
scope: docs/public/roadmaps/chat-moonremote-increments-2026-10-12/STATUS.md only; product source unchanged
acceptance: AC-1 기존 continuity를 abandoned로 종료하고 새 baseline 분리; AC-2 새 task의 running/unsettled 0건 및 Kernel locator 0건 확인; AC-3 HEAD/origin/toolchain/build:check을 새 receipt로 검증; AC-4 STATUS/checkpoint에 증거와 다음 카드 기록
checks: git baseline c3000000-0000-4000-8000-000000000002 exit 0; toolchain/origin c3000000-0000-4000-8000-000000000003 exit 0; npm run build:check c3000000-0000-4000-8000-000000000004 exit 0 (289 files, 768 edges, changed 0, removed 0); Typed Authority HEAD evidence c3000000-0000-4000-8000-000000000005 exit 0; Kernel locator read c3000000-0000-4000-8000-000000000006 exit 0
liveEval: 미실행; C00 범위 아님
remaining: C00 없음
nextCard: C01
```


```text
card: C01
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: d0c07ade7f4f46499a5a95350e2654a4f93515e2
resultHeadOrDiffDigest: sha256:2cbdcdf41ae9bb27c28cbfbc86f77778f27368053140ee84e509fe16c0924bd8
taskId: 48b59ca1-6718-4dc5-ba25-60611e80e8d1
kernelRunId: 없음; Kernel 모드 미사용
scope: tests/fixtures/kernel-eval/corpus.json; tests/kernel-eval-corpus-contract.test.ts; STATUS.md
acceptance: AC-1 6개 case, baseline prompt digest, surface/model/effort/tool set, rubric, paired-run/retry/incomplete 비용 한도 고정 및 외부 모델 호출 없이 검증; AC-2 기존 kernel-eval corpus/contract 재사용, 새 framework/provider renderer/fallback 없음; AC-3 build:tests, focused 8/8, build:tests:check 통과; AC-4 STATUS/checkpoint에 evidence와 nextCard 기록
checks: prompt digest c3100000-0000-4000-8000-000000000004 exit 0; JSON/diff c3100000-0000-4000-8000-000000000006 exit 0; npm run build:tests c3100000-0000-4000-8000-000000000008 exit 0; focused test c3100000-0000-4000-8000-000000000009 exit 0 (8/8); npm run build:tests:check c3100000-0000-4000-8000-000000000010 exit 0; diff digest c3100000-0000-4000-8000-000000000011 exit 0
liveEval: 미실행; C09/C10로 명시적으로 이관
remaining: C01 없음
nextCard: C02
```


```text
card: C02
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: d0c07ade7f4f46499a5a95350e2654a4f93515e2
resultHeadOrDiffDigest: sha256:62010a8a629a2b397b4960a2dfbfe56c926676fae0ff9b2a284a8b483c8af973
taskId: a1fb7821-cf2a-4f78-85c7-47851db9801d
kernelRunId: 없음; Kernel 모드 미사용
scope: src/host/kernel/prompts/common-execution.ts; src/host/kernel/prompt-envelope.ts; tests/kernel-common-execution-prompt.test.ts; tests/kernel-prompt-envelope.test.ts; STATUS.md
acceptance: AC-1 objective/acceptance/current work unit/scope/knowledge/verification/tools/mutation authority/completion condition을 기존 goal/context/constraints/doneWhen의 단일 provider-neutral mapping으로 고정; AC-2 새 Authority/wire schema/provider fork/fallback 없이 기존 HostExecutionContract·model context·ToolManifest에서 파생하며 누락·잘못된 타입·work-unit source mismatch를 fail-closed 처리; AC-3 현재 source 기준 typecheck/build/focused 23/23/build:check/build:tests:check 및 C01 baseline 8/8 통과; AC-4 STATUS/checkpoint에 변경·증거·nextCard 기록
checks: npm run build:tests c3200000-0000-4000-8000-000000000015 exit 0; 축소 후 typecheck+diff-check c3200000-0000-4000-8000-000000000021 exit 0; final build+focused 23/23+build:check c3200000-0000-4000-8000-000000000022 exit 0; build:tests:check+C01 prompt baseline 8/8 c3200000-0000-4000-8000-000000000023 exit 0; final scope/diff digest c3200000-0000-4000-8000-000000000024 exit 0
liveEval: 미실행; C02 범위 아님
remaining: C02 없음
nextCard: C03
```


```text
card: C03
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: d0c07ade7f4f46499a5a95350e2654a4f93515e2
resultHeadOrDiffDigest: sha256:1f3774fda9482b20ec8030282de16a303e41032dac44155e23ec3adcd8471a4b
taskId: c35a2782-0b38-47ad-8d62-337163e49ede
kernelRunId: 없음; Kernel 모드 미사용
scope: src/host/kernel/provider-prompt-policy.ts; src/host/kernel/openai-prompt-renderer.ts; tests/kernel-provider-prompt-policy.test.ts; tests/kernel-openai-prompt-renderer.test.ts; generated tests/kernel-openai-prompt-renderer.test.mjs; STATUS.md
acceptance: AC-1 openai surface만 Responses serialization을 선택하고 기존 common semantic request를 WHAT/BOUNDARY/EVIDENCE/DONE 순서로 canonical 직렬화; 동일 의미 입력은 결정적이며 common instructions와 user data 권한 경계를 분리; Codex/unknown은 이 renderer에서 provider-unsupported로 유지하고 기존 Codex dispatcher envelope 회귀 통과; AC-2 저장소에 일반 OpenAI adapter가 없어 renderer까지만 구현하고 API client/function-call transport/새 실행기를 추가하지 않음; AC-3 현재 source 기준 typecheck/build/build:tests/focused 32/32/build:check/build:tests:check/C01 baseline 8/8/check:boundaries 통과; AC-4 STATUS/checkpoint에 변경·증거·nextCard 기록
checks: diff-check+typecheck c3300000-0000-4000-8000-000000000007 exit 0; npm run build c3300000-0000-4000-8000-000000000009 exit 0 (290 files, 774 edges); npm run build:tests c3300000-0000-4000-8000-000000000010 exit 0 (265 tests, 8 helpers); focused renderer/provider/prompt-envelope/dispatcher c3300000-0000-4000-8000-000000000011 exit 0 (32/32); npm run build:check c3300000-0000-4000-8000-000000000012 exit 0; npm run build:tests:check c3300000-0000-4000-8000-000000000013 exit 0; C01 prompt baseline c3300000-0000-4000-8000-000000000014 exit 0 (8/8); complexity/diff review c3300000-0000-4000-8000-000000000016 exit 0; npm run check:boundaries c3300000-0000-4000-8000-000000000017 exit 0; scoped digest c3300000-0000-4000-8000-000000000018 exit 0
liveEval: 미지원/미실행; 일반 OpenAI API adapter/dispatch 경로가 없어 C03 AC-2에 따라 renderer만 검증. 외부 모델 호출 없음
remaining: C03 없음
nextCard: C04
```


```text
card: C04
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: d0c07ade7f4f46499a5a95350e2654a4f93515e2
resultHeadOrDiffDigest: sha256:cf076869ae544db5793e8bd908c44d5226e88104d1b514a287ae379da0c672dc
taskId: d13f3980-83e4-407c-88ca-fdb10d729c6f
kernelRunId: 없음; Kernel 모드 미사용
scope: src/host/kernel/codex-model-policy.ts; tests/kernel-codex-model-policy.test.ts; tests/kernel-codex-programmatic-tool-policy.test.ts; STATUS.md
acceptance: AC-1 기존 4 execution class 및 CODEX_EXECUTION_POLICY model/effort routing을 보존하고, derived capability delta에서 autonomy=contract-gated, persistence=declared Host capability, repository investigation=work-unit scope, tool use=ToolManifest+existing programmatic gate, effort=existing execution-class policy, progress=execution Host-owned로만 표현; Codex provider prompt 전체 복제/추가 없음; AC-2 CODEX_MODELS/default model ID 변경 없음, 최신 model ID 자동 교체 없음; AC-3 typecheck/build/build:tests, 지정 focused 21/21, Codex capability/prompt/subagent 회귀 15/15, build:check/build:tests:check/check:boundaries 및 C01 baseline 8/8 통과; AC-4 STATUS/checkpoint에 변경·증거·nextCard 기록
checks: line-ending+diff-check c3400000-0000-4000-8000-000000000007 exit 0; typecheck c3400000-0000-4000-8000-000000000008 exit 0; build c3400000-0000-4000-8000-000000000010 exit 0 (290 files, 774 edges); build:tests c3400000-0000-4000-8000-000000000011 exit 0 (265 tests, 8 helpers); C04 focused c3400000-0000-4000-8000-000000000012 exit 0 (21/21); Codex capability/prompt/subagent regression c3400000-0000-4000-8000-000000000013 exit 0 (15/15); build:check c3400000-0000-4000-8000-000000000015 exit 0; build:tests:check c3400000-0000-4000-8000-000000000016 exit 0; check:boundaries c3400000-0000-4000-8000-000000000017 exit 0; C01 baseline c3400000-0000-4000-8000-000000000018 exit 0 (8/8); final scoped diff c3400000-0000-4000-8000-000000000019 exit 0
liveEval: 미실행; C04는 Host capability delta와 정적/회귀 검증 범위. 모델 교체·외부 provider 호출 없음
remaining: C04 없음
nextCard: C05
```


```text
card: C05
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: d0c07ade7f4f46499a5a95350e2654a4f93515e2
resultHeadOrDiffDigest: sha256:724f49bb867a1266c1f7db51a68cf83f26db48426f7cdaafae935243fbf73cf9
taskId: e4f34faa-61aa-41e2-b9a2-df7f8416332a
kernelRunId: 없음; Kernel 모드 미사용
scope: src/host/kernel/claude-prompt-renderer.ts; tests/kernel-claude-prompt-renderer.test.ts; generated tests/kernel-claude-prompt-renderer.test.mjs; STATUS.md
acceptance: AC-1 C02 buildCommonPromptRequest를 단일 의미 원본으로 재사용하고 Claude user XML에 project_context/objective/constraints/work_unit/verification을 렌더링; 동일 fixture에서 OpenAI/Claude가 9개 semantic 값을 모두 보존; dynamic XML text는 escape되고 stable common/provider instructions는 별도 system blocks로 유지; XML은 Host-side serialization이며 Kernel wire contract 변경 없음. AC-2 malicious knowledge의 XML close/open tags와 mutation-authority 삽입이 escaped data로 남아 실제 scope/mutation tag를 추가하지 못함; prompt-envelope hash는 C02 artifact와 동일하고 Claude provider prompt/adapter 변경 없음. AC-3 typecheck/build/build:tests, focused 17/17, build:check/build:tests:check/check:boundaries, C01 baseline 8/8 통과. AC-4 STATUS/checkpoint에 변경·증거·nextCard 기록
checks: renderer search c3500000-0000-4000-8000-000000000002 exit 0; diff-check+typecheck c3500000-0000-4000-8000-000000000004 exit 0; build c3500000-0000-4000-8000-000000000006 exit 0 (291 files, 779 edges); build:tests c3500000-0000-4000-8000-000000000007 exit 0 (266 tests, 8 helpers); Claude renderer/prompt/envelope focused c3500000-0000-4000-8000-000000000008 exit 0 (17/17); build:check c3500000-0000-4000-8000-000000000010 exit 0; build:tests:check c3500000-0000-4000-8000-000000000011 exit 0; check:boundaries c3500000-0000-4000-8000-000000000013 exit 0; C01 baseline c3500000-0000-4000-8000-000000000014 exit 0 (8/8); final scope/complexity/digest c3500000-0000-4000-8000-000000000015 exit 0
liveEval: 미실행; C05는 provider serialization과 deterministic/structural 검증 범위. 외부 Claude 호출 없음
remaining: C05 없음
nextCard: C06
```


```text
card: C06
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: d0c07ade7f4f46499a5a95350e2654a4f93515e2
resultHeadOrDiffDigest: sha256:40e5d43426f36063359f9764691f46888e3eb5088bf0d66a921a55aa020ae3d8
taskId: 4b0f6eee-59c9-4c09-abc3-693855b6ddd6
kernelRunId: 없음; Kernel 모드 미사용
scope: src/host/kernel/provider-prompt-policy.ts; src/host/kernel/claude-effort-policy.ts; tests/kernel-claude-thinking-policy.test.ts; tests/kernel-claude-delegation-policy.test.ts; tests/kernel-common-verification-policy.test.ts; STATUS.md
acceptance: AC-1 adaptive thinking은 Host가 supportsAdaptiveThinking=true를 명시할 때만 사용; effort는 기존 resolveClaudeEffort, delegation은 기존 zero-nested-agent Host policy, verification은 기존 Kernel-authoritative common policy 재사용; execution class/always-on agent 추가 없음. AC-2 truthy string capability는 미지원 처리하고 모델 성향/ID를 하드코딩하지 않음; prompt candidate는 always-subagent/always-self-verification 제거 후보만 기록하며 외부 입력 검증/Trust proof는 유지. AC-3 typecheck/build/build:tests, focused 17/17, build:check/build:tests:check/check:boundaries, C01 baseline 8/8 통과. AC-4 STATUS/checkpoint에 증거와 nextCard 기록
checks: policy inspection c3600000-0000-4000-8000-000000000002,c3600000-0000-4000-8000-000000000003 exit 0; diff-check+typecheck c3600000-0000-4000-8000-000000000004 exit 0; build c3600000-0000-4000-8000-000000000006 exit 0 (291 files, 781 edges); build:tests c3600000-0000-4000-8000-000000000007 exit 0 (266 tests, 8 helpers); focused c3600000-0000-4000-8000-000000000008 exit 0 (17/17); build:check c3600000-0000-4000-8000-000000000009 exit 0; build:tests:check c3600000-0000-4000-8000-000000000010 exit 0; check:boundaries c3600000-0000-4000-8000-000000000011 exit 0; C01 baseline c3600000-0000-4000-8000-000000000012 exit 0 (8/8); final scoped review c3600000-0000-4000-8000-000000000013 exit 0
liveEval: 미실행; C06는 capability mapping/static regression 범위. 외부 Claude 호출 없음
remaining: C06 없음
nextCard: C07
```


```text
card: C07
status: VERIFIED_EXISTING
workspace: /shared/moonshot-relay
baseHead: d0c07ade7f4f46499a5a95350e2654a4f93515e2
resultHeadOrDiffDigest: no C07 product diff; existing context/cache implementation verified against current C01-C06 workspace
taskId: 24844844-72ea-4633-b8fd-f85982f19e47
kernelRunId: 없음; Kernel 모드 미사용
scope: no product source changes; verified src/host/kernel/context-segments.ts, prompt-envelope.ts, provider-prompt-policy.ts, usage-receipt.ts and existing focused tests
acceptance: AC-1 volatile/control identity changes preserve prefix; timestamp/score noise does not move stable digest; run/project/tool changes move related digests; unsupported/unreported cache remains null+diagnostic instead of false hit=0. AC-2 cache identity includes routing/model/effort/tool/project/run inputs and no permission/routing field is deleted for cache; Claude breakpoints exclude volatile. AC-3 current focused suite 31/31 passed. AC-4 STATUS/checkpoint records verified-existing result and nextCard
checks: source/test mapping c3700000-0000-4000-8000-000000000002 exit 0; focused prompt-prefix/context-byte/provider-cache/cache-usage/Claude-breakpoint c3700000-0000-4000-8000-000000000003 exit 0 (31/31)
liveEval: 미실행; C07는 deterministic cache-boundary verification 범위
remaining: C07 없음
nextCard: C08
```


```text
card: C08
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: d0c07ade7f4f46499a5a95350e2654a4f93515e2
resultHeadOrDiffDigest: sha256:06cdcf8ef41f5dddeecb57a1cdd0b7e60643a4bbfc7987dbafaf04c23af6d419
taskId: 049a7e23-147d-405b-9bf3-e57a4cb63711
kernelRunId: 없음; Kernel 모드 미사용
scope: artifacts/kernel-prompt-audit/{prompt-inventory.json,instruction-classification.json,removed-instructions.md}; docs/public/development.md; tests/kernel-prompt-inventory.test.ts; STATUS.md
acceptance: AC-1 legacy audit에서 확인된 삭제 대상은 0건으로 유지하고 C01 baseline/C09/C10/C11 gate, canonical src owner, 재감사 trigger를 기록; live gate 전 candidate가 baseline을 덮어쓰지 않도록 shadow/off 원칙 보존. AC-2 scope/security/compatibility/evidence/review/completion authority 보존 규칙을 명시하고 AGENTS.md 전체 재작성 없음. AC-3 build:tests, legacy/size/inventory focused 10/10, build:tests:check, C01 baseline 8/8, diff-check 통과. AC-4 STATUS/checkpoint 기록 및 nextCard C09
checks: audit discovery c3800000-0000-4000-8000-000000000002 exit 0; source-size/current-owner evidence c3800000-0000-4000-8000-000000000004,c3800000-0000-4000-8000-000000000006,c3800000-0000-4000-8000-000000000007,c3800000-0000-4000-8000-000000000008,c3800000-0000-4000-8000-000000000009 exit 0; build:tests c3800000-0000-4000-8000-000000000015 exit 0; focused c3800000-0000-4000-8000-000000000016 exit 0 (10/10); build:tests:check c3800000-0000-4000-8000-000000000017 exit 0; C01 baseline c3800000-0000-4000-8000-000000000018 exit 0 (8/8); scoped digest/diff-check c3800000-0000-4000-8000-000000000019 exit 0
liveEval: 미실행; C09/C10에서 수행
remaining: C08 없음
nextCard: C09
```


```text
card: C09
status: EVAL_PENDING
workspace: /shared/moonshot-relay
baseHead: d0c07ade7f4f46499a5a95350e2654a4f93515e2
resultHeadOrDiffDigest: no C09 product/prompt diff; live evaluation not started
taskId: 072355e7-3d3d-4459-846f-b8e6877e7dbb
kernelRunId: 없음; Kernel 모드 미사용
scope: readiness inspection and STATUS.md only; prompt 수정 없음
acceptance: AC-1 미충족 — actual task success/scope/hardcoding/regression 및 provider cost/usage 결과가 아직 없음. AC-2 충족 판정에 따라 EVAL_PENDING — Moonremote 환경에 OPENAI_API_KEY/CODEX_API_KEY 없음, codex/openai executable 없음, C01 Prompt A/B 전용 live runner 없음; mock/static 결과로 대체하지 않음. AC-3 readiness receipt는 현재 C01 corpus(6 cases, old/new 각 2회, case 최대 8 provider calls)와 현재 환경을 연결. AC-4 STATUS/checkpoint에 blocker 및 C09 재개 조건 기록
checks: eval/surface discovery c3900000-0000-4000-8000-000000000002 exit 0; credential/executable presence c3900000-0000-4000-8000-000000000003 exit 0; structured readiness c3900000-0000-4000-8000-000000000004 exit 0
liveEval: 미실행; credentials=false, codex/openai executables=false. mock 결과 사용 금지
remaining: 실제 OpenAI 또는 Codex live execution surface와 credential/auth를 제공한 뒤 C09a(첫 2 cases)부터 old/new×2 ABBA 실행. C09 완료 전 C10/C11 진입 금지
nextCard: C09 재개
```


```text
card: C09
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: d0c07ade7f4f46499a5a95350e2654a4f93515e2
resultHeadOrDiffDigest: remote Codex contract gate complete; model-backed quality gate moved to LOCAL_CODEX_VALIDATION.md
taskId: 072355e7-3d3d-4459-846f-b8e6877e7dbb
kernelRunId: 없음; Kernel 모드 미사용
scope: cards/C09.md; CONTRACTS.md P evaluation boundary; RUNBOOK.md model-backed boundary; LOCAL_CODEX_VALIDATION.md; STATUS.md. 제품 prompt/source 수정 없음
acceptance: AC-1 원격 Codex corpus/prompt/model/plan/programmatic-tool/responses-capability/dispatcher 계약 50/50 통과; 로컬 model-backed 6-case old/new×2 절차를 별도 릴리스 검증으로 문서화. AC-2 standalone OpenAI/Claude live 평가는 현재 운영 필수 gate가 아니며 mock으로 대체하지 않음. AC-3 현재 source와 C01 corpus가 fresh하게 연결됨. AC-4 STATUS/checkpoint에 사용자 운영 결정과 nextCard 기록
checks: prior readiness c3900000-0000-4000-8000-000000000002..004 exit 0; plan/contract inspection c3900000-0000-4000-8000-000000000007,c3900000-0000-4000-8000-000000000008 exit 0; remote Codex contract gate c3900000-0000-4000-8000-000000000009 exit 0 (50/50)
liveEval: 원격 미실행. 실제 운영 모델 검증은 LOCAL_CODEX_VALIDATION.md에 따라 로컬 Codex에서 릴리스 전 수행. mock 결과 없음
remaining: W1 원격 구현 기준 C09 없음; 릴리스 전 local Codex VALIDATED 필요
nextCard: C10
supersedes: 이전 C09 EVAL_PENDING 기록은 provider별 remote live를 필수로 보던 계획 기준이며, 사용자가 Codex-only 운영과 local model-backed 검증 경계를 확정해 해소됨
```


```text
card: C10
status: NOT_APPLICABLE
workspace: /shared/moonshot-relay
baseHead: d0c07ade7f4f46499a5a95350e2654a4f93515e2
resultHeadOrDiffDigest: no C10 product diff; non-operational standalone provider live gate excluded by operating policy
taskId: 7af4f4a3-a8dd-41bf-9964-178c08a60b0f
kernelRunId: 없음; Kernel 모드 미사용
scope: C10 operating-scope decision and deterministic OpenAI/Claude regression only
acceptance: AC-1 OpenAI/Claude serialization/capability/scope/tool boundary focused suite 46/46 통과. token/latency live 비교는 provider 운영 채택 전 필수 조건이 아님. AC-2 공통 prompt를 비운영 provider에 맞춰 왜곡하지 않았고 향후 실제 운영 surface 채택 시 C10을 다시 열도록 문서화. AC-3 현재 source와 deterministic receipts 연결. AC-4 STATUS/checkpoint 기록
checks: deterministic provider regression c3a00000-0000-4000-8000-000000000002 exit 0 (46/46)
liveEval: NOT_APPLICABLE — 현재 실제 운영 surface는 Codex. standalone Claude/OpenAI provider live 호출은 릴리스 gate 아님
remaining: C10 없음. provider 채택 시 재개
nextCard: C11
```


```text
card: C11
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: d0c07ade7f4f46499a5a95350e2654a4f93515e2
resultHeadOrDiffDigest: W1 remote contract baseline; git commit hash is the immutable post-gate baseline
taskId: 1bf18b0d-06f3-43bf-98e7-a6f70c11227d
kernelRunId: 없음; Kernel 모드 미사용
scope: W1 C02-C11 product/test/audit/roadmap changes; C09/C10 operating policy update; LOCAL_CODEX_VALIDATION.md
acceptance: AC-1 필수 운영 surface를 Codex로 고정하고 standalone Claude/OpenAI live gate는 조건부/비운영으로 명시. Kernel command/Authority/stage/execution-class product 변경 0. AC-2 원격 모델-backed live를 W2 blocker로 사용하지 않고, C01 6-case old/new×2 품질/효율 검증을 LOCAL_CODEX_VALIDATION.md의 릴리스 전 필수 후속으로 분리. AC-3 동일 W1 변경 집합에서 lint:kernel, test freshness, boundary, focused 151/151 통과. AC-4 STATUS/checkpoint에 W1 gate와 nextCard C12 기록
checks: workspace/diff c3b00000-0000-4000-8000-000000000002 exit 0; npm run lint:kernel c3b00000-0000-4000-8000-000000000003 exit 0 (build 291 files/781 edges, typecheck, static 856); build:tests:check+check:boundaries c3b00000-0000-4000-8000-000000000004 exit 0 (266 tests/8 helpers; 9 modules/291 files/781 edges); W1 focused aggregate c3b00000-0000-4000-8000-000000000005 exit 0 (151/151); authority/core diff guard c3b00000-0000-4000-8000-000000000006 exit 0
liveEval: 원격 미실행. LOCAL_CODEX_VALIDATION.md에 따라 실제 Codex 모델-backed 검증은 릴리스/기본 profile 활성화 전 로컬에서 수행
remaining: W1 원격 구현 없음. 로컬 Codex VALIDATED는 릴리스 전 필요
nextCard: C12
```


```text
card: C12
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: fa64e166635252e76e51477744f4b2525ad38d73
resultHeadOrDiffDigest: sha256:2140b95e7cd50360107fa0c6c715deb0fbfca58412eeb9cd9d4f41bed39b0cad
taskId: 791cdfb7-41b8-4894-97f3-4043e284ff61
kernelRunId: 없음; Kernel 모드 미사용
scope: src/contracts/futures-evidence.ts; generated scripts/contracts/futures-evidence.js; src/kernel/proof/futures-evidence.ts; tests/kernel-futures-evidence.test.ts; generated tests/kernel-futures-evidence.test.mjs; STATUS.md
acceptance: AC-1 revision/contentDigest/change paths/dependency boundaries/regression scope/unknowns를 canonical digest에 바인딩; null 미확인과 [] 관찰 없음 구분; missing/unknown은 status=incomplete로 유지. AC-2 collector는 전달받은 observation만 정규화하며 fs/process/provider/project 의존 및 state mutation 없음; 위험도 평가도 수행하지 않음. AC-3 typecheck/build/build:tests/focused 5/5/build:check/build:tests:check/check:boundaries 통과, malformed digest/path 거부. AC-4 STATUS/checkpoint에 evidence와 nextCard 기록
checks: evidence search c3c00000-0000-4000-8000-000000000002..004 exit 0; initial typecheck c3c00000-0000-4000-8000-000000000006 exit 2 (unknown narrowing only); corrected typecheck c3c00000-0000-4000-8000-000000000007 exit 0; build+build:tests c3c00000-0000-4000-8000-000000000008 exit 0 (293 files/783 edges; 267 tests/8 helpers); focused c3c00000-0000-4000-8000-000000000009 exit 0 (5/5); freshness/boundary/purity c3c00000-0000-4000-8000-000000000010 exit 0; generated convention c3c00000-0000-4000-8000-000000000012 exit 0
liveEval: 미실행; pure evidence contract 범위
remaining: C12 없음
nextCard: C13
```


```text
card: C13
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: fa64e166635252e76e51477744f4b2525ad38d73
resultHeadOrDiffDigest: sha256:77b118e051fbcfe005eadfbc9f98ab8113c8b54d1322543b9ead7efac3a88924
taskId: 47505b08-2923-4263-bb5e-9d346e2a89cd
kernelRunId: 없음; Kernel 모드 미사용
scope: src/contracts/futures-evidence.ts; generated scripts/contracts/futures-evidence.js; src/kernel/proof/futures-assessment.ts; tests/kernel-futures-assessment.test.ts; generated tests/kernel-futures-assessment.test.mjs; STATUS.md
acceptance: AC-1 Green은 existing obligations, Yellow는 observed changed paths 안의 bounded restore 후보, Red는 architecture-planning 후보만 반환; 직접 mutation/rollback/knowledge promotion 없음. AC-2 evidence revision/content/digest freshness를 검증하고 stale/tampered evidence를 거부; missing/unknown은 color=null incomplete로 유지하고 Work cursor/completion을 쓰지 않음. AC-3 typecheck/build/build:tests/focused 7/7/build:check/build:tests:check/check:boundaries 및 mutation/model/project scan 통과. AC-4 STATUS/checkpoint에 evidence와 nextCard 기록
checks: F/action inspection c3d00000-0000-4000-8000-000000000002 exit 0; typecheck c3d00000-0000-4000-8000-000000000004 exit 0; build+build:tests+focused c3d00000-0000-4000-8000-000000000005 exit 0 (294 files/785 edges; 268 tests/8 helpers; focused 7/7); freshness/boundary/static authority scan c3d00000-0000-4000-8000-000000000006 exit 0; scoped digest c3d00000-0000-4000-8000-000000000007 exit 0
liveEval: 미실행; deterministic assessment contract 범위
remaining: C13 없음
nextCard: C14
```


```text
card: C14
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: fa64e166635252e76e51477744f4b2525ad38d73
resultHeadOrDiffDigest: sha256:83f709194d70a3a038186883010140fbb79a6025eae49478a7703c23941c0611
taskId: 70d11141-e303-4b0b-832a-728c6c53bc8f
kernelRunId: 없음; Kernel 모드 미사용
scope: src/contracts/futures-evidence.ts; generated scripts/contracts/futures-evidence.js; src/kernel/proof/futures-assessment.ts; src/kernel/proof/review-pipeline.ts; tests/kernel-futures-review-gate.test.ts; generated tests/kernel-futures-review-gate.test.mjs; C12/C13 W2 sources/tests; STATUS.md
acceptance: AC-1 assessment subject에 changedPathsDigest를 포함하고 같은 mutation revision/workspace/content/changed paths/assessment evidence digest에 묶인 closed ReviewReceipt만 candidate를 ready로 노출; stale/missing/unavailable/self-check/tamper는 blocker. AC-2 review capability unavailable은 no-independent-review-capability로 남기고 새 reviewer/schema/stage/obligation compiler나 임의 fallback을 추가하지 않음; Green은 현재 Work에 남아 있는 obligation만 재사용. AC-3 현재 source 기준 typecheck/build/build:tests, Futures+Review focused 42/42, build:check/build:tests:check/check:boundaries 통과. AC-4 STATUS/checkpoint에 evidence와 nextCard 기록
checks: current diff/package mapping c3e00000-0000-4000-8000-000000000012 exit 0; typecheck/build/build:tests/focused 42/42/build:check/build:tests:check c3e00000-0000-4000-8000-000000000014 (boundary 단계 진입 후 전체 command 240s timeout; 앞선 항목은 모두 pass); standalone check:boundaries c3e00000-0000-4000-8000-000000000015 exit 0 (9 modules, 294 files, 787 edges)
liveEval: 미실행; C14는 기존 ReviewReceipt/Work authority 연결의 deterministic integration 범위
remaining: C14 없음. 다음 카드 자동 진입 금지
nextCard: C15
```
