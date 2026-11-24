# Moonshot Relay Codebase-First 하네스 개선 — 확정 전략 v3 (Freeze)

- 확정일: 2026-11-24
- 상태: **전략 Freeze / W0·개발·최종 평가 미착수**
- 범위: **Track A — moonshot-relay 자체 변경**, Track B는 격리된 외부 fixture의 호환성 평가만
- 실행계획: [PLAN.md](PLAN.md)
- 실제 기준선: W0에서 로컬 `before_sha`를 확인한 뒤 확정한다. 문서 작성 당시 관측 `c5f09ccea53f148ba570dca4bdfe527058cde170`은 후보일 뿐이다.

## 1. 목표와 변경하지 않을 계약

더 큰 감사·계획·검증 시스템을 만들지 않고, **실제 모델에 전달되는 지침, 관리 턴, 코드 탐색과 검증 비용**을 감소시킨다. Work/Trust/Knowledge의 의미, Completion Authority, fresh evidence, 사용자 기능 및 설치 표면은 보존한다.

- 모델-visible 공개 명령은 기존 `kernel next / kernel report` 중심으로 유지한다. 강제 Plan/TDD/Review/Score/Finalize 명령이나 workflow stage를 추가하지 않는다.
- 프로젝트 전용 지식·검증 규칙을 Kernel 조건문/하드코딩으로 만들지 않는다. 현재 source owner·기존 검사기·테스트·정말 필요한 최소 prose 순으로 문제를 해결한다.
- 과거 안전 제약 `HOLD_SAFE`, `DEFER`, Native Writer 소유권·승인·범위 보호를 최적화 명목으로 우회하지 않는다.
- DB/Queue/Scheduler/별도 Policy Engine, 검증용 제품 기능, semantic response cache, 외부 런타임 스킬 대량 도입은 비목표다.
- 추적된 source를 `.gitignore`에 추가해 숨기지 않는다. `.claudeignore`·`rg` ignore는 탐색 힌트이지 보안 경계가 아니다.
- 사용자의 `main` 더티 파일, account-root/global runtime, 무관한 Host-owned Worker 작업을 수정하지 않는다.

## 2. 고정된 의사결정과 근거

### 실험·실행 분리

**중간 Golden Task 에이전트 평가: 0회.** B1a→B2a→C→B1b→B2b→D→S6의 각 구현 단위는 정적·결정론적 검사만 실행한다. 전체 구현 후 최종 `Before vs After` 평가를 한 번만 실시한다.

이는 '개발용 AI 세션 0회'가 아니다. 정적 검증도 시간과 컴퓨팅 비용을 사용한다. 중간 평가를 없애 원인 귀속이 어려워지는 문제는 **변경 단위별 커밋 경계**와 실패 시의 국소 원인 분석으로 해결한다.

### 역사적 증거는 재조사하지 않는다

- [2026-10-19 prompt diet](../../reference/prompt-diet-keep-baseline-2026-10-19.md): 과거 기준선 12/12, compact 11/12 및 범위 위반/재작업. 긴 prompt가 반드시 필요하다는 증거도, 짧을수록 좋다는 근거도 아니다. 현재 방어가 확인될 때만 위험한 삭제를 허용한다.
- [2026-11-20 prompt surface audit](../../reference/prompt-surface-audit-2026-11-20.md): 요청에 실제 로드된 프롬프트 표면과 파일 목록을 구분한다.
- [Decomplexification](../../../decomplexification/kernel-authority-refactor-status.md) 및 `B0~B12`: 중복 권위·Keep·이동 이력에 관한 **역조회** 자료이며 현재 동작을 대신하는 증거가 아니다.
- [Host-owned Worker 별도 작업](../host-owned-worker-context-continuity-2026-11-03/PLAN.md): 그 작업의 Writer 보호 및 HOLD_SAFE/DEFER 판정은 본 문서의 실험 통과 여부로 변경되지 않는다.

W0는 과거 문서 전수 감사 대신 **활성 요청 → 실제 Host/Provider dispatch → Kernel next/report → prompt builder → verification consumer → Completion** 경로만 먼저 추적한다.

## 3. 작업 순서

| 순서 | 개선 단위 | 변경 범위 | 제거 또는 유지 판정 |
| --- | --- | --- | --- |
| W0 | Top-Down 활성 경로·기준선 | 읽기 전용 조사·Golden-PR oracle 선정 | `before_sha`, 평가 환경, 지원 표면 고정 |
| B1a | 구조 무의존 Prompt 삭제 | 현재 코드에서도 무해한 중복 prose 및 일반 방법론 | 실제 model-visible 감소, 안전 계약 보존 |
| B2a | 관리 턴 경량화 | 중복 상태 조회·분류·불필요한 일반 리뷰 | Work/Trust/Knowledge 권위 유지 |
| C | 코드 구조·탐색 정리 | Canonical API/wrapper/generated boundary/검색 노이즈 | import·generator·package·설치 소비자 유지 |
| B1b | C 이후 연동 Prompt 삭제 | 구조 개선으로 불필요해진 안내 prose | C에 의존하는 삭제만, 근거 남김 |
| B2b | 검증 실행 경량화 | 중복 proof/script/receipt 실행 | 필수 의무·freshness·결정 계약 유지 |
| D | 기존 진단 개선 | 실제 누락된 오류의 기존 compiler/lint/boundary 진단 | 불필요하면 `NO_CHANGE`; 도구 추가는 예외 |
| S6 | Host prompt/cache | stable prefix, volatile tail, provider usage | 모델·권한·cache semantics 보존 |
| Final | Before/After 통합 | 고정 Golden-PR 6개 × 양쪽 HUT | Outcome 우선, trace 및 총비용 동시 비교 |

B2a와 B2b는 **원인과 롤백 경계가 다르다**. D는 도구 도입 단계가 아니다. 구조 정리 C를 먼저 완료한 다음 B1b와 B2b를 수행한다. 각 단위는 의미적으로 분리된 커밋 또는 작은 커밋 묶음이며, 불필요한 변경에는 빈 커밋을 만들지 않는다.

## 4. 작업공간·HUT·Fixture 경계

- `main`은 읽기 전용. W0에서 깨끗한 `before_sha`를 정하고, 별도 브랜치·`git worktree`에서 문서/개발·검증한다.
- B2a/C와 기존 Host-owned Worker의 `dispatch/writer` 변경이 겹치면 **파일 충돌·선행 변경 정착**을 먼저 확인한다. 필요한 경우 기준선을 함께 재고정한다. 서로 다른 parent를 숨긴 채 1:1 비교하지 않는다.
- **HUT (Harness Under Test)**: Before/After 각 SHA에 대응하는 Relay launcher/package/install payload.
- **Task Fixture**: 과거 작업의 부모 또는 해당 과제 시작 커밋에 고정한 **동일한** disposable 프로젝트 checkout. Track A 셀프호스팅 과제도 HUT와 별도 checkout을 사용한다.
- **Oracle**: 에이전트에게 숨긴 독립 acceptance/회귀/안전 채점기. 사전 고정하고 후보 코드에 맞춰 기대값을 조정하지 않는다.
- Track B는 승인·격리된 외부 fixture만 사용하며 실제 앱·사용자 데이터는 수정하지 않는다.
- 중간 설치 검사도 임시 `HOME`, provider home, install root에서 수행한다. 경로 격리가 검증되지 않은 installer는 실계정에 실행하지 말고 해당 surface만 `NOT_RUN`으로 기록한다.

### Golden-PR Replay — 6개 고정 과제

| ID | Track | 유형 | 독립 오라클 |
| --- | --- | --- | --- |
| `A-F1` | A | 기능 추가 | 실제 동작과 호환성 |
| `A-R1` | A | 리팩토링 | 행동 동등성·중복 권위/코드 없음 |
| `A-S1` | A | 권한·상태 | 소유권·범위·승인·fresh evidence |
| `A-D1` | A | 문서/설정 | Canonical source→generator→package/install |
| `B-B1` | B | 외부 프로젝트 단순 버그 | 재현 오류 해결·기존 테스트 |
| `B-F1` | B | 외부 프로젝트 기능 | acceptance·`required_verification` |

W0에서 과거 실제 PR/이슈의 `parent_commit`, 시작 fixture와 digest, 입력, 숨긴 oracle, timeout·예산, 정확한 provider 모델 ID/가능하면 immutable snapshot, effort, 반복할 핵심 과제 1~2개를 **결과를 보기 전에** 고정한다. 원래 성공한 PR의 결과가 oracle을 통과하는지 확인하고, 버그 과제는 시작점의 실패를 재현한다. 6개는 작은 회귀 고정 세트이지 통계적으로 일반화하는 벤치마크가 아니다.

**인과 경계:** 동일 fixture의 HUT Before/After 결과는 하네스 변경의 통합 효과다. C가 실제로 변경한 **대상 Relay 코드베이스 자체**의 navigability 개선은 별도 정적 탐색·구조 diff로 보고한다. C 성과와 통합 HUT 효과, S6 단독 캐시 절감을 혼동하지 않는다.

## 5. 구현 중 네 개의 결정론적 Gate

각 구현 단위에서 현행 명령/소비자를 먼저 찾고 아래 네 가지를 확인한다.

1. **컴파일/정적 계약:** 현재의 typecheck·lint·boundary·필수 CI 체크. 존재하지 않는 명령을 추가로 강제하지 않는다.
2. **기존 단위·통합·계약 테스트:** Work/Trust/Knowledge, Completion, source identity, write ownership 등 변경 영향에 필요한 검증. 원격 LLM 에이전트 평가를 중간에 실행하지 않는다.
3. **실제 제품 표면:** source→generator→package→임시 install→discovery→runtime. Account-root 보호. 기본 테스트와 일치하는 지원 surface만.
4. **Wire prompt dry-run:** 실제 Host builder의 byte/digest/가능한 token 변화와 tool schema 정렬 확인. 실모델 호출이나 cache hit를 통과한 것처럼 기록하지 않는다.

결정론적 필수 Gate가 실패하면 해당 변경의 원인을 해결한 다음 의존 단위로 진행한다. 미실행은 `NOT_RUN`, 실익 없는 변화는 `NO_CHANGE`다. 테스트 기대값 변경으로 회귀를 은폐하지 않는다. 중간 scorecard, 별도 평가 DB, 강제 리뷰, 새 감사 엔진은 만들지 않는다.

### Anti-bloat 순서

반복 문제가 나오면 **코드/API 구조 → 기존 검사기 진단 → 필요한 회귀 테스트 → 최소 prose** 순으로 해결한다. 신규 분석기는 기존 검사기로 잡지 못한 동일 결함이 서로 독립된 실제 작업에서 2회 재현된 경우에만 고려한다. 다만 심각한 보안·데이터 손실 문제는 반복을 기다리지 않고 기존 신뢰 경계에서 차단한다. '새 1줄마다 기존 1줄 삭제' 같은 형식적 quota를 두지 않는다.

## 6. 최종 Before/After — 한 번의 통합 평가

- `before_sha`와 `after_sha`로 **별개 HUT 설치**를 만들고, 여섯 fixture·oracle·모델/effort·권한·budget·timeout·캐시 조건을 동일하게 고정한다.
- 기본 **12번**(6개 × 2버전), 사전 선정한 핵심 1~2개에 한하여 양쪽 각 1회 추가(총 14~16번). 최종 결과를 보고 반복 과제를 바꾸지 않는다.
- 모델이 만든 커밋과 staged/unstaged/untracked/삭제/권한/링크 변경을 **빠짐없이 수집**한다. 단순 `git diff`로 처리하지 않는다.
- 전체 solution 변경만 깨끗한 Task Fixture에 재적용하고 평가자 소유의 held-out oracle을 실행한다. 후보가 수정한 테스트를 독립 정답으로 인정하지 않는다.
- **Outcome Hard Gate:** 실제 기능 결과, 기존 회귀, 권한/범위 위반 0, fresh evidence, required review·승인, supported install surface. 비용 절감으로 실패를 상쇄하지 않는다.
- **Trajectory:** turns, admin_calls, search_calls, verify_runs, rework_count 및 원본 trace 참조.
- **Cost/Speed:** input/output, provider raw cache-read/write/uncached, 실제 총비용 및 wall-clock, 가능한 경우 TTFT. 미지원 값은 0이 아닌 `null`이다.
- `final-before-after.json`의 각 `runs[]`에는 `trace_ref` 및 nullable `trace_summary: {turns, admin_calls, search_calls, verify_runs, rework_count}`를 둔다. 원본 trace를 중복 복제하지 않는다.
- 정확한 model snapshot·cache 상태가 고정되지 않으면 교란 가능성을 기록하고 모델 효과를 HUT 효과로 단정하지 않는다. `S6` 단독 효과를 통합 절감분으로 주장하지 않는다.

최종 After가 전부 PASS이고 **측정 가능한 총비용/시간 또는 관리 비용 개선**이 확인되면 종료한다. After-only 실패 시 환경/fixture/oracle 문제와 결정론적 코드 회귀·비결정적 에이전트 행동을 먼저 분리한다. 결정론적 회귀에만 커밋 경계 `git bisect`를 사용한다. 확률적 실패는 단일 `bisect run` PASS/FAIL로 원인 확정하지 않으며 해당 과제의 최소 재현을 수행한다. C↔B1b 등 의존 커밋은 원인 수정 또는 **안전한 연동 롤백**을 적용한다.

## 7. 판정·산출물·Stop Rule

| 상태 | 의미 |
| --- | --- |
| `COMPLETE` | 본 작업의 필수 기능·안전·지원 surface가 검증됐고 비교 가능한 효율 개선 확인 |
| `PARTIAL` | 일부 구현·검증은 완료했지만 전체 수용 불가 |
| `HOLD_SAFE` | Writer/보안/승인 보호 경계에 의해 해당 작업만 차단 |
| `DEFER` | 외부 인증·권한·지원 capability 없음 |
| `NOT_RUN` | 평가 fixture 또는 실행 환경 미확보로 검증 미실행 |
| `NO_CHANGE` | 변경 필요성·이익이 확인되지 않음 |

- W0 산출물 상한: `W0-active-path.md`, `W0-golden-tasks.json`, `W0-baseline-manifest.json` (실제로 필요할 때만).
- 구현: B1a~S6 의미 단위 커밋, 기존 테스트 결과와 증거. 중간 에이전트 평가 문서는 없음.
- 최종: `final-before-after.json`, 필요할 때만 `FINAL-RESULT.md`.
- **Stop Rule:** 전체 필수 Hard Gate와 실제 Outcome이 충족되고 비용/작업 부담 개선이 입증되면 추가 대시보드·검사·규칙 없이 종료한다. 미실행은 PASS가 아니다. 전략을 다시 v4로 늘리지 않는다.

## 8. 원문·관련 SOT

- [개발/검증 SOT](../../development.md), [소스·설치 경계](../../repository-layout.md), [실행계획](PLAN.md)
- LangChain, [Improving Deep Agents with harness engineering](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering)
- Anthropic, [Demystifying evals for AI agents](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)
- Future AGI, [Evaluating Coding Agents in 2026](https://futureagi.com/blog/evaluating-coding-agents-2026/)
- [SWE-bench evaluation harness](https://github.com/SWE-bench/SWE-bench/blob/main/docs/reference/harness.md)
- UK AISI, [Inspect AI Agents](https://inspect.aisi.org.uk/agents.html) · [Sandboxing](https://inspect.aisi.org.uk/sandboxing.html)
- Arena, [HarnessTax](https://arena.ai/blog/coding-agents-harness-tax)

외부 사례는 검증 방법 선택의 참고이며 해당 수치를 Moonshot에서 실측했다고 주장하지 않는다.
