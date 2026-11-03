# W0 T25 — 실제 Writer가 살아 있는 Owner Delivery·Attempt·CAS 통합 회귀

- 검증일: 2026-11-03 (KST)
- 코드 기준선: `main / 733c379d4b7b7d7b76a210eefcfef0b0936943cd`
- 변경 대상: `tests/kernel-parallel-fencing.test.ts`의 **실제 OS Writer + 기존 Kernel Control Plane 통합 테스트 1개**. 제품 Runtime, DB 스키마, Native Codex adapter 변경 없음.
- 판정: **격리된 A Writer가 계속 쓰는 동안 B의 Owner Delivery·Mutation CAS와 오래된 결과 거부 PASS. 동일 물리 Workspace Writer 재할당 및 실제 Native 핸들↔Attempt 매핑은 미검증. G0 PARTIAL, W1 DEFER.**

## 검증 경로

기존 `createKernelControlPlane`/`beginAttempt`/`acquireOwnerWorkspaceMutationFence`/`assertOwnerWorkspaceMutationReady`/`recordOwnerWorkspaceMutation`/`releaseOwnerWorkspaceMutationFence`를 사용했다. 독립된 Git Owner Checkout과 Worker A/B Worktree를 동일한 기준 커밋에서 생성했다. 별도 Node OS 프로세스인 Writer A는 **자신의 Worktree**의 `shared.txt`에 짧은 주기로 append/fsync하며 살아 있는 상태를 유지했다.

1. 기존 Kernel의 Canonical Run과 **started Attempt**를 만든 뒤 원래 Owner Workspace Revision·Identity·HEAD를 보존.
2. A의 실제 OS 프로세스가 파일을 최소 5회 기록했고 실행 중임을 확인.
3. B의 별도 Worktree에서 `B:only` 수정 patch를 만들고, 기존 Kernel Owner Fence/CAS를 통해 Owner Checkout에 적용.
4. `recordOwnerWorkspaceMutation` 성공, Mutation Revision은 **정확히 +1**.
5. B 반영 뒤에도 A가 별도 Worktree에 계속 기록하는 동안 Owner `shared.txt`는 `B:only` 유지.
6. 원래 Mutation Revision으로 다시 Owner mutation을 기록하면 `delivery_mutation_revision_stale` 거부.
7. 테스트 종료 시 A 프로세스를 종료하고 Worktree와 임시 Runtime을 제거.

이 시험은 기존 [T25 추가 반례](W0_T25_ADDITIONAL_NEGATIVE_VERIFICATION_2026-11-03.md)에서 검증하지 못한 **실제 Kernel Owner CAS 호출**을 포함한다. 반면 B가 동일 Workspace에 직접 쓰도록 요청하는 Dispatch Gate 자체는 아직 검증하지 않았다.

## 검증 결과

| 범위 | 결과 |
| --- | --- |
| 독립 Worktree에서 A 실제 OS Writer 활성 관측 | PASS |
| Kernel Canonical Attempt 생성 | PASS |
| B 변경을 기존 Owner Fence·CAS 경유로 반영 | PASS |
| Owner Mutation Revision 1회 증가 | PASS |
| A의 후속 쓰기가 Owner 파일에 유입되지 않음 | PASS (격리 fixture) |
| 구 Revision의 결과 재적용 | 거부 PASS |
| 살아 있는 A의 동일 Workspace B Dispatch 차단 | **NOT TESTED** |
| 실제 Native `commandExecution` 식별자와 Kernel Attempt 연결 | **NOT IMPLEMENTED** |
| Native 도구 후손 OS 프로세스 완전 종료 | **NOT VERIFIED** |

**격리 검증 경로:** canonical 저장소의 `NODE_ENV=production` 설치 상태에는 `@typescript/typescript-linux-x64` 플랫폼 패키지가 없어서 직접 `npm run typecheck`가 시작 전 실패했다. 이 문제를 소스 결함으로 분류하지 않았다. `git archive HEAD`와 수정한 Canonical 테스트 1개를 별도 `/tmp` checkout에 배치하고 개발 의존성을 그 임시 checkout에만 설치했다. 원본 `node_modules`는 수정하지 않았다.

- TypeScript 검사: **PASS**
- 테스트 Runtime 빌드: **PASS**
- `kernel-parallel-fencing`: **9/9 PASS** (신규 1건 포함)
- `kernel-workspace-mutation-lock` / `kernel-parallel-dispatch` / `kernel-run-step-resume`: **14/14 PASS**
- `check:boundaries`: **PASS**, 9 modules / 308 files / 842 edges
- 합계 **23/23 테스트 PASS**. 전체 저장소 전수 Suite 또는 실제 사용자 Native Host E2E PASS를 의미하지 않는다.
- MCP 실행 영수증: 최초 집중 검증 `20b89492-20dc-4bf1-91a1-11dd8c9a6f23`, 수정 후 집중·관련·경계 `8c1017d1-f27d-4c05-a1a2-3be463b04067`.

## 안전 경계 및 다음 코드 작업

- **기존 CAS는 Delivery 권위이고 OS Writer 중단 권위가 아니다.** 새 테스트는 A가 Owner를 직접 쓰지 못하는 물리 격리를 전제로 한다.
- 기존 `src/host/kernel/adapters/codex.ts`는 주입된 `spawn_agent` 완료를 기다릴 뿐 실제 App Server `item/started`·`processId` 수명 이벤트를 소유하지 않는다. 현재 데이터로 `turn/interrupt`/`backgroundTerminals/terminate`를 “물리 종료 증명”으로 대체할 수 없다.
- 다음 변경은 **기존 Host가 소유하는 Native 실행 스트림**에서 `runId/stepId/attemptId/workspaceId`와 `threadId/turnId/itemId/processId`를 일치시켜 전달하는 접점을 검증해야 한다. 값이 없으면 null/unknown으로 유지한다.
- **동일 물리 Workspace**의 Writer A가 살아 있거나 종료를 알 수 없으면 B의 Dispatch를 차단하는 내부 Gate를 아직 구현하지 않았다. 구현 때에는 기존 owner-direct 실행·복구를 무조건 차단하는 전역 정책을 만들지 말고, Host가 실제 관리하는 격리 Worker 경계에 한정해야 한다.
- 별도 Worktree에서 B를 준비할 수 있더라도 Owner 적용은 기존 Fence/Revision/CAS와 늦게 도착한 A 결과 거부를 통과해야 한다.
- 새 DB·Queue·Scheduler·무조건 PID Kill·Provider 버전별 폴백·복제된 Kernel 완료 권위를 도입하지 않는다.

**G0 판정 유지: PARTIAL, W1 제품 기능 도입 DEFER.** 이번 Wave는 실행 가능한 최소 통합 회귀 테스트의 증거를 정착시키는 단계다.
