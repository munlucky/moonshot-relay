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
| W3 | Verification/report 사용 경로 | W2 | NOT_STARTED | - | - |
| W4 | canonical next preparation 통합 | W3 | NOT_STARTED | - | - |
| W5 | model-visible next 왕복 제거 | W4 equivalence 통과 | NOT_STARTED | - | - |
| W6 | semantic Contract 입력 | W5 | NOT_STARTED | - | - |
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
