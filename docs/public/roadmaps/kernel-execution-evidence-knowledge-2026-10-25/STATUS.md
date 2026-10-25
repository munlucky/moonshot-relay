# 실행 상태

기준 브랜치: `main`

이 파일은 작업 인덱스다. Moonremote checkpoint나 Git remote parity를 대체하지 않는다.

| # | 프리셋 | 상태 | Commit | origin/main parity |
|---|---|---|---|---|
| 01 | A0 Characterization | COMPLETE | 66cabf23 | verified |
| 02 | A1 Identity + Evidence | COMPLETE | current Preset 02 commit | verified after push |
| 03 | A2+A3 Proof Delta + Failure Ownership | NOT_STARTED | - | - |
| 04 | A4 Knowledge Quality | NOT_STARTED | - | - |
| 05 | A5 Knowledge Reuse | NOT_STARTED | - | - |
| 06 | A6+A7 Usage Receipt + Historical Replay | NOT_STARTED | - | - |
| 07 | B1+B2 Policy/Prompt Reduction | NOT_STARTED | - | - |
| 08 | B3 Control Plane / State Store Thinning | NOT_STARTED | - | - |
| 09 | B4 Final Replay + Complexity Audit | NOT_STARTED | - | - |

허용 상태:

`NOT_STARTED`, `IN_PROGRESS`, `BLOCKED`, `COMPLETE`, `VERIFIED_EXISTING`

## Preset 01 evidence

- Baseline: `A0_CHARACTERIZATION_BASELINE.md`
- Focused characterization: **108/108 pass**
- Production source changes: **0**
- New fixtures: **0**
- Kernel Run: `run-f69c4809-f56b-474b-8e96-81b7c14ae1d7`
- Default account-root runtime observation: `project_identity_git_common_dir_unverified`
- Characterization Run: isolated temporary runtime, no repository/runtime production state adoption

프리셋 종료 시 실제 결과만 기록한다.

## Preset 02 evidence

- Initial Kernel Run: run-ebe47a8a-8aa3-4fb9-881d-278e769bb0cd (textual cleanup 전 proof)
- Production source changes: **1 file** — src/kernel/persistence/trust-store.ts
- Focused identity/evidence regression: **29/29 pass**
- TypeScript typecheck: **pass**
- Runtime build freshness: **308 files / 829 edges, changed 0**
- Test build freshness: **289 tests / 8 helpers**
- Boundary check: **9 modules / 308 files / 829 edges**
- Initial Kernel proof: test:kernel-reliability **pass**. 이후 textual cleanup으로 workspace identity가 바뀌어 최종 freshness evidence로 사용하지 않는다.
- Final Kernel authoritative proof: isolated final Run `run-66ad1736-757c-48c7-b1fe-24ca6b1b42ae`에서 `test:kernel-reliability` 통과, Kernel completion `accepted / done`.
- Final evidence digest: `sha256:5b34dba0c66498df74cf09f53d4a3aa0140bd260ef737ddf3829207997218a44`.
- Evidence merge: 동일 Evidence Identity에서 kernel-runtime evidence가 weaker/unobserved caller attestation에 의해 덮이지 않으며, 동일 authority의 contradiction은 current evidence를 갱신한다.
- Source/workspace identity drift: 과거 verification history는 보존하고 Trust Authority freshness만 stale로 판정한다.
- Workspace/Runtime identity: 기존 linked-worktree authority와 runtime-home canonicalization을 재사용했다. 새 identity subsystem, alias registry, writable state, fallback chain은 추가하지 않았다.
- Knowledge observation commit: canonical knowledge type 불일치로 0건 commit. knowledgeRequired=false였고 Kernel completion은 accepted / done이었다. 이 프리셋에서는 knowledge schema를 확장하거나 fallback을 추가하지 않았다.
