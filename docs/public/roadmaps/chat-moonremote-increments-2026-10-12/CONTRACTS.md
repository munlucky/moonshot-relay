# 유지할 네 계약

이 문서는 구현 요구사항이다. 새 Authority, 새 공개 명령, 새 workflow stage를 생성하는 명세가 아니다.

## P. Prompt Profile Contract

공통 의미: objective, acceptance criteria, current work unit, allowed/forbidden scope, relevant project knowledge, required verification, available tools, risk/mutation authority, completion condition.

기존 필드와 먼저 매핑한다. 공통 의미 원본은 하나다. Host는 provider renderer와 작은 capability delta로 표현한다. 최소 provider renderer 수를 유지한다. generic OpenAI와 Codex의 차이는 실행 surface와 capability에서 구분한다. 모델별 prompt 전체 복제본, Kernel 내부 모델명 조건문을 추가하지 않는다.

Host system/developer instruction 권한, tool result와 knowledge의 낮은 신뢰도, 사용자 데이터 경계를 보존한다. XML 태그나 문서 내용이 새 권한을 만들 수 없다.

### P 평가

C01에서 baseline/model/surface/effort/tool set/corpus digest와 비용 한도를 고정한다. 최소 6 cases, case별 old/new 각각 2회 규칙은 모델-backed 비교 계약으로 유지한다. 실제 운영 surface는 Codex다. Moonremote/CI는 provider credential 또는 Codex CLI를 필수 전제로 삼지 않고 deterministic contract, serialization, routing, scope, hardcoding, authority, boundary, regression을 검증한다.

로컬 Codex gate: C01의 동일 6 cases를 old/new 각각 2회 실행하고 순서를 교차하며 동일 격리 workspace 상태를 사용한다. task success와 acceptance 만족이 baseline보다 낮지 않고 scope violation/hardcoding/regression이 증가하지 않아야 한다. critical authority 위반은 1건이어도 실패다. unsupported assumptions·extra files·fallback/abstraction growth도 사전 rubric으로 검토한다. 평가 판단 근거는 source diff와 로컬 receipt에 연결한다.

효율 gate는 로컬 Codex 모델-backed 검증에서 판정한다. 사전에 선택한 하나 이상의 metric에서 개선이 있어야 한다. 초기 제안값은 불필요 tool/subagent/중복 검증 횟수 1회 이상 감소 또는 총 token/latency 중앙값 10% 이상 감소다. cache read ratio는 동일 eligible/warm 조건에서만 비교한다. 실제 usage가 없는 token/cache metric은 unavailable, 추정 token은 estimated로 기록한다.

기록할 항목: task success, acceptance, unnecessary tool/subagent calls, 불필요한 clarification-before-action, unsupported assumptions, scope expansion, extra file creation, fallback/abstraction growth, hardcoded solutions, verification duplication, input/output/reasoning/cached tokens, latency, completion rate. 필요한 clarification은 불필요 호출로 점수화하지 않는다.

Claude/OpenAI standalone surface는 현재 운영 필수 live gate가 아니다. 해당 surface를 실제 운영에 채택할 때 provider-specific live 평가를 다시 연다. mock/정적 분석을 실제 비용 개선 증거로 기록하지 않는다. 원격 구현 완료와 로컬 Codex 모델-backed 릴리스 검증을 구분한다.

캐시 source 확인: 안정된 prefix와 실제 재사용 가능 경계는 구분해야 한다. 모델/모드별 breakpoint·최소 길이는 Host capability에 따른다. [OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)

Claude의 최소 구현/하드코딩 억제 지침은 짧게 적용하고 효과를 평가한다. 본 계획은 특정 최신 모델의 성향을 검증 없이 일반화하지 않는다. [Claude Prompting Best Practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)

## F. Futures Assessment Contract

입력은 run/work unit identity, source revision/content digest, scope, deterministic evidence, 기존 obligation, 필요한 review다. 출력은 assessment revision, Green/Yellow/Red, 근거, 미확인 요소, restore/escalation 후보다.

- Green: 기존 obligation을 충족시키는 경로를 유지한다.
- Yellow: 행동 보존과 범위가 증명 가능한 restore 후보를 제안한다.
- Red: 구조 의사결정이 필요한 기존 architecture-planning 경로에 연결한다.
- 증거 누락/상충/unknown: Green으로 간주하지 않는다. 미확인 상태와 추가 요구를 보존한다.

색상과 기준은 C13에서 fixture로 고정한다. 모델의 자유 문장만으로 색상을 확정하지 않는다. assessment는 read-only다. 실행 범위 확대·지식 승격·completion을 직접 쓰지 않는다. Work는 작업 진행을, Trust는 증거와 review의 freshness를 판단한다. 재검토 receipt는 같은 source revision과 scope에 묶인다.

Restore는 행동 불변식·허용 경로·종료 기준이 있는 bounded work unit이다. restore 후 diff가 바뀌면 이전 proof를 새 proof처럼 사용하지 않는다. 범위가 커지면 기존 architecture handoff로 넘긴다.

## I. Improvement Pair Contract

한 correction identity에 source feedback/evidence, root cause, knowledge/procedure mutation 후보, replay/regression 후보, project/scope/revision을 묶는다. 기존 저장 transaction과 lifecycle을 재사용한다.

필요한 논리 상태는 후보 준비→검토/재현 준비→승격 가능/거부다. 이것을 새 전역 workflow stage로 만들지 않는다. 일부만 성공하면 pair는 승격되지 않는다. 같은 source/correction 재입력은 중복 효과를 만들지 않는다.

승격은 fresh replay, 기존 review/approval, scope owner, supersession/rollback 정보를 요구한다. one_off와 ambiguity는 자동 durable 정책으로 올리지 않는다. 반복 관찰은 후보 생성 근거이며 Trust를 대체하지 않는다.

## E. Follow-up Evaluation Contract

같은 F1 시작 상태에서 Verify-only, Always, Adaptive를 비교한다. F1 구현자는 F2/F3 입력에 접근할 수 없어야 한다. evaluator의 별도 파일/권한/실행 context로 차단한다. 공개 digest만으로 hidden 내용이 유출되지 않도록 입력 자체는 별도 영역에 둔다.

F1을 고정한 뒤 F2를 공개하고 검증한다. F2 결과를 고정한 뒤 F3를 공개한다. task 완료 시점, 변경 diff, correctness, 검증 범위, 모델 usage와 사람 개입을 기록한다. 동일 model/profile/effort/tool 조건을 유지한다.

Follow-up Change Cost는 단일 임의 점수로 합치지 않는다. F2+F3의 실행 시간, 실제 token 비용, 변경 파일/LOC, 재작업, 검증 시간, 실패율을 각각 보고한다. F1 투자 비용과 총비용도 함께 보고한다. 성공하지 못한 case를 비용 평균에서 제외하지 않는다.

정확성과 scope를 먼저 통과해야 비용을 비교한다. adaptive의 이득이 없거나 불확실하면 기존 정책을 유지한다.

## 공통 Complexity Budget

새 공개 Kernel command 0, workflow stage 0, Authority 0, always-on agent 0, execution class 0, memory service 0, vector DB 0, Kernel 모델/프로젝트 하드코딩 0, per-run reflection agent 0, 모델별 전체 prompt fork 0.

기존 4개 execution class를 유지한다. 새 데이터 필드가 필요하면 기존 계약에 최소 추가하고 source schema와 생성 타입을 함께 검증한다. generic procedure도 기존 타입으로 표현 불가능할 때만 추가한다.
