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
| [C15](cards/C15.md) | W3 | Bounded Restore 실행과 fresh regression | C14 | COMPLETE |
| [C16](cards/C16.md) | W3 | Architecture escalation 기존 경로 재사용 | C15 | COMPLETE |
| [C17](cards/C17.md) | W4 | Knowledge type 표현 가능성 판정 | C16 | COMPLETE |
| [C18](cards/C18.md) | W4 | 최소 Procedure 표현과 점진적 로드 | C17 | COMPLETE |
| [C19](cards/C19.md) | W5 | Feedback root-cause 분류 계약 | C18 | COMPLETE |
| [C20](cards/C20.md) | W5 | 분류 결과를 기존 candidate lifecycle에 연결 | C19 | COMPLETE |
| [C21](cards/C21.md) | W6 | Improvement Pair identity와 원자성 | C20 | COMPLETE |
| [C22](cards/C22.md) | W6 | Pair replay와 promotion gate | C21 | COMPLETE |
| [C23](cards/C23.md) | W7 | Cross-run 반복 근거 묶음 | C22 | COMPLETE |
| [C24](cards/C24.md) | W7 | Episodic에서 durable로 승격 | C23 | COMPLETE |
| [C25](cards/C25.md) | W8 | Retrieval 정답셋과 지표 | C24 | COMPLETE |
| [C26](cards/C26.md) | W8 | Retrieval 단일 병목 개선과 비교 | C25 | COMPLETE |
| [C27](cards/C27.md) | W9 | Hidden follow-up 평가 프로토콜 | C26 | COMPLETE |
| [C28](cards/C28.md) | W9 | 전략별 순차 평가 실행 | C27 | EVAL_PENDING |
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


```text
card: C15
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: f3ee56d921ea53bbeb28efd49bf7dd9aceb1eecf
resultHeadOrDiffDigest: sha256:b9ce7115427a04dfc095d632de1ff0fbaccf4431bfc8eb386f219f33dc6574da
taskId: c7bca2f1-f672-4dc0-9441-0991418e5443
kernelRunId: 없음; Kernel 모드 미사용
scope: src/kernel/run/step-planner.ts; tests/kernel-futures-bounded-restore.test.ts; generated tests/kernel-futures-bounded-restore.test.mjs; 기존 mutation-guard/evidence-reuse는 변경 없이 회귀 검증
acceptance: AC-1 reviewed Yellow bounded-restore를 기존 planReplacementSteps가 소비하는 bounded replacement Work Unit으로 변환하고 observed allowedPaths 밖을 확대하지 않음; behavior invariant와 scope/invariant/fresh-proof stop condition을 보존. AC-2 기존 mutation guard가 scope 밖 mutation 및 destructive reset을 차단하고 exact evidence identity가 달라지면 이전 proof 재사용을 거부; 새 rollback engine/명령/stage 없음. AC-3 typecheck/build/build:tests 및 C15 focused 17/17, W3 integration 59/59, build:check/build:tests:check/check:boundaries 통과. AC-4 STATUS/checkpoint에 변경·증거·다음 카드 기록
checks: typecheck d3a00000-0000-4000-8000-000000000023 exit 0; build d3a00000-0000-4000-8000-000000000024 exit 0 (294 files, 787 edges); build:tests d3a00000-0000-4000-8000-000000000025 exit 0 (271 tests, 8 helpers); C15 focused d3a00000-0000-4000-8000-000000000016 exit 0 (17/17); W3 integration d3a00000-0000-4000-8000-000000000026 exit 0 (59/59); build:check d3a00000-0000-4000-8000-000000000027 exit 0; build:tests:check d3a00000-0000-4000-8000-000000000028 exit 0; check:boundaries d3a00000-0000-4000-8000-000000000029 exit 0
liveEval: 미실행; deterministic Work/Host mutation/proof integration 범위
remaining: C15 없음
nextCard: C16 (같은 W3에서 자동 진행 완료)
```

```text
card: C16
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: f3ee56d921ea53bbeb28efd49bf7dd9aceb1eecf
resultHeadOrDiffDigest: sha256:b9ce7115427a04dfc095d632de1ff0fbaccf4431bfc8eb386f219f33dc6574da
taskId: c7bca2f1-f672-4dc0-9441-0991418e5443
kernelRunId: 없음; Kernel 모드 미사용
scope: src/application/kernel-standalone/architecture-artifacts.ts; tests/kernel-futures-architecture-handoff.test.ts; generated tests/kernel-futures-architecture-handoff.test.mjs; 기존 replan/architecture handoff는 변경 없이 재사용
acceptance: AC-1 reviewed Red 또는 실패 사유가 명시된 bounded restore만 기존 architecture pre-work handoff로 정규화; reviewed affected paths, unresolved requirements, escalation reason과 review/assessment identity를 보존. AC-2 stale revision/content, missing review, invalid candidate/digest, reason 없는 restore escalation은 fail-closed; handoff는 prework-only이며 source mutation, Work cursor 전진, completion 권위를 갖지 않음. AC-3 C16+기존 replan/architecture focused 21/21 및 W3 integration 59/59, typecheck/build/build checks/boundary 모두 통과. AC-4 STATUS/checkpoint에 evidence와 W3 종료를 기록
checks: initial C16 focused d3a00000-0000-4000-8000-000000000017은 fixture observer 누락으로 20/21; 기존 API 계약에 맞게 fixture만 수정 후 d3a00000-0000-4000-8000-000000000019 exit 0 (21/21); final W3 integration d3a00000-0000-4000-8000-000000000026 exit 0 (59/59); final policy/complexity scan d3a00000-0000-4000-8000-000000000030 exit 0; scoped digest d3a00000-0000-4000-8000-000000000031 exit 0
liveEval: 미실행; 기존 architecture pre-work/Task Contract Seed 경계 재사용 범위
remaining: W3 없음. 다음 Wave 자동 진입 금지
nextCard: C17 (W4는 사용자 확인 후 별도 요청)
```

```text
card: C17
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: 483598cdddc82361bbb347b60ec6a65f5debd1d9
resultHeadOrDiffDigest: sha256:cb6976e99fadb8c7f31e1b0fd4cddcb5585f9fc16a4295ce568ffe8d126b3af5
taskId: 93721595-fa03-4778-9405-35c3559a9339
kernelRunId: 없음; Kernel 모드 미사용
scope: tests/kernel-knowledge-procedure-representation.test.ts; generated tests/kernel-knowledge-procedure-representation.test.mjs; schema/product source 변경 없음
acceptance: AC-1 대표 procedure 3개를 기존 episodic_observation + practiceJson으로 prerequisites/steps/verification/scope/prohibitions/validUntil까지 schema round-trip하고 known_failure_pattern/일반 episodic observation과 구분됨을 고정. AC-2 tacit_practice가 이미 episodic_observation으로 canonical mapping되고 추가 필드를 보존하므로 새 generic procedure type/schema/migration 불필요. AC-3 build:tests, source validator/schema codec/context focused 12/12, typecheck, build:tests:check 통과. AC-4 STATUS/checkpoint에 변경·증거·nextCard 기록
checks: build:tests c1700000-0000-4000-8000-000000000006 exit 0 (272 tests, 8 helpers); focused c1700000-0000-4000-8000-000000000007 exit 0 (12/12); typecheck c1700000-0000-4000-8000-000000000008 exit 0; build:tests:check c1700000-0000-4000-8000-000000000009 exit 0; scoped digest/diff c1700000-0000-4000-8000-000000000010 exit 0
liveEval: 미실행; deterministic record/schema/retrieval 표현 가능성 판정 범위
remaining: C17 없음
nextCard: C18 (사용자 Wave4 요청에 따라 별도 task로 진행)
```

```text
card: C18
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: 483598cdddc82361bbb347b60ec6a65f5debd1d9
resultHeadOrDiffDigest: sha256:41dc089fafe390ceaf8d2b0d954ea93d26e75a4da52511ffe80f1a452852b65f
taskId: 864bb1aa-fe5f-4196-a75b-d53cfbe7c7d8
kernelRunId: 없음; Kernel 모드 미사용
scope: src/kernel/knowledge/context-load.ts; src/kernel/knowledge/context-render.ts; tests/kernel-knowledge-procedure-context.test.ts; generated tests/kernel-knowledge-procedure-context.test.mjs; C17 representation fixture 포함; schema/persistence 변경 없음
acceptance: AC-1 C17의 episodic_observation + practiceJson을 재사용하고 procedure 검색은 body를 제거한 metadata view로 기존 relevance를 계산한 뒤 최종 선택된 본문만 렌더; validUntil 만료/invalid, superseded, changedPaths 범위 밖 procedure를 fail-closed 제외하고 procedure body 크기도 기존 stage budget에 포함. AC-2 모든 procedure를 always-loaded prompt에 넣지 않고 기존 FRAME/EXECUTE stage policy + scope/relevance/budget을 재사용; 새 procedure type/vector DB/service/persistence API/migration 없음. AC-3 typecheck, build, build:tests, focused context/freshness/validator 20/20, build:check, build:tests:check, check:boundaries 통과. AC-4 STATUS/checkpoint에 변경·증거·W4 종료 기록
checks: typecheck c1800000-0000-4000-8000-000000000006 exit 0; build c1800000-0000-4000-8000-000000000007 exit 0 (294 files, 787 edges); build:tests c1800000-0000-4000-8000-000000000011 exit 0 (273 tests, 8 helpers); focused c1800000-0000-4000-8000-000000000012 exit 0 (20/20; 이전 c180...010의 19/20은 stale count fixture 기대값 오류로 제품 변경 없이 수정); build:check c1800000-0000-4000-8000-000000000014 exit 0; build:tests:check c1800000-0000-4000-8000-000000000015 exit 0; check:boundaries c1800000-0000-4000-8000-000000000016 exit 0; complexity/diff c1800000-0000-4000-8000-000000000017 exit 0; W4 scoped digest c1800000-0000-4000-8000-000000000018 exit 0
liveEval: 미실행; deterministic knowledge context/retrieval 경계
remaining: W4 없음
nextCard: C19 (W5는 별도 사용자 요청 후 시작)
```

```text
card: C19
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: e308be9657c66ecaf79395f18ea7de50e9521248
resultHeadOrDiffDigest: sha256:6e8d5c97c2f778d292d903d07e06565ae5a360eb5b7d811f6a1b64a71639bbaf
taskId: 04ed9258-e981-48be-afec-316313fe2861
kernelRunId: 없음; Kernel 모드 미사용
scope: src/kernel/knowledge/candidate-extract.ts; src/kernel/knowledge-ingestion/normalize.ts; tests/kernel-feedback-root-cause.test.ts; generated tests/kernel-feedback-root-cause.test.mjs
acceptance: AC-1 knowledge_gap/procedure_gap/verification_gap/stale_knowledge/known_failure/ambiguity/one_off 7종을 자연어 추측이 아닌 구조화된 source evidence signal로 분류; evidence 없는 주장과 상충 원인은 ambiguity로 fail-closed하며 explicit primary 하나일 때만 primary/secondary를 확정; user_instruction과 analysis_inference evidence refs를 별도 provenance로 보존. AC-2 feedbackClassification은 normalizeCandidate의 비권위 metadata로만 보존하며 proposedType/status/trust/promotion을 바꾸지 않음. AC-3 typecheck, build, build:tests, focused 12/12, build:check/build:tests:check 통과. AC-4 STATUS/checkpoint에 변경·증거·nextCard 기록
checks: typecheck c1900000-0000-4000-8000-000000000005 exit 0; initial focused c1900000-0000-4000-8000-000000000007 exit 1은 production build 전 stale generated runtime 때문; initial build c1900000-0000-4000-8000-000000000008 exit 1은 build 전용 noUncheckedIndexedAccess narrowing 2건으로 수정; final build c1900000-0000-4000-8000-000000000009 exit 0 (294 files, 787 edges); final focused c1900000-0000-4000-8000-000000000010 exit 0 (12/12); build/checks c1900000-0000-4000-8000-000000000011 exit 0 (294 files/787 edges; 274 tests/8 helpers); scoped digest c1900000-0000-4000-8000-000000000012 exit 0
liveEval: 미실행; deterministic feedback evidence classification 범위
remaining: C19 없음
nextCard: C20 (사용자 W5 요청에 따라 별도 task로 진행)
```

```text
card: C20
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: e308be9657c66ecaf79395f18ea7de50e9521248
resultHeadOrDiffDigest: sha256:0595b908cf0e9884a9d89562341a1b5add49a7e7dfc322d9a6516a2798b45f4b
taskId: e4aa5ad9-c861-4dbd-b2a4-ef74ef1aca04
kernelRunId: 없음; Kernel 모드 미사용
scope: src/kernel/knowledge/candidate-extract.ts; src/kernel/knowledge/candidate-review.ts; C19의 src/kernel/knowledge-ingestion/normalize.ts; tests/kernel-feedback-candidate-lifecycle.test.ts; generated tests/kernel-feedback-candidate-lifecycle.test.mjs; C19 root-cause fixture 포함; schema/DB/commit/finalization 변경 없음
acceptance: AC-1 knowledge_gap은 semantic_fact, procedure_gap/one_off는 episodic_observation, verification_gap은 required_verification의 observed/derived 보완 후보로만 연결; ambiguity는 needs_confirmation으로 후보 생성 안 함; known_failure는 같은 project/scope의 단일 existing known_failure_pattern만 reuse; stale_knowledge는 같은 project/scope의 단일 existing target을 supersedes하는 correction candidate만 생성. candidate identity는 project/source identity/source revision/cause/statement/scope/target에 결정적으로 묶여 같은 feedback source/revision 재입력의 중복 semantics를 방지. stale supersession proposal은 기존 candidate review의 persisted verification을 통과한 뒤에만 생성되어 기존 promotion/commit gate를 우회하지 않음. AC-2 모든 complaint를 durable fact/policy로 만들지 않고 ambiguity/known_failure는 새 durable 후보 0; forged stale target의 cross-project/scope를 review에서도 fail-closed 차단; 새 Authority/workflow/DB/vector service/finalization 경로 없음. AC-3 typecheck, build, build:tests, C19+C20+기존 review/supersession/commit focused 17/17, build:check/build:tests:check/check:boundaries 통과. AC-4 STATUS/checkpoint에 변경·증거·W5 종료 기록
checks: initial C20 typecheck c2010000-0000-4000-8000-000000000006 exit 2는 correction DTO open-record index signature 누락으로 수정; final typecheck c2010000-0000-4000-8000-000000000007 exit 0; build c2010000-0000-4000-8000-000000000008 exit 0 (294 files, 789 edges); build:tests c2010000-0000-4000-8000-000000000009 exit 0 (275 tests, 8 helpers); focused c2010000-0000-4000-8000-000000000010 exit 0 (17/17); build:check c2010000-0000-4000-8000-000000000012 exit 0; build:tests:check c2010000-0000-4000-8000-000000000013 exit 0; check:boundaries c2010000-0000-4000-8000-000000000014 exit 0 (9 modules, 294 files, 789 edges); complexity/diff review c2010000-0000-4000-8000-000000000015 exit 0; W5 scoped digest c2010000-0000-4000-8000-000000000016 exit 0
liveEval: 미실행; deterministic feedback candidate/review lifecycle 범위
remaining: W5 없음
nextCard: C21 (W6는 사용자 별도 요청 후 시작)
```

```text
card: C21
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: f48e706a87ea8f13d682164f58a94e6e02d9808b
resultHeadOrDiffDigest: sha256:d1bd73418321d9bfc1d0f9e642d1562c0dd684df1a94761494a9ae1c9dee500e
taskId: f2f0e290-4226-4b01-a74c-0cf6ba6df582
kernelRunId: 없음; Kernel 모드 미사용
scope: src/kernel/knowledge/improvement-pair.ts; src/kernel/knowledge/candidate-extract.ts; src/kernel/knowledge-ingestion/normalize.ts; tests/kernel-knowledge-improvement-pair.test.ts; generated tests/kernel-knowledge-improvement-pair.test.mjs; persistence/schema/commit 변경 없음
acceptance: AC-1 correction candidate의 단일 candidate_json에 correctionId/project/source identity/source revision/scope/source evidence/mutation candidate/replay candidate와 ready/incomplete/invalid recovery state를 함께 저장; pairId는 correction/project/source/revision/scope로 결정되어 replay 후보가 늦게 준비돼도 동일 identity를 유지; 동일 candidate_id SQLite upsert로 partial→ready 복구 시 한 행만 유지. AC-2 mutation/replay 한쪽 누락은 incomplete로 기록되고 ready가 아니며 project/revision/scope mismatch는 invalid로 fail-closed; pair metadata 자체는 trust/promotion 권한을 부여하지 않음. AC-3 typecheck, build 295 files/791 edges, build:tests 276/8, C19~C21+review focused 19/19, build:check/build:tests:check/check:boundaries 통과. AC-4 STATUS/checkpoint에 변경·증거·nextCard 기록
checks: initial typecheck c2100000-0000-4000-8000-000000000005 exit 0; final typecheck with tests c2100000-0000-4000-8000-000000000006 exit 0; build+build:tests c2100000-0000-4000-8000-000000000007 exit 0; focused c2100000-0000-4000-8000-000000000008 exit 0 (19/19); build/checks/boundaries c2100000-0000-4000-8000-000000000009 exit 0; complexity/digest c2100000-0000-4000-8000-000000000010 exit 0
liveEval: 미실행; deterministic pair identity/persistence 범위
remaining: C21 없음
nextCard: C22 (사용자 W6 요청에 따라 별도 task로 진행)
```

```text
card: C22
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: f48e706a87ea8f13d682164f58a94e6e02d9808b
resultHeadOrDiffDigest: sha256:19ea386a60d8d58ffa14c14551a26eec25c4a5155406f1d96cedfed56467f6f4
taskId: 5c1809ec-7898-4365-a4db-836f6c961d1d
kernelRunId: 없음; Kernel 모드 미사용
scope: C21 improvement-pair contract + src/kernel/knowledge/candidate-review.ts + src/kernel/knowledge/commit.ts + C20 candidate extraction/normalization 연결; tests/kernel-knowledge-improvement-promotion.test.ts 및 generated .mjs; persistence/schema/finalization/public surface 변경 없음
acceptance: AC-1 Improvement Pair는 ready 상태만 promotion 평가 대상으로 하며 replay obligation마다 현재 Run sourceIdentity+mutationRevision에 일치하는 persisted passed verification을 요구; missing/failed/stale/evidence mismatch replay는 pending으로 fail-closed. existing knowledge approval은 candidateId와 현재 pair snapshot approval digest에 묶이고 approvedBy가 scope owner와 일치해야 하며 owner revision/scope도 pair와 정확히 일치해야 함. rollback strategy가 필수이고 supersedes target 전체가 rollback target에 포함되어야 함. candidate-review에서 조건 미충족을 needs_approval/pending_verification/rejected로 노출하고 fresh replay만 verified evidence binding 및 supersession proposal을 생성. commitProjectKnowledge가 같은 gate를 재검증해 direct commit 우회를 차단하고 accepted candidate supersedes를 기존 knowledge transaction으로 전달하며 pairId를 transaction provenance에 기록. AC-2 임의 evaluation/status/score는 promotion 입력이나 권한으로 사용하지 않으며 persisted review/approval/verification을 우회하지 않음; 새 DB/schema/workflow stage/Authority/service 없음. AC-3 최종 typecheck/build/build:tests 통과, Knowledge+feedback 전체 회귀 74/74, build:check 295 files/793 edges drift 0, build:tests:check 277 tests/8 helpers drift 0, check:boundaries 9 modules 통과. AC-4 STATUS/checkpoint에 변경·증거·W6 종료 기록
checks: initial typecheck c2200000-0000-4000-8000-000000000005 exit 0; promotion tests typecheck c2200000-0000-4000-8000-000000000006 exit 0; build+build:tests c2200000-0000-4000-8000-000000000007 exit 0; focused initial c2200000-0000-4000-8000-000000000008 exit 0 (28/28); expanded focused c2200000-0000-4000-8000-000000000009 exit 0 (30/30); final typecheck/build/build:tests after approval binding c2200000-0000-4000-8000-000000000012 exit 0 (295 files/793 edges; 277 tests/8 helpers); final broad regression+drift+boundary c2200000-0000-4000-8000-000000000013 exit 0 (Knowledge+feedback 74/74; drift 0; 9 modules); complexity/digest c2200000-0000-4000-8000-000000000014 exit 0
liveEval: 미실행; deterministic persisted authority/replay promotion gate 범위
remaining: W6 없음
nextCard: C23 (W7는 사용자 별도 요청 후 시작)
```

```text
card: C23
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: 36543f71ea2425ee465a524d73f1cce429356d44
resultHeadOrDiffDigest: sha256:62ceda951ace5f52137f959584165f90de13be5becd494c78402ed0e33ebc58a
taskId: 5579da5d-2b37-470c-8b97-161849eabd9f
kernelRunId: 없음; Kernel 모드 미사용
scope: src/kernel/knowledge/capture.ts; tests/kernel-knowledge-cross-run-evidence.test.ts + generated .mjs; tests/kernel-guide-improvements.test.ts; persistence/candidate-review/commit/schema 변경 없음
acceptance: AC-1 기존 getProjectRunSignals(projectId, excludeRunId)를 그대로 사용하고 project+normalized scope+correction identity로 독립 Run evidence를 묶음. 같은 run의 retry/중복 signal/count는 supporting run 1개로 dedupe하며 failure/success resolution evidence를 각각 run 목록과 evidenceRefs로 보존. explicit stale/freshness=needs_deep_verify와 contradiction evidence를 group metadata에 노출. group은 episodic_observation + derived + observed + authority=episodic_only candidate만 생성하여 C23 자체 durable 승격 없음. AC-2 빈도/count는 truth/trust/promotion 권한으로 사용하지 않고 per-run reflection agent, 새 memory service/vector DB/저장 테이블 없음. AC-3 typecheck, production build 295 files/793 edges, test build 278/8, focused 33/33, Knowledge+feedback+guide 전체 94/94, build:check/build:tests:check drift 0, boundary 9 modules 통과. 최초 focused 실패 3건은 production generated capture.js 미갱신 원인으로 분류하고 npm run build 후 동일 범위 재검증 통과. AC-4 STATUS/checkpoint에 변경·증거·nextCard 기록
checks: typecheck+test build c2300000-0000-4000-8000-000000000007 exit 0; initial focused c2300000-0000-4000-8000-000000000008 exit 1 (stale production generated output, 구현 결함 아님); production build+focused c2300000-0000-4000-8000-000000000009 exit 0 (33/33); broad regression+drift+boundary c2300000-0000-4000-8000-000000000010 exit 0 (94/94; 295/793 drift 0; 278/8 drift 0; 9 modules); complexity/digest c2300000-0000-4000-8000-000000000011 exit 0
liveEval: 미실행; persisted deterministic cross-run evidence aggregation 범위
remaining: C23 없음
nextCard: C24 (사용자 W7 요청에 따라 별도 task로 진행)
```

```text
card: C24
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: 36543f71ea2425ee465a524d73f1cce429356d44
resultHeadOrDiffDigest: sha256:b6db0653fa6dd0811b51db8cd439d8397e1bfd6e96890c8f1daefb9942cc6490
taskId: 58a4ebb3-8653-4190-8330-df9406f658cf
kernelRunId: 없음; Kernel 모드 미사용
scope: src/kernel/knowledge/cross-run-evidence.ts 신규 pure module; src/kernel/knowledge/capture.ts 연결; src/kernel/knowledge/candidate-review.ts 기존 review gate 연결; src/kernel/knowledge/commit.ts direct commit 우회 차단 및 provenance 보존; tests/kernel-knowledge-cross-run-evidence.test.ts/.mjs, tests/kernel-knowledge-cross-run-promotion.test.ts/.mjs, tests/kernel-guide-improvements.test.ts; persistence/schema/finalization/knowledge-authority/public surface 변경 없음
acceptance: AC-1 repeat count/동일 run retry는 durable 권한이 아니며 project+scope+correction identity의 독립 run evidence만 group으로 유지. stale/needs_deep_verify/contradiction, scope 불일치, promotion basis 충돌, current-run fresh replay 부재 group은 episodic_observation으로 남고 candidate-review에서 decision=episodic으로 non-blocking 처리. 적격 group만 known_failure_pattern + 새 Improvement Pair 후보로 변환되며 기존 C22 approval/scope-owner/fresh persisted replay/rollback gate를 다시 통과해야 verified/supersession 가능. commitProjectKnowledge도 동일 cross-run structural eligibility와 기존 Improvement Pair gate를 재검증해 direct commit 우회를 차단하고 committed record에 crossRunEvidenceGroup provenance를 보존. AC-2 신규 memory service/vector DB/consolidation agent/DB table/schema/workflow Authority 없음. cross-run 관심사는 상태 없는 pure module로 분리해 capture.ts를 1088줄 임시 상태에서 544줄로 축소했고 persistence/knowledge-authority/finalization/public surface를 확장하지 않음. AC-3 최종 typecheck, production build 296 files/798 edges, test build 279/8, C23+C24+W6 focused 46/46, Knowledge+feedback+guide 전체 101/101, build:check/build:tests:check/check:boundaries 최종 compound 검증 exit 0. AC-4 STATUS/checkpoint에 변경·증거·W7 종료와 nextCard 기록
checks: typecheck c2400000-0000-4000-8000-000000000031 exit 0; build+build:tests c2400000-0000-4000-8000-000000000032 exit 0 (296 files/798 edges; 279 tests/8 helpers); final broad regression+drift+boundary c2400000-0000-4000-8000-000000000033 exit 0 (101/101; build/test drift check 및 boundary 포함); final diff/complexity/hardcoding review c2400000-0000-4000-8000-000000000034 exit 0; W7 scoped digest c2400000-0000-4000-8000-000000000035 exit 0. 중간 c240...027/029 typecheck 실패는 pure module 분리 중 TypeScript 문법 추출 오류로 수정 후 c240...031에서 통과
liveEval: 미실행; deterministic persisted cross-run evidence/promotion lifecycle 범위
remaining: W7 없음
nextCard: C25 (W8는 사용자 별도 요청 후 시작)
```

```text
card: C25
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: 14c61ca859082b9fffa909345185653b7ee23782
resultHeadOrDiffDigest: sha256:27250da5ccfc6ea9611053b8742103856c2b13112a3ad4ab0a94f23d7485a59a
taskId: 4f4b6ca4-22fb-452f-9d04-9a6691057386
kernelRunId: 없음; Kernel 모드 미사용
scope: src/host-tooling/kernel-eval/retrieval-eval.ts; tests/fixtures/kernel-retrieval-eval/corpus.json + baseline.json; tests/kernel-retrieval-eval.test.ts + generated .mjs; retrieval/freshness 정책 원본 변경 없음
acceptance: AC-1 retrieve=project/status SQLite authority query 반환 ID, injection=최종 context pack 포함 ID로 명시 분리. recall 분모=relevantIds, precision 분모=관찰 ID, stale miss 분모=staleIds+supersededIds이며 분모 0은 unavailable. context token은 promptBlock chars/4 deterministic proxy로 provider usage와 구분. cold=새 temp project/runtime 첫 build, warm=동일 입력 두 번째 build로 고정하며 latency 절대값은 환경 의존 informational-only. current source baseline을 저장하고 corpus digest에 결합. AC-2 query별 relevant/irrelevant/stale/superseded/project isolation 정답을 사전 고정하고 baseline 결과에 맞춰 수정하지 않음. 긴 context 투입은 recall만으로 개선 판정하지 않고 injection precision/token을 별도 기록. baseline: retrieve recall 1.0, retrieve precision 3/7=0.42857, injection recall 1.0, injection precision 3/6=0.5, stale miss 0/2=0, context token proxy 129. 세 case 모두 scoped irrelevant record가 주입되어 C26 단일 병목으로 확정. AC-3 typecheck/build/build:tests 통과, scorer focused 5/5, retrieval/context/freshness/procedure 19/19, build:check 297 files/799 edges drift 0, build:tests:check 280/8 drift 0, boundary 9 modules 통과. AC-4 STATUS/checkpoint에 변경·증거·nextCard 기록
checks: typecheck+build+build:tests c2500000-0000-4000-8000-000000000008 exit 0; baseline replay/write c2500000-0000-4000-8000-000000000009 exit 0; focused c2500000-0000-4000-8000-000000000010 exit 0 (5/5); context/freshness+drift+boundary c2500000-0000-4000-8000-000000000011 exit 0 (19/19; 297/799; 280/8; 9 modules); scope/digest c2500000-0000-4000-8000-000000000012 exit 0
liveEval: 미실행; deterministic local retrieval/context replay 범위
remaining: C25 없음
nextCard: C26 (사용자 W8 요청에 따라 별도 task로 진행)
```

```text
card: C26
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: 14c61ca859082b9fffa909345185653b7ee23782
resultHeadOrDiffDigest: sha256:a52d85f4d70453d89c2bce21b26cd6081563db3ea6e5bb187550c26b325f1589
taskId: baeec449-36dd-4077-a917-7282f4a39313
kernelRunId: 없음; Kernel 모드 미사용
scope: C25 fixed corpus/eval + src/kernel/knowledge/path-scope.ts의 query relevance predicate + src/kernel/knowledge/context-load.ts final injection gate; ranking score/storage/freshness/embedding/persistence/schema/public surface 변경 없음
acceptance: AC-1 C25 baseline의 단일 측정 병목인 scoped irrelevant injection만 수정. 기존 scoreRelevance의 trust/status ranking 점수는 그대로 두고 matchesKnowledgeQuery를 별도 pure predicate로 추가. scoped record에 changedPaths가 있으면 path scope match를 query authority로 우선하고, changedPaths가 없을 때만 statement/title/practiceJson semantic fields에 Unicode-safe objective lexical fallback을 적용; projectId/status/trust/scope 같은 authority metadata는 lexical corpus에서 제외. global/unscoped record의 기존 동작은 보존. context-load는 query_irrelevant를 omittedByPolicy로 기록한 뒤 기존 relevance score로 정렬하므로 ranking 교체 없음. 동일 C25 corpus before→after: retrieve recall 1.0→1.0, retrieve precision 3/7→3/7, injection recall 1.0→1.0, injection precision 3/6=0.5→3/3=1.0, stale miss 0/2→0/2, context token proxy 129→91. 각 case의 authority retrievedIds가 baseline과 완전히 동일해 project/status retrieval isolation 보존 확인. AC-2 ranking/storage/embedding 교체, 새 service/vector DB/cache/fallback/프로젝트별 조건문 없음. AC-3 최종 typecheck/build/build:tests 통과; C17/C18/context/freshness+C25/C26 focused 21/21; Knowledge 전체+C25/C26 84/84; build:check 297 files/799 edges drift 0; build:tests:check 280/8 drift 0; boundary 9 modules; 최종 C25/C26 focused 7/7 및 generated test drift 0. AC-4 STATUS/checkpoint에 변경·증거·W8 종료와 nextCard 기록
checks: initial implementation typecheck/build/build:tests c2600000-0000-4000-8000-000000000002 exit 0; initial focused c2600000-0000-4000-8000-000000000003 exit 1 (기존 19개 통과, 신규 2개 실패: lexical fallback이 projectId authority metadata와 negative objective term까지 매치하는 설계 결함을 발견); diagnostics c2600000-0000-4000-8000-000000000004~007로 path gate 정상/metadata false-positive 원인 확인; final typecheck/build/build:tests+focused c2600000-0000-4000-8000-000000000008 exit 0 (21/21); same-corpus before/after c2600000-0000-4000-8000-000000000009 exit 0; broad Knowledge+drift+boundary c2600000-0000-4000-8000-000000000010 exit 0 (84/84; 297/799; 280/8; 9 modules); complexity/hardcoding review c2600000-0000-4000-8000-000000000011 exit 0; final isolation assertion typecheck/build:tests/focused/build:tests:check c2600000-0000-4000-8000-000000000012 exit 0 (7/7; 280/8 drift 0); final W8 digest c2600000-0000-4000-8000-000000000013 exit 0
liveEval: 미실행; C25 fixed deterministic local retrieval/context corpus 비교
remaining: W8 없음
nextCard: C27 (W9는 사용자 별도 요청 후 시작)
```

```text
card: C27
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: d1c7a66e305c8894a5cc2470ae6ed9c3072f2709
resultHeadOrDiffDigest: sha256:43200083665f1b4b1cd3086fd3be21534168bc3a6cb2f0c8d59e021604d2598d
taskId: a9bb65e4-3213-4ab2-b66a-af54efc27a0d
kernelRunId: 없음; Kernel 모드 미사용
scope: src/host-tooling/kernel-eval/follow-up-eval.ts; tests/fixtures/kernel-follow-up-eval/protocol.json; tests/kernel-follow-up-eval.test.ts + generated .mjs; 제품 Kernel/Authority/schema/public surface 변경 없음
acceptance: AC-1 Verify-only/Always/Adaptive가 동일 F1 snapshot/task binding을 사용하도록 protocol revision과 F1 digest를 고정. F1 actor package에는 F2/F3 내용·digest·evaluator hidden path를 넣지 않으며 prompt/knowledge/fileSearch/log/actorPackage 표면을 hidden marker/digest/path로 음성 검사. cost는 wall time, 실제 provider token dimensions, changed files/LOC, rework, verification time, human intervention, failure/incomplete를 별도 단위로 유지하고 aggregate score를 금지. 실제 token usage 일부가 없으면 해당 차원 전체를 unavailable로 남김. authority/scope/task/revision/attempt budget 위반은 halt, isolation failure는 not_ready로 fail-closed. AC-2 같은 workspace hidden 파일은 blind로 인정하지 않고 actor visible root가 hidden root를 포함하거나 isolation mode가 enforced가 아니면 not_ready. 저장소에 실제 agent filesystem sandbox가 없으므로 새 fake runner를 만들지 않고 외부 filesystem allowlist/sandbox evidence를 요구. F1 freeze 후 F2 reveal, F2 freeze 후 F3 reveal만 허용하며 task/source revision mismatch를 차단. AC-3 initial typecheck 실패 1건(nullable usage accumulator) 수정 후 typecheck/build/build:tests 통과; C27 focused 6/6; eval corpus/routing/retrieval/sentinel+C27 28/28; build:check 298 files/799 edges drift 0; build:tests:check 281/8 drift 0; boundary 9 modules; diff/범위/하드코딩 검사 통과. AC-4 STATUS/checkpoint에 변경·증거·nextCard 기록
checks: initial typecheck c2700000-0000-4000-8000-000000000006 exit 2 (nullable accumulator TS18047, build 미실행); corrected typecheck/build/build:tests c2700000-0000-4000-8000-000000000007 exit 0 (298/799; 281/8); focused c2700000-0000-4000-8000-000000000008 exit 0 (6/6); broad eval+drift+boundary c2700000-0000-4000-8000-000000000009 exit 0 (28/28; 298/799; 281/8; 9 modules); scope/digest c2700000-0000-4000-8000-000000000010 exit 0
liveEval: 미실행; C27은 deterministic protocol/readiness 검증 범위이며 실제 Codex actor 실행은 C28
remaining: C27 없음
nextCard: C28
```

```text
card: C28
status: EVAL_PENDING
workspace: /shared/moonshot-relay
baseHead: d1c7a66e305c8894a5cc2470ae6ed9c3072f2709
resultHeadOrDiffDigest: sha256:addca1c1a295c91388a8e59e4fa47fd8a168d280e094255b16cfde6c66be3533
taskId: 9a9f0c54-8dd0-40de-95b4-f5b9784e7b54
kernelRunId: 없음; Kernel 모드 미사용
scope: 제품 소스 변경 없음; LOCAL_CODEX_VALIDATION.md에 C27 protocol 기반 W9 local Codex actual-run 절차, receipt schema, stop condition, resume cursor, C28 완료 조건 추가
acceptance: AC-1 원격 actual 실행 미수행. 현재 Moonremote 환경에는 codex executable과 OPENAI_API_KEY가 없고 C27이 요구하는 enforced filesystem isolation을 제공할 bwrap/firejail/docker/podman도 없음. 따라서 동일 baseline 세 전략의 correctness/follow-up cost/과도 수정/회귀 actual evidence를 만들 수 없어 EVAL_PENDING. mock/static result로 actual cost를 대체하지 않음. 로컬 절차는 동일 F1 snapshot/model/profile/effort/tools, F1 freeze→F2 reveal→F2 freeze→F3 reveal, failed/incomplete 포함, stage별 diff/verification/actual usage receipt를 요구. AC-2 strategy×case×F1/F2/F3 한 배치와 resume cursor를 고정하고 완료 stage 재실행 금지. AC-3 readiness command의 실제 receipt로 원격 미지원 상태 확인; C27 deterministic 검증은 C28 live 결과로 계산하지 않음. AC-4 STATUS/checkpoint에 blockers와 로컬 검증 경로 기록
checks: remote live capability c2800000-0000-4000-8000-000000000002 exit 0: codex absent, OPENAI_API_KEY absent, CODEX_HOME present, bwrap/firejail/docker/podman absent
liveEval: 미실행; 로컬 Codex + enforced blind filesystem isolation 필요
remaining: 로컬 Codex에서 C28 actual strategy×case×F1/F2/F3 receipts 수집 후 C28 재개. C29는 C28 전체 결과 전까지 시작 금지
nextCard: C28 재개; C29 자동 진입 금지
```
