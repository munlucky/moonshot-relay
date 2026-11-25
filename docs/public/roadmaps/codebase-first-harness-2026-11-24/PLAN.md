# Moonshot Relay Codebase-First — 실행계획 (W0 → 최종 수용)

- 작성일: 2026-11-24
- 상태: **착수 준비 문서 / W0 실행 결과 아님**
- 확정 정책: [STRATEGY.md](STRATEGY.md) — v3 Freeze. 본 계획은 전략을 수정하거나 새로운 워크플로우를 도입하지 않는다.
- 코드 대상: `/shared/moonshot-relay`의 canonical TypeScript `src/`; 실제 산출물·소비자는 시작 시 다시 확인한다.
- 문서 준비 기준 commit: `c5f09ccea53f148ba570dca4bdfe527058cde170`에서 분기. **이는 실험 `before_sha`를 확정한 것이 아니다.**
- 실행 상태: SOT/전략/계획 문서 작성과 W0 이후 실제 개선 개발·평가를 구분한다.

## 0. 사용자 수용 조건과 프로젝트 불변식

**최종 제품 수용:** 같은 실제 개발 과제에서 Relay가 정확하게 동작하고, 더 적은 model-visible 지침·관리 턴·불필요한 검증·탐색 비용으로 같거나 높은 기능 완료율, Trust/Knowledge 신뢰성 및 비용 효율을 입증해야 한다.

- 기능·권한·범위·승인·source identity/fresh evidence·Completion Authority는 비용/속도로 상쇄 불가.
- 기존 Work/Trust/Knowledge만 권위를 소유. provider별 routing/cache, worktree, 프로세스, Git, 설치는 기존 Host 책임.
- `kernel next / kernel report` 모델 공개 인터페이스 유지. 신규 DB/Queue/Scheduler/Policy Engine/Score Engine/강제 Skill·Review 도입 금지.
- Track A 코드만 변경. 외부 Track B는 disposable 과제 fixture만 평가. 실제 account-root/global runtime 변경 금지.
- 현재 `main`의 미추적 `docs/public/roadmaps/kernel-worktree-continuity.ko.md`는 **별개 작업 소유**이며 보존. 기존 Host-owned Worker checkpoint/Writer HOLD_SAFE/승인 DEFER를 이 계획이 해제하지 않는다.
- 각 개발 단위에 대한 **Golden Task LLM 평가 호출 = 0**. 구현 중에는 기존 deterministic gate만, 전체 구현 이후 `Before vs After` 한 번.
- 코드 변경은 원인이 증명된 최소 변경만. `NO_CHANGE` 허용. 전략 재개정, 매 단계 거대한 감사/보고서, 상태 조회 전용 관리 루프 불필요.

## 1. 저장소 SOT·증거 우선순위

| 구분 | Authority | 용도 |
| --- | --- | --- |
| 코드·빌드 소유 | `AGENTS.md`, `src/`, `package/source-layout.json`, `docs/public/development.md` | 실제 수정 경계, 명령, generated-file 계약 |
| 현재 구현/실행 | W0에서 확인한 실제 Host→Kernel call path, installer, tests | 현재 사용 여부를 증명 |
| 확정 개선 전략 | [STRATEGY.md](STRATEGY.md) | **무엇을/왜** 변경·비교하는가 |
| 실행 작업 | 본 `PLAN.md` | **어떤 순서/어떻게 검증**하는가 |
| 과거 사례 | `prompt-diet-keep-baseline`, `prompt-surface-audit`, `docs/decomplexification/B0~B12` | 필요할 때만 현재 활성 항목의 Keep 이유 역조회 |
| 독립 승인·안전 | 기존 Work/Trust/Knowledge 및 Host-owned Worker 상태 | 범위·승인·Native Writer 경계. 본 계획으로 덮어쓰지 않음 |

이 계획은 코드 변경을 위해 `main`을 수정하도록 지시하지 않는다. 현재 문서 전용 worktree와 이후 개발 worktree는 별개일 수 있다. **W0의 실험 Before는 문서 SOT 변경이 반영된 상태와 다른 작업의 선행 변경 정착 여부를 확인한 뒤 새로 고정**한다. 문서 반영 전 HEAD를 근거 없이 `before_sha`로 고정하지 않는다.

## 2. 사전 준비·독립 작업공간

1. `main`의 HEAD/working tree/활성 작업을 **읽기 전용** 확인한다. 무관한 미추적 파일을 stash/reset/clean/commit하지 않는다.
2. 기준 commit에 docs(SOT) 반영 여부와 Host dispatch/writer 겹침 여부를 확인한다. 정착되지 않은 변경에 의존하는 개선은 보류한다. baseline이 바뀌면 `before_sha`와 평가 HUT도 함께 고정한다.
3. **깨끗한 기준 commit**에서 별도 기능 브랜치·전용 worktree를 만든다. W0는 main 직접 수정 금지, Golden Task는 HUT와 다른 disposable worktree.
4. 설치 테스트는 실제 account-root가 아닌 임시 `HOME`, `MOONSHOT_RELAY_HOME`, 각 provider home, install root에서만 수행한다. CLI가 암묵적으로 실계정을 읽거나 쓰는지 확인하기 전 실설치 금지.
5. 검증 전 baseline 변경·모델/effort 변경·fixture 변경은 별도로 기록하고 기존 비교 조건을 조용히 덮어쓰지 않는다.

### 시작 시 읽기 전용 명령

실제 Repository Root에서:

```bash
pwd
git rev-parse --show-toplevel
git rev-parse HEAD
git status --short --branch
git worktree list --porcelain
git log -1 --format='%H%n%s%n%cs'
git ls-files src package/source-layout.json tests docs/public | head -80
rg -n 'next\(|report\(|dispatch|prompt|completion|verify' src/host src/kernel bin
```

실제 경로가 달라졌으면 존재하는 경로만 따라간다. 전체 무관한 문서/JSON 대조를 기본 절차로 만들지 않는다.

## 3. W0 — Top-Down 활성 실행 경로와 Golden-PR 등록

**진입:** 현재 저장소를 읽을 수 있고 다른 active 작업을 건드리지 않는다. 모델 실행형 Golden Task는 아직 호출하지 않는다.

| 작업 | 확인할 실제 원천 | 완료 기준 |
| --- | --- | --- |
| W0-1 Source/Runtime 구분 | `AGENTS.md`, `package/source-layout.json`, Git HEAD/status, `docs/public/development.md` | source owner, generated/install 소비자와 clean baseline 후보 확인 |
| W0-2 요청 1건 추적 | Host launcher/adapter/dispatcher→`next/report`→context/prompt builder→proof/Completion | 실제 prompt/skill/tool schema 및 동적 payload, 반복 status·review 호출 경로를 파일/함수/소비자로 연결 |
| W0-3 반복·중복 후보 | 기존 테스트/CI, 실제 invocation, proof/receipt consumer | B1a/B2a/C/B1b/B2b/D/S6 각 최소 변경 후보와 실패 모드를 한 표에 등록 |
| W0-4 역사적 Keep 역조회 | 위 활성 경로에 남아 있는 항목의 과거 audit/Prompt Diet/B0~B12 기록 | 현재 방어 여부/Keep 이유의 출처만 연결. 과거 전체 파일 재감사 금지 |
| W0-5 Golden PR 고정 | 실제 완료 PR/issue, 부모 commit, redacted 작업 입력, 원래 성공 patch/테스트 | Track A 4개·Track B 2개의 재현 가능한 시작점과 held-out oracle, 사전 반복 대상 결정 |
| W0-6 측정·환경 고정 | 기존 usage receipt, provider 실행 설정, 설치/fixture tool | model ID/snapshot 지원 여부/effort, permissions, budget/timeouts, raw cache read/write 지원 여부, HUT/fixture digest 등록 |

### W0 파일 계약

필요한 경우 아래 세 산출물까지만 생성한다. 이미 있는 증거로 충분한 내용은 링크한다.

`W0-active-path.md`:

```md
# W0 활성 경로
- observed_head:
- clean_before_sha: (미확정이면 null)
- source_owner:
- execution_entrypoint:
- host_dispatch_chain: (파일:함수 → 파일:함수)
- kernel_next_report_chain:
- actual_model_visible_surface: (source/generated/installed 구분)
- proof_and_completion_consumer:
- supported_surfaces:
- repeated_admin_or_proof_calls:
- existing_Keep_decisions_checked:
- overlapping_Host_owned_Worker_files:
- verified / inferred / unverified:
```

`W0-golden-tasks.json`: 고정 Task ID 6개, 각 항목에 `track, kind, source_issue_or_pr, parent_commit, fixture_commit, fixture_digest, input_ref, oracle_ref, oracle_digest, expected_original_pr_pass, reproduction_signal, permissions, timeout_ms, budget` 기록. **후보를 채울 때 실제 evidence를 첨부**하고, 정보가 없는 경우 `null`로 표기한다. Track B는 승인된 fixture가 없으면 `NOT_RUN`으로 등록하고 가짜 외부 프로젝트를 만들지 않는다.

`W0-baseline-manifest.json`: `before_sha, doc_sot_sha, observed_main_sha, hut_build_digest, source_layout_digest, environment_digest, task_set_digest, model_id, model_snapshot_id, effort, execution_surface, cache_condition, provider_raw_usage_fields, replay_repetitions, repeat_task_ids, budget`. 값은 실행·실측을 통해 확인한다. **해당 파일 자체는 평가 결과가 아니다.**

### W0 종료 조건

- Clean `before_sha`와 실제 활성 call path 확보
- Track A/B 6개 각 fixture/oracle/반복·비용 조건 확정, 원래 성공 PR에 대한 oracle 검증
- 미확인·불가능한 surface는 `NOT_RUN` 구분; 승인 없는 실환경 변경 없음
- 중복 검사가 아닌 현재 코드 소비자 근거로 구현 대상 확정

W0의 핵심 필수 항목을 채우지 못하면 해당 실험 범위를 보류한다. 다른 독립 구현 후보는 진행 가능 여부를 별도 판단한다.

## 4. 구현 단위별 체크포인트

**공통 루프:** 활성 원천 확인 → 변경 최소화 → 기존 결정론적 Gate → 변경 검토 → 독립 커밋. 다음 단위는 선행 변경이 요구하는 Gate를 통과한 뒤 실행. 각 단위에서 Golden Task/LLM 평가 실행하지 않는다.

| 단위 | 실제 확인/변경 경계 | 수용 기준 | 실패 시 조치 |
| --- | --- | --- | --- |
| **B1a** | 실제 모델-visible prompt/skill assembly, 중복된 상시 방법론/이미 무해한 prose | 비교 wire bytes 감소, 안전·완료 의미 보존 | 삭제 원문만 원복, 다음으로 넘기지 않음 |
| **B2a** | Host next/report/dispatch 주변 반복 상태조회·분류·기본 리뷰 | 호출 감소가 코드/fixture로 증명, Owner·freshness·승인·review obligation 유지 | 관리 변경만 롤백; 권위 제거 금지 |
| **C** | `src/` canonical API/wrappers/compatibility; search/generator/packager 소비자 | 중복 경로/탐색 노이즈 감소, dynamic import/export·설치 호환 | 실제 소비자 있으면 Keep. 생성 파일 직접 수정 금지 |
| **B1b** | C가 정리한 경로를 설명하던 잔여 prompt | C 근거가 있는 항목만 삭제, C 미완료면 `NO_CHANGE` | C와 연동 의존성 유지/공동 롤백 |
| **B2b** | 현재 `agents/verification/` 및 실제 검증 script owner/receipt consumer | 필수 obligation·source/revision/가용성 동일, verification 중복 감소 | evidence 감소 시 복원. 미실행을 fresh PASS로 승격 금지 |
| **D** | 현재 compiler/lint/boundary/CI 기존 체크의 실제 미탐지 결함 | 기존 검사기로 결함을 탐지하고 actionable 진단. 필요 없으면 `NO_CHANGE` | 신규 분석기/상시 감사 미도입 |
| **S6** | Host prompt builder, adapter, raw provider usage receipt | Stable prefix byte identity, 변동값 tail, cache hit/write·총비용 해석 가능, 권한 유지 | 미지원 capability를 켠 척하지 않음; 비용 미측정은 `UNOBSERVED` |

코드 파일은 W0의 **실제 호출 지점**에서 확정한다. 과거 로드맵의 `scripts/kernel/`을 editable canonical source로 선택하지 않는다. Host-owned Worker와 겹치는 `dispatch/writer` 수정은 선행 작업 정착 확인 전 보류한다.

### 매 단위 네 가지 결정론적 Gate

1. **정적/컴파일**: `npm run typecheck`, `npm run build:check`, `npm run check:boundaries`, 실제 필수 lint/CI.
2. **기존 테스트**: 변경 영향의 unit/integration/contract, Work/Trust/Knowledge/Completion/write-ownership 필수 테스트. `npm run build:tests:check`, `npm run test:source-runtime`, 필요 시 `npm test`. 각 명령의 현재 존재·의미부터 확인. 원격 에이전트 실행 없는 항목만.
3. **생성/패키지/격리 설치**: `npm run build`, `npm run test:package` 및 현재 지원 surface의 **격리된** 설치/실행 스모크. 실제 `HOME` 변경 금지. 무분별한 `npm pack` 실행 대신 생성 파일·임시 출력이 별도 worktree에만 생기도록 제한.
4. **Prompt dry-run**: 실제 builder를 호출하는 기존 test/instrumentation으로 bytes/digest/가능한 토큰 수/ordering 변화 기록. 모델 API 호출·cache hit 추정으로 가장하지 않음.

모든 명령을 매 단위 중복 실행하지 않는다. 기존 필수 gate는 유지하되 캐시된 build 결과를 정당하지 않은 Fresh Evidence로 대체하지 않는다. Gate `NOT_RUN`이면 그 영향을 받는 수용 항목도 완료라고 하지 않는다.

커밋은 B1a → B2a → C → B1b → B2b → D → S6의 변경 단위별로 **한글 상세 본문**에 수정 범위, 원인, 명령별 검증 결과, 남은 미검증 사항을 기록한다. 실제 변경 없는 단위는 빈 commit 없이 `NO_CHANGE`.

### 4.1 미완료 구조적 개선 재정렬 (`P0 → P1 → P2 → P3`)

1차 실행(`8889a4c7`~`9c7b5c58`)에서 완료된 내부 DB/Git 조회 최적화(`B2a/B2b`)는 보조 지표로 보존하고, `STRATEGY.md`의 본래 목표("실제 모델에 전달되는 지침, 관리 턴, 코드 탐색과 검증 비용 감소")를 달성하기 위해 미완료 구조 개선을 다음 4개 기능 묶음으로 재정렬하여 실행한다. `check:boundaries`나 과거 `prompt-inventory.json` 바이트 잠금 통과를 구조 개선 불필요의 근거로 사용하지 않는다.

| 우선순위 | 구현 묶음 | 실제 확인/변경 경계 | 핵심 변경 | 완료 기준 |
| --- | --- | --- | --- | --- |
| **P0** | 모델-facing 관리 워크플로우 단순화 | `src/kernel/bridge/mcp.ts`, `src/kernel/control-plane.ts`, `src/kernel/run/run-loop.ts`, `src/host/kernel/host-turn.ts` | (1) MCP `kernel_report`/`kernel_next`에서 Host 자동 독립 리뷰가 `pass` 영수증(`reviewReceiptId`)을 기록하고 남은 미충족 하드/리뷰 의무가 없으면 동일 호출 내에서 최종 결산까지 자동 연결, (2) `baselineRequired`가 켜진 Run에서 깨끗한 시작 워크스페이스이면 `baseline-required` 관리 턴을 모델에 노출하지 않고 `prepareNext`가 바인딩된 baseline 캡처를 즉시 수행 후 `implement` 반환, (3) 모든 필수 증거와 Step이 통과한 상태에서 빈 finalize `report` 1턴(`action.type = 'report'`)을 추가로 요구하지 않고 `finalizeRun`을 즉시 종결하여 `action.type = 'done'` 반환 | 실제 요청에서 모델의 추가 관리 호출·턴(`baseline-required` 왕복, Host 리뷰 후 빈 `report`, 완료 직전 빈 finalize `report`)이 제거되고 독립 검토·승인·외부 Writer 보호는 유지 |
| **P1** | Prompt·Knowledge 전달 구조 통합 | `src/kernel/knowledge/context-load.ts`, `src/kernel/control-plane.ts`, `src/host/kernel/turn-dispatcher.ts`, `src/host/kernel/context-segments.ts` | 프로젝트 전역 안정 지식(`policyAnchors`, 전역 `ontologyConstraints`, `graphSynopsis`)을 `projectStable` 세그먼트로, 단계·변경 경로·쿼리에 따라 변하는 사실(`semanticFacts`, 경로 한정 제약)을 `volatile.taskKnowledge`로 구조화 분리하여 `buildTurnPromptEnvelope`에 연결 | 단계·스텝이 바뀌어도 `project-stable` digest가 불필요하게 변하지 않고 변동 정보는 `volatile`에서 갱신되며 6개 핵심 모델 필드 의미가 보존됨 |
| **P2** | Codebase Deletion-first 구조 정리 | `src/host/kernel/host-turn.ts`, `src/kernel/run/model-view.ts`, `package/profile-templates/claude/.claude/agents/kernel-{implementer,reviewer}.md`, `artifacts/kernel-prompt-audit/prompt-inventory.json`, `tests/kernel-prompt-inventory.test.ts` | (1) `prepareNext`가 이미 단일 권위로 검증하는 `assertImplementationWorkUnitScope` / `scope-rejected`를 `prepareHostTurn`에서 중복 실행·재구성하던 경로 통합, (2) `projectKernelModelView` compact 모드에서 이미 `action`과 `verification`에 투영된 비대한 중복 권위 트리(`trustAuthority`, `knowledgeAuthority`, `workAuthority`, `completion`, 100개+ `availableCommandRefs`)를 요약/제거(`--verbose`는 전체 유지), (3) 에이전트 템플릿의 `CONTROL_ONLY_CAPSULE_FIELDS`(`capsuleId`, `workspaceIdentity`, `mutationRevision`) 입출력 안내를 제거하고 인벤토리 계약 현행화 | 중복 권위 검증과 모델-visible 페이로드 중복 바이트가 실제로 감소하고 기존 패키징·설치·회귀 테스트 유지 |
| **P3** | Verification 책임 정리 | `src/kernel/control-plane.ts`, `src/host/kernel/host-owned-writable-attempt.ts`, `src/kernel/run/run-loop.ts` | (1) `proofRequestsForReport`에서 모델이 `verifications` 힌트에 `acceptanceCoverage`를 생략해도 선언된 `obligation.acceptanceIds`를 기본 바인딩으로 사용(위조·불일치만 fail-closed 거절), (2) `host-owned-writable-attempt.ts`에서 Worker가 `verifications: []`를 반환해도 Step과 Obligation에 바인딩된 하드 검증을 결정론적으로 도출, (3) `describeObligations`의 `allowedCommandRefs`가 100여 개 매니페스트 전체 대신 바인딩된 대표 명령 중심으로 노출되도록 정리 | 동일한 필수 검증과 fail-closed 안전성을 유지한 채 모델의 검증 명세·제출 부담과 페이로드 크기가 감소 |

## 5. 최종 평가 (구현 모두 종료한 뒤 1회)

**선행 조건:** 모든 적용 단위의 결정론적 필수 Gate 통과; 최종 `after_sha` 및 청정 HUT 설치가 가능; W0 fixture/oracle/모델/권한 고정.

1. `before_sha`, `after_sha`의 Relay를 각각 별도 HUT 설치로 준비한다.
2. Golden Task 6개를 양쪽 **동일 fixture와 독립 oracle**에서 실행한다. 기본 12회. W0에서 고정한 핵심 1~2개만 양쪽 각 1회 추가(총 14~16회). 모델 snapshot이 불확실하거나 cache warm/cold 조건이 불일치하면 교란 기록.
3. 결과 수집 때 **에이전트 생성 commit, staged·unstaged·untracked, 삭제, 실행 모드, symlink**를 빠짐없이 포함한다. secret/absolute account path는 보존하지 않는다.
4. 원래 fixture를 깨끗이 복원한 뒤 **후보 solution patch만** 적용하고, 에이전트에게 숨겨둔 held-out oracle + 기존 프로젝트 검증으로 실제 동작을 채점한다.
5. 모든 task의 Before/After 레코드를 `final-before-after.json`에 저장한다. 빈 값은 `null`. 비용 추정의 단위/범위와 provider raw usage를 명시한다.
6. Hard Gate 충족 + outcome 비열화 없음 + 전체 통합 비용 또는 관리 부담 감소의 실제 관측을 근거로 완료/부분 완료/보류를 판정한다.

### 최종 파일의 최소 구조

```json
{
  "before_sha": null,
  "after_sha": null,
  "model": {"provider": null, "model_id": null, "snapshot_id": null, "effort": null},
  "task_set_digest": null,
  "environment_digest": null,
  "cache_condition": null,
  "runs": [{
    "task_id": "A-F1", "harness": "before",
    "fixture_digest": null, "oracle_digest": null,
    "outcome": "NOT_RUN", "safety_violations": null,
    "trace_ref": null,
    "trace_summary": {
      "turns": null, "admin_calls": null, "search_calls": null,
      "verify_runs": null, "rework_count": null
    },
    "tokens": {"input": null, "output": null, "cache_read": null, "cache_write": null},
    "cost_usd": null, "wall_clock_ms": null
  }],
  "unverified": [],
  "decision": "NOT_RUN"
}
```

실제 최종 결과에는 `A-F1/A-R1/A-S1/A-D1/B-B1/B-F1` × Before/After 12개 레코드가 필요하다. `null` 또는 `NOT_RUN`을 성공·0으로 계산하지 않는다. 증거 없이 이 예시 템플릿을 결과 파일로 생성하지 않는다.

## 6. 실패 대응·롤백·채택

| 조건 | 정확한 대응 |
| --- | --- |
| 결정론적 Gate 신규 실패 | 해당 단위에서 수정/롤백, 실패 원인과 관련 contract만 재검증 |
| 최종 After-only 결정론적 실패 | 환경·oracle·patch 수집 오류 제외 후 commit 경계 `git bisect`/국소 비교. '최대 3회' 같은 보장 없음 |
| 에이전트 행동의 비결정적 실패 | 단일 `git bisect run` 결론 금지. 고정 과제 조건에서 최소 재현 + trace·prompt·receipt 분석 |
| C와 B1b 등 의존 commit | 안전한 공동 롤백 또는 원인 수정. 단일 revert 가정 금지 |
| 미지원 provider/미확인 cache telemetry | 지원 조합만 `PARTIAL/NOT_RUN`; 성공으로 위장하지 않음 |
| 품질 PASS, 비용 절감 미관측 | 품질 결과와 비용 효과 미입증을 분리. `COMPLETE` 선언 보류 |
| 필수 Hard Gate 모두 PASS, 실제 효율 개선 | 즉시 종료. 중간 Arm 실험 추가 금지 |

**원인 추적과 재실행은 최종 실패로 인해 채택 판단이 바뀔 때에만 수행**한다. 원인 불명 동일 실패를 조건 변화 없이 반복하지 않는다.

## 7. 문서화·변경 보고·종료 기준

- W0 파일 3개 이내: `W0-active-path.md`, `W0-golden-tasks.json`, `W0-baseline-manifest.json`(필요시에만).
- 중간 단계: 기존 test log/receipt, 커밋 SHA. 새 프롬프트 감사 엔진·대시보드·수십 개 단계보고서 생성 금지.
- 최종 단계: `final-before-after.json`, 필요한 경우 `FINAL-RESULT.md` 한 개.
- 이번 **문서 준비 작업 완료**: SOT 포인터 현행화, Freeze 전략과 계획 저장, 링크/참조·금지조건 검증, 문서만 담은 상세 한글 커밋. W0 결과·코드 개선·실제 Before/After는 완료로 주장하지 않는다.
- **전체 개선작업 완료**: 실제 사용자 경로의 Hard Gate를 충족하고 고정된 Golden Task outcome·trace·cost/latency가 비교 가능한 증거로 남았으며 이전보다 관리/비용 효율이 개선된 상태.
- 가능한 작업은 진행하고 보호 조건을 충족하지 않는 경로만 `HOLD_SAFE`/외부 조건 `DEFER`/평가 불가능 `NOT_RUN`으로 분리한다.

**첫 번째 구현 후속 작업은 W0의 읽기 전용 조사다. 이 계획 자체가 W0 조사 결과를 대체하지 않는다.**
