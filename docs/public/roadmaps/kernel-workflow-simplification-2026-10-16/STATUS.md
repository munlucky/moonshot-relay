# Kernel Relay 실사용 워크플로우 단순화 진행표

계획 검토 기준 HEAD: `09f452bfc8ef241040233078903555c73a7be62f`

W0 시작 기준: planning commit/push 이후 실제 current HEAD를 `baseHead`로 기록한다.

계획 상태: READY_FOR_IMPLEMENTATION

이 파일은 작업 인덱스다. Moonremote checkpoint, Kernel completion authority, Git remote parity를 대체하지 않는다.

허용 상태:

- `NOT_STARTED`
- `IN_PROGRESS`
- `BLOCKED`
- `COMPLETE`
- `VERIFIED_EXISTING`

## Wave 상태

| Wave | 목표 | 선행 | 상태 | Commit | Remote parity |
| --- | --- | --- | --- | --- | --- |
| W0 | 안전 기준선과 characterization | 없음 | COMPLETE | this Wave commit | verified after push |
| W1 | Git owner-direct changedPaths 정합화 | W0 | COMPLETE | this Wave commit | verified after push |
| W2 | Session source-selection/binding 경계 | W1 | VERIFIED_EXISTING | this Wave commit | verified after push |
| W3 | Verification/report 사용 경로 | W2 | COMPLETE | this Wave commit | verified after push |
| W4 | canonical next preparation 통합 | W3 | COMPLETE | this Wave commit | verified after push |
| W5 | model-visible next 왕복 제거 | W4 equivalence 통과 | COMPLETE | this Wave commit | verified after push |
| W6 | semantic Contract 입력 | W5 | COMPLETE | this Wave commit | verified after push |
| W7 | Recovery continuity mechanics | W6 + 필요성 확인 | NOT_STARTED | - | - |
| W8 | 전후 측정·통합 검증·잔여 단순화 | W7 또는 VERIFIED_EXISTING | NOT_STARTED | - | - |

## Wave 결과 기록 템플릿

각 Wave 종료 시 아래 블록을 복사해 채운다.

```text
wave: Wn
status: COMPLETE / BLOCKED / VERIFIED_EXISTING
workspace:
baseHead:
resultHead:
taskId:
kernelRunId: 있으면 기록, 없으면 없음
scope:
acceptance:
checks:
structuralReview:
  hardcoding:
  fallback:
  duplicatedAuthority:
  newAbstraction:
commit:
push:
  remote:
  branch:
  remoteHead:
  parity:
remaining:
nextWave:
```

## 구조 리뷰 판정 규칙

다음 중 하나가 새로 생겼는데 제거 근거가 없으면 Wave를 COMPLETE로 표시하지 않는다.

- provider/project/model-specific hardcoding.
- error-code별 ad-hoc fallback.
- 구/신 경로 병렬 compatibility layer.
- Host/Kernel policy duplication.
- 새 persistent state 또는 registry.
- model-visible field 증가.
- 기존 Authority와 동일한 두 번째 Authority.
- 테스트를 통과시키기 위한 production special case.

## Push 완료 조건

Wave 완료는 로컬 commit 생성만으로 끝나지 않는다.

다음을 확인한다.

1. commit hash 생성.
2. push 성공.
3. `git ls-remote` 또는 동등한 방식으로 remote branch hash 확인.
4. remote hash == local HEAD.
5. working tree에 예상하지 않은 변경 없음.
6. checkpoint에 commit/push evidence 기록.

push가 불명확하면 다음 Wave로 넘어가지 않는다.


## W0 결과

```text
wave: W0
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: 6c9e22aedd6c0633bd4cb38e1dabe97b2462225e
resultHead: this Wave commit
taskId: 4b8b1d6f-602d-4099-b965-b55f3f648055
kernelRunId: 없음
scope:
  - tests/kernel-run-env-resolution.test.ts
  - tests/kernel-efficiency-telemetry.test.ts
  - STATUS.md
acceptance:
  - explicit --session-id가 있으면 CODEX_THREAD_ID를 resolver 후보에서 제외하는 CLI source-selection을 고정
  - explicit/env session 충돌은 thread와 무관하게 fail-closed임을 고정
  - Git actual change, index-only change, immutable baseline unknown, explicit [] mismatch 기존 회귀 유지
  - canonical next의 contract preflight/baseline-required 안전 경계 기존 회귀 유지
  - exact reusable proof와 flaky fresh 실행 기존 회귀 유지
  - timeToFirstMutationMs와 contractRepairCount의 현재 실제 의미를 characterization
checks:
  - npm run build:tests: 283 tests, 8 helpers 생성 성공
  - kernel-run-env-resolution: 21/21 통과
  - W0 focused suite: source runtime build 후 timeout 전 68/68 통과; 나머지 session suite는 별도 21/21로 완결
  - npm run typecheck 통과
  - npm run build:check: 301 files, 814 edges, changed 0
  - npm run build:tests:check: 283 tests, 8 helpers, removed 0
  - git diff --check 통과
structuralReview:
  hardcoding: 없음. production 코드 변경 없음
  fallback: 없음
  duplicatedAuthority: 없음
  newAbstraction: 없음
commit: this Wave commit
push:
  remote: origin
  branch: main
  remoteHead: verified after push
  parity: required before W1
remaining: W1~W8
nextWave: W1
```


## W1 결과

```text
wave: W1
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: ea784415c2714725af832695fea31af65274b7ec
resultHead: this Wave commit
taskId: 4b8b1d6f-602d-4099-b965-b55f3f648055
kernelRunId: 없음
scope:
  - src/kernel/control-plane.ts
  - src/kernel/bridge/mcp.ts
  - skills/moon-relay-kernel/SKILL.md
  - tests/kernel-host-loop-e2e.test.ts
  - STATUS.md
acceptance:
  - Git owner-direct omission은 기존 live Git authority에서 actualChangedPaths를 파생
  - explicit [] 또는 잘못된 claim은 기존 mismatch 차단 유지
  - non-Git omission은 빈 변경으로 간주하지 않고 기존 workspace_observation_unavailable로 fail-closed
  - non-Git explicit claim 경로 유지
  - isolated worker/parallel receipt의 required changedPaths provenance 유지
  - MCP/Skill 설명을 실제 authority semantics와 정합화
checks:
  - npm run build: 301 files, 814 edges
  - npm run build:tests: 283 tests, 8 helpers
  - W1 focused suite 41/41 통과
  - npm run typecheck 통과
  - npm run build:check 통과
  - npm run build:tests:check 통과
  - npm run check:boundaries: 9 modules, 301 files, 814 edges
  - git diff --check 통과
structuralReview:
  hardcoding: 없음
  fallback: non-Git stat-walk fallback을 추가하지 않고 omission을 차단
  duplicatedAuthority: stat-walk을 change authority로 승격하지 않음
  newAbstraction: 없음
commit: this Wave commit
push:
  remote: origin
  branch: main
  remoteHead: verified after push
  parity: required before W2
remaining: W2~W8
nextWave: W2
```


## W2 결과

```text
wave: W2
status: VERIFIED_EXISTING
workspace: /shared/moonshot-relay
baseHead: f25a53ccac4a9e9d2f4e1de2fd9a8c299646e908
resultHead: this Wave commit
taskId: 4b8b1d6f-602d-4099-b965-b55f3f648055
kernelRunId: 없음
scope:
  - 기존 src/application/kernel-cli/main.ts source-selection 정책 검토
  - 기존 src/host/kernel/host-session.ts canonical consistency 경계 검토
  - 기존 standalone session context 소비자 검토
  - 기존 skills/moon-relay-kernel/SKILL.md 수동 session 요구 여부 검토
  - STATUS.md
acceptance:
  - explicit/env/thread source-selection 정책은 CLI 한 owner에만 존재
  - resolver는 전달된 후보의 canonical consistency만 담당
  - explicit session은 CODEX_THREAD_ID를 후보에서 제외하는 기존 정책 유지
  - 정상 Codex thread는 수동 --session-id 없이 부트스트랩
  - env/thread 및 explicit/env conflict는 fail-closed
  - wrong project/worktree/owner binding 차단 유지
  - Skill은 정상 흐름에서 수동 session 복사를 요구하지 않음
checks:
  - kernel-session-binding + kernel-run-env-resolution 32/32 통과
  - current HEAD와 working tree clean 확인
structuralReview:
  hardcoding: 추가 없음
  fallback: 추가 없음
  duplicatedAuthority: source-selection을 다른 Host/Skill에 복제하지 않음
  newAbstraction: 단일 consumer용 helper를 만들지 않음
commit: this Wave commit
push:
  remote: origin
  branch: main
  remoteHead: verified after push
  parity: required before W3
remaining: W3~W8
nextWave: W3
```

## W3 결과

```text
wave: W3
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: c1880e4b9705d0e2d169426bb72eee8a0b04f6e7
resultHead: this Wave commit
taskId: 4b8b1d6f-602d-4099-b965-b55f3f648055
kernelRunId: 없음
scope:
  - skills/moon-relay-kernel/SKILL.md
  - package/kernel/profiles/codex/skills/moon-relay-kernel/SKILL.md
  - tests/kernel-prompt-legacy-instruction.test.ts
  - artifacts/kernel-prompt-audit/prompt-inventory.json
  - STATUS.md
acceptance:
  - local debugging test와 Kernel completion proof의 역할을 분리
  - report 이후 Kernel이 outstanding hard obligation을 trusted execution 또는 exact reusable evidence로 settle하도록 안내
  - stale/flaky/explicit fresh 조건에서만 fresh execution을 요청하도록 지침 정합화
  - focused/integration/goal settlement와 existing evidence reuse semantics는 production 변경 없이 유지
  - canonical skill과 shipped Codex skill을 동일하게 유지
checks:
  - npm run build:tests: 283 tests, 8 helpers 생성 성공
  - W3 focused suite 45/45 통과
  - npm run typecheck 통과
  - npm run build:tests:check: 283 tests, 8 helpers, removed 0
  - git diff --check 통과
structuralReview:
  hardcoding: 없음
  fallback: 없음
  duplicatedAuthority: verification policy를 Skill에 새로 구현하지 않고 기존 Kernel settlement를 안내
  newAbstraction: 없음
commit: this Wave commit
push:
  remote: origin
  branch: main
  remoteHead: verified after push
  parity: required before W4
remaining: W4~W8
nextWave: W4
```

## W4 결과

```text
wave: W4
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: ff965da0ff70e3338d45fe8c8ef60728d8afd741
resultHead: this Wave commit
taskId: 4b8b1d6f-602d-4099-b965-b55f3f648055
kernelRunId: 없음
scope:
  - src/kernel/control-plane.ts
  - tests/kernel-host-loop-e2e.test.ts
  - STATUS.md
acceptance:
  - 외부 next의 Host binding preflight와 내부 continuation preparation 책임을 분리
  - contract preflight, delivery recovery, knowledge refresh, verification support, capability, baseline, Work Unit scope 검사를 prepareNext 단일 경로로 유지
  - report의 evidence/scope/capsule/finalization/success continuation이 raw buildNextForRun projection을 직접 만들지 않음
  - owner-direct failed/completed report.next가 explicit next와 semantic equivalence를 가짐
  - routed worker, review readiness, scope/recovery 안전 경계 유지
  - model-visible next 왕복 제거는 W5로 남기고 이번 Wave에서는 수행하지 않음
checks:
  - W4 focused core suite 44/44 통과
  - kernel-run-step-scope 2/2 통과
  - kernel-work-unit-recovery-e2e 4/4 통과
  - npm run typecheck 통과
  - npm run build:check: files 301, changed 0, removed 0
  - npm run build:tests:check: tests 283, helpers 8, removed 0
  - npm run check:boundaries: modules 9, files 301, edges 814
  - git diff --check 통과
structuralReview:
  hardcoding: 없음
  fallback: 없음
  duplicatedAuthority: report-side 직접 buildNextForRun projection 제거
  newAbstraction: 기존 next 준비 책임을 prepareNext 내부 primitive로 추출, 새 workflow/state 없음
commit: this Wave commit
push:
  remote: origin
  branch: main
  remoteHead: verified after push
  parity: required before W5
remaining: W5~W8
nextWave: W5
```

## W5 결과

```text
wave: W5
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: 924e37aea56cf13cccd44a73ce9d300f3a854883
resultHead: this Wave commit
taskId: 4b8b1d6f-602d-4099-b965-b55f3f648055
kernelRunId: 없음
scope:
  - src/kernel/bridge/mcp.ts
  - skills/moon-relay-kernel/SKILL.md
  - package/kernel/profiles/codex/skills/moon-relay-kernel/SKILL.md
  - package/kernel/profiles/ade/QWEN.md
  - tests/kernel-bridge-mcp.test.ts
  - tests/kernel-prompt-legacy-instruction.test.ts
  - STATUS.md
acceptance:
  - kernel_report가 이미 반환하는 canonical next continuation을 model-facing 기본 흐름으로 명시
  - 정상 report 직후 별도 kernel_next 호출을 요구하지 않음
  - 완료 판정은 kernel next 또는 kernel report.next의 canonical done continuation을 동일하게 인정
  - MCP tool description이 kernel_next를 start/re-entry/explicit refresh 용도로 한정
  - ADE/Qwen provider 지침의 강제 report→next 왕복 제거
  - kernel_report 한 번으로 pending Host review dispatch와 refreshed continuation 반환 E2E 고정
  - raw buildNextForRun report projection은 W4에서 이미 제거되어 추가 stale authority 없음
  - kernel_next 호환성 표면, diagnostic refresh, authority/workspace 변경 후 explicit refresh는 유지
checks:
  - W5 focused suite 33/33 통과
  - W4 equivalence/real-goal/scope/recovery 관련 suite 24/24 통과
  - real-usage/profile/compression/command-catalog suite 34/34 통과
  - npm run typecheck 통과
  - npm run build:check: files 301, changed 0, removed 0
  - npm run build:tests:check: tests 283, helpers 8, removed 0
  - npm run check:boundaries: modules 9, files 301, edges 814
  - git diff --check 통과
structuralReview:
  hardcoding: 없음
  fallback: 없음
  duplicatedAuthority: 없음; 기존 report.next canonical continuation을 소비하도록 지침만 수렴
  newAbstraction: 없음
  compatibility: kernel_next surface 유지, 정상 report 후 불필요한 왕복만 제거
commit: this Wave commit
push:
  remote: origin
  branch: main
  remoteHead: verified after push
  parity: required before W6
remaining: W6~W8
nextWave: W6
```

## W6 결과

```text
wave: W6
status: COMPLETE
workspace: /shared/moonshot-relay
baseHead: 57c1a807d3d2e19adeec2783e2209b5412b43c5d
resultHead: this Wave commit
taskId: 4b8b1d6f-602d-4099-b965-b55f3f648055
kernelRunId: 없음
scope:
  - src/kernel/bridge/mcp.ts
  - src/kernel/control-plane.ts
  - src/kernel/run/contract-preflight.ts
  - src/kernel/run/step-planner.ts
  - src/kernel/task/task-contract.ts
  - skills/moon-relay-kernel/SKILL.md
  - package/kernel/profiles/codex/skills/moon-relay-kernel/SKILL.md
  - tests/kernel-bridge-mcp.test.ts
  - tests/kernel-obligation-binding.test.ts
  - tests/kernel-preflight-execution-first.test.ts
  - tests/kernel-prompt-legacy-instruction.test.ts
  - tests/kernel-run-step-ledger.test.ts
  - STATUS.md
acceptance:
  - MCP contractJson은 기존 object schema 그대로 semantic Task Contract 입력으로 사용
  - 모델은 objective, acceptance statements, constraints, nonGoals, 알려진 bounded scope만 제공
  - acceptance ID, obligation wiring, digest, revision은 기존 Kernel normalization/compiler가 소유
  - declared semantic steps는 AC-* 또는 obligation ID를 직접 만들지 않아도 됨
  - 명시한 유효 ID는 narrowing으로 보존하고 unknown explicit ID는 기존처럼 fail-closed
  - 미배정 goal acceptance/obligation은 prose/path 추론 없이 최종 Work Unit에 보수적으로 귀속
  - initial plan과 replacement/replan이 동일한 final Work Unit settlement 규칙 사용
  - active contract revision의 불필요한 acceptanceIdMap preflight 전달 제거
  - successor compatibility merge의 canonical ID rebasing과 strict 검증은 유지
  - declared implementation step의 allowedPaths 필수 경계와 scope 차단 유지
  - objective를 acceptance로 복사하지 않으며 unknown scope를 모델이 allowedPaths: []로 주장하지 않도록 지침 정리
  - CLI --contract-json 경로 유지, 새 Contract v2 / --auto-contract / parallel schema 없음
checks:
  - W6 full focused suite 107/107 통과
  - final dead-wiring cleanup 후 preflight/obligation suite 53/53 통과
  - final dead-wiring cleanup 후 session lifecycle/continuation suite 13/13 통과
  - real-usage/profile/compression/golden suite 35/35 통과
  - model-facing semantic contract guidance 8/8 통과
  - npm run typecheck 통과
  - npm run build 통과: files 301, changed 2, removed 0, edges 814
  - npm run build:check 통과: files 301, changed 0, removed 0, edges 814
  - npm run build:tests:check 통과: tests 283, helpers 8, removed 0
  - npm run check:boundaries 통과: modules 9, files 301, edges 814
  - git diff --check 통과
structuralReview:
  hardcoding: 없음
  fallback: 없음
  newSchema: 없음
  newState: 없음
  newFlag: 없음
  duplicatedAuthority: active revision acceptanceIdMap 전달 제거
  inference: step prose/file path 기반 acceptance ownership 추론 없음
  compatibility: successor merge strict rebasing 유지, CLI contract-json 유지
commit: this Wave commit
push:
  remote: origin
  branch: main
  remoteHead: verified after push
  parity: required before W7
remaining: W7~W8
nextWave: W7
```
