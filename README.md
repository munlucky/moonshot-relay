# Moonshot Relay

> Claude Code와 Codex를 위한 Moonshot workflow harness 플러그인

## 개요

이 저장소는 Claude Code와 Codex에서 사용할 규칙, 에이전트, 스킬, 문서 템플릿을 한곳에서 관리하는 Moonshot workflow harness입니다. 다양한 프로젝트에 재사용 가능한 워크플로우를 제공하고, 플러그인 manifest와 설치 스크립트로 배포할 수 있습니다.

## 구성 요약

- canonical source는 `skills/`, `agents/`, `rules/`, `bin/`, `tools/`, `schemas/`, `templates/`, `tests/`, `docs/public/`와 allowlisted support script만 `scripts/`에서 관리하고, `.claude/`는 개발 profile 및 downstream compatibility wrapper로 유지
- 대부분의 문서는 `.md`(영문)와 `.ko.md`(한글) 쌍으로 제공
- `npx -y github:munlucky/moonshot-relay install` 또는 `node bin/moonshot-relay.mjs install --runtime all`로 account-root 런타임을 설치
- account-root 설치의 공통 payload는 canonical `skills/**`를 보존하지만 Claude/Codex/Qwen profile-local discovery surface는 `product-orchestrator`, `moonshot-architecture`, `moonshot-orchestrator`, `moonshot-phase-runner`, `moonshot-plan-writer`, `commit-moonshot`, `session-logger`, `explain-diff-html` 8개 skill로 제한
- compatibility window 동안 downstream 설치는 계속 `.claude/` payload를 생성하지만, 이 저장소의 source of truth는 root-level source directory입니다
- 기존 Moonshot 개발 실행 체인 앞에 제품 정의용 산출물 체인을 추가할 수 있음
- 장시간 앱 개발용 `Sprint Contract -> QA Report -> Handoff` 브리지 아티팩트를 포함해 planner/generator/evaluator 분리를 강화
- source-owned 장기 roadmap은 `docs/public/roadmaps/`에 추적하고, phase 실행 계획 패키지와 review-loop 산출물은 `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/state/projects/<projectId>/planning/packages/<plan-slug>/`에 둡니다. phase 실행 중 생성되는 runtime execution scratch는 `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/state/projects/<projectId>/execution/.../plans/<plan-slug>/runs/<runId>/execution/`에 두며 배포/설치 payload에는 포함하지 않습니다.
- `.moonshot-relay/docs/tasks/`, `.moonshot-relay/docs/phase-status.yaml`, `.moonshot-relay/docs/reports/*.json`, `.moonshot-relay/verification-results-*`, `.moonshot-relay/verification-verdict-*`, `.moonshot-relay/docs/moonshot-analysis.yaml` 같은 런타임 산출물은 버전 관리/설치 배포 대상이 아님
- 프로젝트 지식 메모리는 account-root project knowledge namespace를 기본 backend로 사용합니다. 프로젝트 로컬 `.moonshot-relay/cache/memorygraph/**`는 seed/cache 입력이며 버전 관리/기본 agent context에서 제외합니다.
- 코드 구조 분석은 `code-review-graph` MCP를 stage-gated + lazy update 방식으로 사용하며 `.code-review-graph/`에 저장하고 자동 build/watch 없이 실행

## Kernel 개발

Kernel/Host 코드는 `src/`에서 수정합니다. `npm ci`는 개발 의존성을 설치하고 기존 경로에 `.mjs` 런타임을 빌드합니다. 수정 뒤 `npm run build`, `npm run test:source-runtime`을 실행합니다. 생성된 `scripts/kernel/`, `scripts/host/kernel/`와 매핑된 CLI 파일은 직접 수정하지 않습니다.

[개발 명령과 원본 경계](docs/public/development.md) · [구조 결정과 Futures 적용 지도](docs/public/roadmaps/source-runtime-separation/ARCHITECTURE.md)

## Repository Source Model

- Canonical source (Kernel/Host runtime uses `src/`; generated mappings are excluded): `skills/`, `agents/`, `rules/`, `bin/`, `tools/`, `schemas/`, `templates/`, `tests/`, `tests/fixtures/`, `docs/public/`, plus allowlisted installer/MCP/memory/closeout support scripts under `scripts/`
- Development profile: `.claude/`, `.codex/`, and `.qwen/` for local agent runtime compatibility
- Package payloads: `package/claude/profile/`, `package/codex/profile/`, `package/qwen/profile/`, `.claude-plugin/`, `.codex-plugin/`
- Generated state: `.moonshot-relay/`, legacy `.moonshot-state/`, `.claude/logs/`, `.claude/cache/`, `.claude/traces/`, `.claude/browser-artifacts/`, `.claude/browser-runtime/`, `.claude/memorygraph/`, sqlite files, and verdict JSON

Do not add durable source under `.claude/skills`, `.claude/agents`, `.claude/scripts`, `.claude/bin`, `.claude/tools`, `.claude/schemas`, or `.claude/templates`. Add or modify reusable assets in the canonical root directory first, then refresh generated profile output or compatibility wrappers through the package/materialization flow.

Compatibility wrappers and installed-runtime docs may still mention `.claude/...` during the deprecation window. Those references describe downstream payload behavior, not repository source ownership. See `docs/public/repository-layout.md`, `docs/public/installer-usage.md`, and `docs/public/compatibility-migration.md`.

## 테스트 계약

- 공식 기본 gate는 `npm test`입니다.
- `npm run test:active`는 같은 active gate를 실행합니다.
- `npm run test:package`는 package/materialization/migration 관련 active tests만 실행합니다.
- bare `node --test` 또는 globbed Node test 직접 실행은 archive 보존 테스트까지 발견할 수 있으므로 공식 active gate가 아닙니다. active test를 직접 실행해야 할 때는 `npm test` 또는 `package.json`의 `scripts.test` 파일 목록과 동일한 명령을 사용합니다.

## 디렉터리 구조

```text
moonshot-relay/
├── install-claude.sh
├── README.md
├── .claudeignore
├── skills/
├── agents/
├── rules/
├── scripts/
├── schemas/
├── templates/
├── tools/
├── docs/public/
└── AGENTS.md
```

Kernel/Host runtime source is `src/`; generated mappings in `package/source-layout.json` are outputs. Other root-level `skills/`, `agents/`, `rules/`, `bin/`, `tools/`, `schemas/`, `templates/`, `tests/`, `docs/public/`, and allowlisted support files under `scripts/` are the canonical source directories. Root `.claude/`, `.codex/`, and `.qwen/` are local runtime profiles and may be absent or contain only ignored runtime artifacts in a clean source checkout.

Regression fixture JSON and sample artifacts belong under `tests/fixtures/`; they are not runtime output and are not included in installed package payloads.

## 핵심 구성 요소

### 규칙 문서

- `CLAUDE.md`: 전역 규칙과 기본 작업 방식
- `PROJECT.md`: 현재 워크스페이스의 운영 계약 문서
- `AGENTS.md`: 최상위 TOC 겸 브리지 엔트리

### Moonshot 워크플로우

- 기본 공개 workflow 진입점은 `product-orchestrator`, `moonshot-architecture`, `moonshot-phase-runner`, `moonshot-orchestrator` 4개입니다.
- 보조 공개 유틸리티 진입점으로 `moonshot-plan-writer`, `session-logger`, `commit-moonshot`를 직접 호출할 수 있습니다.
- `moonshot-orchestrator`는 bounded code work의 기본 진입점으로 동작합니다.
- large, phase 기반, long-running 작업은 `moonshot-phase-runner`를 기본 진입점으로 사용합니다.
- 오케스트레이터는 먼저 `executionPlane`을 `read_only`, `product_project`, `meta_harness`로 분류합니다.
- downstream 프로젝트 작업에서는 `project-contract-gate`, `context-readiness-gate`, `verification-contract-gate`가 최소 맥락과 검증 계약을 확인합니다.
- 분석 단계는 `moonshot-classify-task`, `moonshot-evaluate-complexity`, `moonshot-detect-uncertainty`, `moonshot-decide-sequence`로 구성되지만, 이들은 공개 진입점이 아니라 orchestrator 내부 마이크로스킬입니다.
- medium/complex 체인에서는 `karpathy-execution-gate`로 구현 직전 4원칙(코딩 전 사고, 단순함 우선, 최소 변경, 목표 중심 실행)을 점검합니다.
- 동작 변경 작업은 내부 `test-driven-development` 스킬로 red/green/refactor evidence를 남깁니다.
- 실제 작업 프로젝트에서 `.claude`, `.agents`, `.codex`가 ignored인 경우 `harness-prepare-worktree`가 worktree 생성 후 필요한 agent config를 hydrate하고 baseline evidence를 남깁니다.
- 구현 뒤에는 `code-simplifier`를 넣어 최근 수정 코드의 가독성과 구조를 정리한 뒤 검증/리뷰로 넘깁니다.
- React/UI 구현 작업에서는 `frontend-design`을 UI bundle의 umbrella로 사용합니다. `teach-impeccable`, `audit`, `normalize`, `polish`는 기본 진입점이 아니라 UI/design bundle 내부 또는 명시적 UI 품질 작업에서만 사용합니다.
- 검증 계층은 `completion-verifier`를 중심으로 `verification-agent`, `browser-verifier`, `codex-review-code`, `security-reviewer`, `qa-flow`를 stage 내부 구성요소로 조합합니다. 완료 주장은 항상 fresh evidence 이후에만 가능합니다.
- 문서 계층은 `session-logger`를 공개 유틸리티로 유지하고, `doc-auto-sync`, `documentation-agent`, `project-md-refresh`는 doc-ops/finish bundle 뒤에 둡니다.
- 사용자가 특정 스킬을 직접 지정한 경우나 read-only 요청, 오케스트레이터 자체 수정 작업에서는 direct invocation bypass가 허용됩니다.

### Product Definition 레이어

- `product-orchestrator`가 아이디어를 `PRODUCT_INTENT -> PRD -> SOLUTION -> SPEC -> PLAN` 체인으로 정리합니다.
- `moonshot-architecture`는 PRD 또는 기존 코드베이스 근거를 ASR, architecture options, C4/ADR, SPEC/SPEC_DELTA, traceability package로 정리합니다.
- `product-gate-reviewer`는 문서 품질 자체보다 다음 단계로 넘길 수 있는지를 `pass / conditional_pass / fail`로 판정합니다.
- `task-slicer`는 `PLAN.md`를 vertical slice 기반 `tasks/*.md`로 분해합니다.
- `assumption-ledger`는 질문이 필요한 모호함을 `ASSUMPTIONS.md` 또는 `BLOCKERS.md`로 적재해 workflow 정지를 줄입니다.
- medium/complex 구현은 slice별 `SPRINT_CONTRACT.md`를 먼저 만들고, 검증 결과는 `QA_REPORT.md`, 장시간 세션 상태는 `HANDOFF.md`로 남기는 것을 권장합니다.
- phase 기반 장시간 실행의 기본 진입점은 `/moonshot-phase-runner <plan-dir>`이며, 내부적으로 `moonshot-phase-executor`가 `in-session-coordinator`를 active 실행 경로로 사용합니다. `delegated-terminal` adapter는 legacy compatibility 전용입니다.
- `<plan-dir>`를 생략한 실행은 active plan resolver가 단일 안전 plan을 판정할 때만 허용합니다. 여러 plan package가 있거나 baseline이 stale이면 명시적 plan dir가 필요합니다.
- 기본적으로 `/moonshot-phase-runner <plan-dir>` 한 번이면 준비 후 실행까지 이어지고, 수동 중단이 필요할 때만 `--prepare-only`를 사용합니다.

### 에이전트

| 에이전트 | 역할 | 주요 작업 |
|---------|------|----------|
| **Requirements Analyzer** | 요구사항 분석 | 사전 합의서 작성, 요구사항 명확화 |
| **Context Builder** | 구현 계획 수립 | context.md 작성, 단계별 계획 수립 |
| **Implementation Agent** | 코드 구현 | 실제 코드 작성, 패턴 준수 |
| **Verification Agent** | 검증 실행 | typecheck, build, lint 실행 |
| **Documentation Agent** | 문서화 | 세션 로그, 최종 문서화 |

### 스킬 라이브러리와 공개 표면

- Product Definition: `product-orchestrator`, `product-gate-reviewer`, `task-slicer`, `assumption-ledger`
- 공개 진입점: `product-orchestrator`, `moonshot-architecture`, `moonshot-phase-runner`, `moonshot-orchestrator`
- 보조 공개 유틸리티: `moonshot-plan-writer`, `session-logger`, `commit-moonshot`
- 내부 분석 cluster: `moonshot-classify-task`, `moonshot-evaluate-complexity`, `moonshot-detect-uncertainty`, `moonshot-decide-sequence`
- 실행/검증 cluster: `karpathy-execution-gate`, `test-driven-development`, `implementation-runner`, `code-simplifier`, `verification-agent`, `completion-verifier`, `browser-verifier`, `codex-review-code`, `security-reviewer`, `qa-flow`
- UI/design optional bundle: `frontend-design` 아래 `teach-impeccable`, `audit`, `normalize`, `polish`, `web-design-guidelines`
- 문서/doc-ops optional bundle: `doc-auto-sync`, `session-logger`, `documentation-agent`, `project-md-refresh`
- 보조 도구: `pre-flight-check`, `project-contract-gate`, `context-readiness-gate`, `verification-contract-gate`, `design-asset-parser`, `project-md-refresh`, `build-error-resolver`
- deprecated / non-default: `efficiency-tracker`, `workflow-self-improver`

공개 표면 상태:
- `public_entrypoint`: 사용자가 workflow 시작점으로 직접 선택하는 스킬
- `public_utility`: 특정 유틸리티 목적에 한해 직접 호출하는 스킬
- `internal_stage_owner`: orchestrator 또는 stage bundle이 호출하는 내부 스킬
- `optional_bundle_member`: UI/browser/doc/verification 같은 task profile에서만 추가되는 스킬
- `deprecated`: 기본 실행 경로에서 제외하고 이력/명시적 유지보수 용도로만 남기는 스킬

### 문서와 템플릿

- 가이드라인: `docs/public/guidelines/*.md` (분석, 병렬 실행, 질문 템플릿, 요구사항 체크, 토큰 최적화 등)
- 제품 정의 가이드: `docs/public/guidelines/product-definition-workflow.md`
- 장시간 하네스 가이드: `docs/public/guidelines/long-running-harness.ko.md`
- 일일 회고 가이드: `docs/public/guidelines/daily-retro-workflow.ko.md`
- 외부 하네스 도입 검토 기록은 runtime/generated task output으로 남기며 source package에는 포함하지 않음
- 작업 문서 루트: `.moonshot-relay/docs/tasks/` (runtime task output)
- source roadmap 루트: `docs/public/roadmaps/` (tracked long-running harness plans, such as `docs/public/roadmaps/harness-control-plane-modernization/`)
- implementation plan package 루트: `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/state/projects/<projectId>/planning/packages/<plan-slug>/` (numbered phase docs and planning-loop review artifacts)
- runtime execution scratch 루트: `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/state/projects/<projectId>/execution/.../plans/<plan-slug>/runs/<runId>/execution/` (generated phase-runner readiness, attempt, QA, scorecard, handoff, and other execution artifacts; not tracked)
- runtime state root: `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/state/projects/<projectId>/`
- downstream reference package: `.claude/docs/reference-downstream/`
- runtime parity fixture: `.claude/docs/runtime-parity-reference-plan/`
- 제품 정의 템플릿: source checkout에서는 `templates/product-definition/*.md`, 설치 런타임에서는 `<MOONSHOT_RELAY_HOME>/templates/product-definition/*.md`
- 실행 브리지 템플릿: source checkout에서는 `templates/execution/*.md`, 설치 런타임에서는 `<MOONSHOT_RELAY_HOME>/templates/execution/*.md`
- Runtime payload support scripts are limited to installer, MCP, memory, and commit closeout flows. Workflow orchestration no longer installs `scripts/**` wholesale.
- Runtime profile skill discovery is governed by `package/runtime-surface.json`; internal skills remain in the shared `~/.moonshot-relay/skills/` payload, not profile-local Claude/Codex/Qwen `skills/`.
- 출력 템플릿: source checkout에서는 `templates/moonshot-output.*`, 설치 런타임에서는 `<MOONSHOT_RELAY_HOME>/templates/moonshot-output.*`

## 빠른 시작

### 한 줄 설치 (권장)

```bash
npx -y github:munlucky/moonshot-relay install
```

Source checkout에서 실행할 때는 Node installer를 직접 사용할 수 있습니다.

```bash
node bin/moonshot-relay.mjs install --runtime all
```

`install-claude.sh`는 macOS/Git Bash compatibility installer입니다. WSL/Linux bash에서 `unsupported shell: Linux`가 나오면 Node/npx installer를 사용합니다.

### Agent Skills CLI 부트스트랩

Agent Skills CLI로 시작할 때는 먼저 skill catalog를 설치한 뒤, 함께 설치되는 `moonshot-relay-setup` skill로 account-root 설치를 완료합니다.

```bash
npx skills add munlucky/moonshot-relay
```

그 다음 Codex/Claude에 다음처럼 요청합니다.

```text
moonshot-relay-setup을 사용해서 account-root 설치까지 완료해줘.
```

`npx skills add` 자체는 보안상 임의 installer를 실행하지 않으므로, 이 단계만으로는 `~/.moonshot-relay`, `~/.claude`, `~/.codex`, `~/.qwen` 동기화가 끝난 것이 아닙니다. `npx` 한 줄로 전체 설치까지 끝내야 하면 `npx -y github:munlucky/moonshot-relay install`을 사용합니다. 전체 런타임 설치 완료 기준은 `moonshot-relay-setup`, `install-claude.sh`, 또는 `moonshot-relay` CLI가 `.moonshot-relay-install-manifest.json`을 각 계정 루트에 남기는 것입니다.

옵션과 함께 사용:

```bash
# 다운로드 후 실행
curl -fsSL https://raw.githubusercontent.com/munlucky/moonshot-relay/main/install-claude.sh -o install-claude.sh
chmod +x install-claude.sh

# Windows는 PowerShell이 아니라 Git Bash에서 실행
# Git Bash 예시:
# bash ./install-claude.sh

# 기본 실행: 계정 루트(~/.claude, ~/.codex, ~/.qwen)에 Moonshot Relay 설치
./install-claude.sh

# 현재 프로젝트에 compatibility payload 설치
./install-claude.sh --project

# PROJECT.md 포함하여 프로젝트 설치
./install-claude.sh --project --include-project

# 프로젝트 설치 시 추가 파일 제외
./install-claude.sh --project --exclude "*.local.json"

# 미리보기 (실제 변경 없음)
./install-claude.sh --dry-run
```

기본 동작:
- 기본 설치는 account-root 직접 설치이며 공통 런타임 자산은 `~/.moonshot-relay`, 런타임별 자동 적용 표면은 `~/.claude`, `~/.codex`, `~/.qwen`에 동기화
- Claude/Codex/Qwen의 `rules/`, `skills/`, `agents/`처럼 런타임이 직접 읽는 디렉터리는 각 계정 홈에 유지하되, profile-local `skills/`에는 공개 runtime skill 8개만 설치
- Claude/Codex/Qwen 런타임 로컬 파일(settings, auth, sessions, plugins, caches 등)은 보호
- 각 계정 루트에 `.moonshot-relay-install-manifest.json` 설치 manifest 기록
- 현재 프로젝트에 `.claude`/`.codex` compatibility payload가 필요하면 `--project`를 사용
- `--project` 설치는 기존처럼 `.claude`, `.codex`, `AGENTS.md`, `.claudeignore`, `.gitattributes`를 프로젝트에 설치하고 사용자 로컬 파일을 보호

보호되는 사용자 파일 패턴:
```
PROJECT.md
*.local.json
*.local.yaml
*.local.md
settings.local.*
custom/
.env*
```

### PROJECT.md 자동 생성/갱신

설치 후 프로젝트 부트스트랩 문서 세트가 비어 있다면 `project-md-refresh` 스킬을 실행해 프로젝트 분석 기반으로 생성하거나 갱신할 수 있습니다.

기본 대상 문서:
- `.claude/PROJECT.md`
- `workflow/README.md`
- `docs/design/README.md`
- `docs/glossary/README.md`
- `docs/daily/README.md`
- `TEST_GUIDE.md`
- `docs/analysis/README.md` (downstream project bootstrap output; not tracked in this harness source repo)

추가로 downstream 프로젝트 구현 전에 다음 readiness gate를 통과하는 구성을 권장합니다.

- `project-contract-gate`: `.claude/PROJECT.md` 최소 계약 확인
- `context-readiness-gate`: `context.md` 최소 섹션 확인
- `verification-contract-gate`: `.claude/verification.contract.yaml` 또는 동등한 검증 정책 확인

예시:
- Claude Code에 이 저장소에서 `project-md-refresh`를 실행해달라고 요청

### 수동 설치

```bash
# 1. 기본 account-root 설치
npx -y github:munlucky/moonshot-relay install

# 2. 현재 프로젝트에 compatibility profile output이 필요할 때만 실행
cd /your-project
bash /path/to/moonshot-relay/install-claude.sh --project

# 3. 부트스트랩 문서 커스터마이징
# PROJECT.md와 workflow/design/glossary/daily/test/analysis 문서를 프로젝트에 맞게 수정
```

Root `.claude/`, `.codex/`, `.qwen/`는 canonical source가 아니라 local/generated profile output입니다. 수동 `cp -r moonshot-relay/.claude`, `cp -r moonshot-relay/.codex`, 또는 `cp -r moonshot-relay/.qwen` 방식은 사용하지 않습니다.

### 부분 적용

```bash
# 스킬만 설치 (agents, docs 제외)
./install-claude.sh --project --exclude "agents" --exclude "docs"

# 로컬 설정 파일 제외
./install-claude.sh --project --exclude "*.local.json"

# 또는 canonical source만 필요한 경우 source checkout에서 스킬 정의를 참고하고,
# project-local compatibility payload가 필요하면 위 --project installer를 사용
```

### Codex 설정 동기화

기본 account-root 설치는 `~/.moonshot-relay`에 공통 Moonshot Relay 런타임을 설치하고, Codex가 직접 discovery하는 `~/.codex/agents/`와 `~/.codex/skills/`만 얇은 노출층으로 설치합니다. 기본 `.codex/skills/`에는 `package/runtime-surface.json`의 공개 runtime skill 8개만 들어가며, internal skill은 `~/.moonshot-relay/skills/`에 보존됩니다. 기존 `config.toml`, auth, sessions, plugins 등 Codex 런타임 로컬 파일은 보호합니다. `--project` 설치는 `.codex/config.toml`, `.codex/agents/`, `.codex/skills/`를 현재 프로젝트에 실제 파일/디렉터리로 설치합니다. 재설치 시 프로젝트 `.codex/agents/`와 `.codex/skills/` 전체를 백업 없이 제거한 뒤 최신 복사본으로 교체합니다. `.codex/skills/*`는 canonical `skills/`에서 materialized된 프로젝트 로컬 복사본이며, migration 중에는 `.claude/skills/*` compatibility profile output과 동기화될 수 있습니다.

Codex 프로젝트 설정에는 다음이 포함됩니다:
- 기본 승인/샌드박스 정책: `approval_policy = "on-request"`, `sandbox_mode = "workspace-write"`
- MCP 서버 예시: GitHub, Context7, Exa, MemoryGraph 기반 Memory, Playwright, Sequential Thinking
- 로컬 stdio MCP는 `<MOONSHOT_RELAY_HOME>/scripts/codex-mcp-singleton.mjs`를 경유해 같은 프로젝트의 이전 동일 MCP process tree를 새 기동 시 정리합니다.
- 멀티에이전트 기본값: `[agents] max_threads = 6`, `max_depth = 1`
- 커스텀 에이전트: `explorer`, `reviewer`, `docs_researcher`

Codex에서 바로 활용할 수 있는 스킬 예시:
- 계획 검증: `codex-validate-plan`
- 코드 리뷰: `codex-review-code`
- 완료 검증: `completion-verifier`

Memory 설정:
- 기본 memory MCP는 `node <MOONSHOT_RELAY_HOME>/scripts/codex-mcp-singleton.mjs memory -- node <MOONSHOT_RELAY_HOME>/scripts/memorygraph-mcp-wrapper.js`입니다.
- wrapper는 account-root project knowledge state 아래 `memorygraph/`를 생성하고 `MEMORYGRAPH_DATA_DIR`로 주입합니다.
- `memorygraph` 실행 파일이 없으면 `install-claude.sh`가 `pipx install memorygraphMCP`를 시도하며, 실패해도 전체 설치는 계속됩니다.
- 프로젝트 지식그래프는 `node <MOONSHOT_RELAY_HOME>/scripts/memorygraph-project-index.mjs`로 `.moonshot-relay/cache/memorygraph/project-graph-seed.json` seed를 만들고 `project-memory-refresh`가 account-root project knowledge state의 `memorygraph/`에 반영합니다.
- 범용 하네스 지식은 `promotion-candidates.json` 후보 생성 후 명시 승인된 항목만 `harness-memory-promoter`로 `moonshot-relay` graph에 승격합니다.
- Legacy AWTL runtime importer utilities are preserved under `archive/scripts/legacy-phase-adapters/` for compatibility investigation; they are not installed into active runtime payloads.

Code Review Graph 설정:
- `code-review-graph`는 MemoryGraph를 대체하지 않습니다. MemoryGraph는 작업 기억/정책/결정, `code-review-graph`는 코드 구조/리뷰 영향도/분석 기능을 담당합니다.
- Codex MCP는 `node <MOONSHOT_RELAY_HOME>/scripts/codex-mcp-singleton.mjs code-review-graph -- node <MOONSHOT_RELAY_HOME>/scripts/code-review-graph-mcp-wrapper.js`입니다.
- `install-claude.sh`는 `pipx install "code-review-graph[communities]"`를 best-effort로 시도하고, 자동 `build`, `watch`, `daemon`은 실행하지 않습니다.
- 하네스 stage별 사용 계약은 `docs/public/guidelines/code-review-graph-workflow.md`를 따릅니다. 코드 분석, 영향도, blast radius, architecture overview, large function 탐색, 리뷰 컨텍스트 축소가 필요한 stage에서는 broad file read보다 `code-review-graph` MCP를 우선 사용합니다.
- 프로젝트 분석 DB는 `.code-review-graph/`에 저장하며 버전 관리와 기본 agent context에서 제외합니다.

주의:
- 프로젝트 `.codex/skills`는 Codex용 로컬 설치본입니다. truth source는 canonical `skills/`이고, `.claude/skills`는 migration compatibility profile output입니다. Codex Desktop에는 프로젝트 `.codex/skills`만 노출하는 구성이 기본입니다.
- 프로젝트 `.codex/agents`와 `.codex/skills`는 generated copy로 취급하므로 재설치 시 백업하지 않고 최신 복사본만 유지합니다.
- 설치 스크립트는 legacy `.agents/skills`를 제거해 `.agents/skills`와 `.codex/skills`가 동시에 discovery되는 중복 노출을 막습니다.
- 전역 `skills` 루트의 개인/시스템 스킬은 설치 스크립트가 건드리지 않습니다.
- 설치 직후 Codex에 스킬이 중복으로 보이면 새 세션을 열어 project `.codex/skills`만 로드되는지 확인하세요.

### 다음 단계

1. `.claude/PROJECT.md`를 프로젝트에 맞게 수정
2. Git에 커밋: generated/runtime denylist를 제외한 명시적 source/doc path만 `git add -- <paths>`로 staging한 뒤 commit
3. Claude Code에서 작업을 요청하면 Moonshot 워크플로우가 자동 실행

커밋 시 `.agents/skills`, `.mcp.json`, `.moonshot-relay/docs/tasks/`, `.moonshot-relay/docs/phase-status.yaml`, `.moonshot-relay/docs/reports/*.json`, `.moonshot-relay/verification-verdict-*`, `.moonshot-relay/memorygraph/`, `.moonshot-relay/cache/memorygraph/`는 generated/local runtime 경로이므로 explicit `git add -- <paths>` 목록에 넣지 않습니다.

직접 스킬을 지정해서 실행하는 경우:
- review-only, read-only, meta-harness 수정은 direct invocation이 가능
- 일반적인 bounded code work는 `moonshot-orchestrator`를 기본 진입점으로 두는 편이 안전
- large 또는 phase 기반 작업은 `moonshot-phase-runner`를 먼저 타는 편이 안전
- UI 리디자인/감리 작업은 먼저 `frontend-design`을 기준으로 잡고, `/audit`, `/normalize`, `/polish`는 명시적인 UI 품질 세부 작업일 때만 optional helper로 호출합니다.

## Moonshot 워크플로우 v2 요약

- 병렬 실행: 독립 단계만 병렬화(리뷰/로깅/일부 검증), 계획 검증과 구현은 순차 진행
- Phase 내부 병렬 구현은 opt-in입니다. `WORKSETS.yaml`에 겹치지 않는 `ownedPaths`를 정의하고 `--parallel-worktrees N`을 넘긴 경우에만 worktree별 병렬 worker를 실행한 뒤 diff 검증/병합 후 기존 phase 검증으로 돌아갑니다.
- Karpathy Gate: 구현 직전 실행 규율 점검으로 과설계/스코프 이탈 방지
- Doc Sync: 문서 자동 동기화로 피드백 루프 유지
- Completion Check: 요구사항 누락 방지
- Product Definition Layer: 제품 정의 산출물을 먼저 고정한 뒤 기존 구현 체인으로 핸드오프

자세한 phase-runner 사용자 흐름은 `docs/public/reference/phase-runner-user-workflow.md`를 참고하세요.

## 설정 커스터마이징

### settings.local.json

현재 저장소의 로컬 설정 예시:

```json
{
  "permissions": {
    "allow": [
      "Bash(tree:*)",
      "WebFetch(domain:exhibition-admin-api-docs)",
      "Bash(cat:*)",
      "Bash(npm run typecheck:*)",
      "Bash(npx tsc:*)",
      "Bash(npm run lint:*)",
      "Bash(mkdir:*)",
      "Bash(npm run build:*)",
      "Bash(git add:*)",
      "Bash(git checkout:*)",
      "mcp__codex__spawn_agent",
      "Bash(awk:*)",
      "Bash(xargs:*)",
      "Bash(find:*)",
      "Bash(git log:*)",
      "Bash(npm run:*)",
      "Bash(jq:*)",
      "Bash(python3:*)",
      "Bash(chmod:*)"
    ],
    "deny": [],
    "ask": []
  }
}
```

## 라이선스

이 프로젝트는 개인 및 상업적 용도로 자유롭게 사용할 수 있습니다.

## 기여

개선 사항이나 버그 리포트는 이슈로 남겨주세요.
