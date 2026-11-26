# Moon Relay Kernel 세션·Run 수명주기

Last-Reviewed: 2026-07-30

Moon Relay Kernel은 Host 세션, Kernel Run, 프로젝트, 실제 workspace를 서로 다른 권한 경계로 취급한다. 모델에 공개되는 명령은 계속 `kernel next`와 `kernel report`뿐이며, Run 생성·재개·후속 전환은 Host와 Control Plane이 결정한다.

## Identity 계약

- Host 세션은 `<provider>:<native-session-id>` 형식이다. 같은 native ID라도 `codex:*`와 `claude:*`는 다른 세션이다.
- 새 Run ID는 `run-<uuid>` 형식의 opaque 값이다. thread, session, objective, project 또는 경로에서 유도하지 않는다.
- `CODEX_THREAD_ID`는 Codex Host 세션을 부트스트랩할 수 있지만 Run ID가 아니다.
- `MOON_RELAY_KERNEL_RUN_ID`는 명시적 Run 검증·재개용이고, `MOON_RELAY_KERNEL_SESSION_ID`는 현재 Host 세션용이다.

## 계약 우선 해석

`next --contract-json`은 먼저 Task Contract와 현재 project/session/workspace binding을 읽은 뒤 다음 모드 중 하나를 고른다.

| Run | Finalization | 계약 | 결과 |
|---|---|---|---|
| 없음 | 없음 | 있음 | `create` |
| active/blocked | pending | 동일 | `resume` |
| active/blocked | pending | 변경 | `revise` |
| completed | partial/blocked | 무관 | `finalization-retry` (영구 게이트 실패 시 `abandon` 또는 `workspaceRecovery`) |
| completed | completed | 없거나 동일 | `done` |
| completed | completed | 새 계약 | `successor` |

`report`는 successor를 만들지 않으며 현재 active owner binding의 Run에만 기록한다.

### 미완료 finalization (`incomplete_gates` / `blocked`) 복구

`completed` 상태의 Run이 외부 커밋 등으로 인해 `finalizationStatus`가 `blocked`/`incomplete_gates` 상태로 고착되어 `finalize`가 더 이상 통과할 수 없는 경우, 다음 두 공식 복구 경로 중 하나를 사용한다.

1. **Workspace 기준선 복구(`workspaceRecovery`)**: `kernel next --contract-json ... --invocation-intent new-task`에 `taskContract.workspaceRecovery.acknowledgedIdentity`를 현재 관찰된 workspace identity와 일치시켜 전달하면, 이전 미완료 Run과 분리된 새 `create` Run으로 시작한다. (`pending`/`partial`처럼 아직 재시도 가능한 finalization은 기존대로 `finalization-retry`로 유지된다.)
2. **명시적 Run 정리(`kernel abandon`)**: `kernel abandon --run-id <run-id> --reason <text>`는 `finalizationStatus !== 'completed'`인 미정산 `completed` Run도 `abandoned`로 전환하여 새 Run을 열 수 있게 한다. (`finalizationStatus === 'completed'`까지 마친 Run은 불변 이력을 위해 `alreadyTerminal: true`를 유지한다.)

### Linked `git worktree` 프로젝트 신원 귀속

`git worktree add`로 생성된 linked worktree는 primary repo와 동일한 `gitCommonDir`을 공유하므로 기존 등록된 `projectId`에 자동 귀속되며, 각 worktree는 별도의 `worktreeId`/`workspaceId`를 가진다. 동일 저장소에서 동일 remote URL을 다른 체크아웃(예: 컨테이너 경로 등)이 이미 소유하고 있더라도 `canonical_root` 또는 `gitCommonDir` 증명이 확인된 기존 프로젝트/linked worktree는 해당 프로젝트 신원을 그대로 유지한다.

## Successor 원자성

완료·finalization 완료 Run에 새 계약이 들어오면 Kernel은 하나의 SQLite transaction 안에서 successor Run과 초기 obligation/step을 만들고, 새 owner binding을 설정하고, 이전 binding을 `successor_started`로 종료하며, lineage와 이전 workspace lock 해제를 기록한다.

멱등 키는 `projectId`, provider-scoped `sessionId`, predecessor Run, successor workspace, Task Contract digest의 해시다. 같은 요청을 다시 보내도 successor가 추가 생성되지 않는다. predecessor의 objective, 상태, finalization, workspace와 owner lineage는 수정하지 않는다.

완료된 predecessor는 같은 프로젝트에 등록된 다른 worktree로 successor를 넘길 수 있다. active/blocked Run은 workspace를 이동할 수 없다.

## Workspace mutation 정책

- 서로 다른 physical workspace/worktree는 병렬 mutation이 가능하다.
- 같은 workspace에서는 fencing token이 있는 V2 lock 소유자 하나만 mutation할 수 있다.
- reviewer와 read-only binding은 같은 workspace를 공유할 수 있지만 `next`, `report`, finalize 같은 owner mutation 권한은 없다.
- lock 해제는 workspace, Run, session token, fencing token이 모두 일치해야 한다.

충돌 시 `workspace_mutation_conflict`와 `nextAction: create-worktree`를 반환한다. stale 또는 바뀐 lock을 넘기려 하면 `workspace_lock_handoff_failed`로 fail closed 한다.

## 호환성과 doctor

스키마 변경은 additive다. 기존 `codex-*` Run, receipt, evidence, knowledge와 legacy binding을 삭제하거나 다시 쓰지 않는다. provider가 검증되는 legacy binding만 한 번 canonical namespace로 이전하며, 중복 active owner가 있으면 임의 선택 없이 열기를 거부한다.

`kernel doctor --json`은 다음 코드를 보고한다.

- `ambiguous_session_binding`
- `terminal_run_active_binding`
- `orphaned_run_owner`
- `binding_namespace_problem`
- `stale_workspace_lock`

권한 경계 위반은 `run_session_mismatch`, `run_project_mismatch`, `run_workspace_mismatch`, `run_access_denied`, `provider_session_invalid` 등 안정적인 `errorCode`와 복구용 `nextAction`으로 반환한다.
