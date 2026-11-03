# W0 T25 — Canonical Attempt별 물리 Worktree 격리 및 Writer 잔류 반례

- 작업 기준: 2026-11-03, `main / c16efdb8337347ae894e7ff630c876b35777bd37`
- 결과: **Attempt A의 물리 Writer가 계속 쓰는 동안 신규 Attempt B가 별도 Worktree를 사용하는 격리 검증 PASS**. 기존 Run 단위 Worktree 정리 후에도 A와 B는 보존된다. **Native Worker 기본 실행, 종료 증명, 안전 폐기는 미구현**. G0 PARTIAL / W1 DEFER 유지.

## 구현 경계

`src/host/kernel/workspace/physical-worktree.ts`에 명시적으로 호출하는 `prepareHostWriterAttemptWorktree`를 추가했다. 기존 `prepareStepWorktree`, `prepareExecutionWorkspaces`, `cleanupExecutionWorkspaces`의 기본 동작은 변경하지 않았다.

- 기존 `runtimeHome/projectId/runId/stepId` 외에 **Kernel이 발급한 `attemptId`**를 필수로 받아야 한다. 새로운 Run·Attempt 권위를 만들거나 Provider 모델 출력을 믿지 않는다.
- 프로젝트·Run 범위와 Step·Attempt 쌍을 SHA-256 기반 고정 디렉터리 이름으로 정규화해 동일 Attempt는 기존 물리 경로를 찾고, 다른 Attempt는 다른 물리 경로를 갖는다. 임시 UUID 재시도로 같은 Attempt의 Worktree가 무한 생성되는 구조를 만들지 않았다.
- Attempt 전용 디렉터리는 `executionRoot()` 아래가 아닌 별도의 `runtimeHome/host-writer-attempt-worktrees/` 하위에 둔다. 기본 Run 정리 코드가 `git worktree remove --force`로 미종료 Writer 디렉터리를 제거하지 않도록 분리했다.
- Host Runtime과 Owner 저장소의 실제 경로를 확인한다. Attempt 전용 Worktree가 Owner 저장소 안에 만들어질 배치면 `WORKTREE_HOST_WRITER_OWNER_OVERLAP`으로 거부한다.
- 동일 Attempt의 깨끗한 Worktree 재조회는 기존 `reuseWorktree` 검사로 처리한다. **재조회가 새로운 OS Writer 시작 허가는 아니다.** 기존 `reserveHostWorkspaceWriter` 예약이 있으면 같은 물리 경로에서 새 Writer 시작을 거부한다.
- Attempt 전용 Worktree의 자동 삭제/TTL은 구현하지 않았다. **Writer 본체와 후손의 실제 종료·쓰기 정착을 입증한 후에만 폐기**할 수 있다. 실제 운영용 안전 폐기 경계는 별도 미완료 항목으로 유지한다.

## 실제 격리 검증

임시 Git Owner와 Kernel Control Plane을 생성해 Run을 시작하고 첫 Canonical Attempt A를 만들었다. A 전용 Worktree를 준비하고 Host 외부 예약 파일을 만든 후 별도 Node OS 프로세스를 실행해 `writer-a.log`를 반복 append했다. A Writer가 계속 동작하는 상태에서 Kernel에 A Attempt 실패를 기록했다. **Kernel 실패는 Writer 종료를 뜻하지 않는다.**

같은 Run·Step의 새 Canonical Attempt B를 시작해 B 전용 Worktree를 만들었다. B는 별도 물리 디렉터리에만 `result-b.txt`를 썼다. A 예약은 여전히 B Host의 동일 경로 재예약을 거부한다. B 예약은 새 물리 경로에서만 허용한다. A의 기록은 계속 증가했고 Owner 저장소에는 어느 Worker의 파일도 나타나지 않았다.

추가로 이전의 일반 `prepareStepWorktree`를 한 번 만든 후 `cleanupExecutionWorkspaces(retain=false)`를 호출했다. 기존 Run 전용 디렉터리만 정리됐으며, 별도 Attempt A·B Worktree의 파일은 모두 유지됐다. 테스트는 **실제로 소유한 A OS Writer의 종료를 관측한 뒤에만** fixture Worktree를 명시적으로 삭제했다. 이는 제품 자동 종료/정리 구현을 뜻하지 않는다.

| 항목 | 결과 |
| --- | --- |
| 실제 Kernel Run/Attempt A·B 구분 및 다른 물리 Worktree | PASS (격리) |
| 동일 Attempt 재조회 시 추가 Worktree 생성 방지 | PASS |
| 기존 Host 예약으로 동일 Attempt 중복 Writer 시작 거부 | PASS |
| A 상태 실패 후에도 A OS Writer 추가 기록 | 위험 재현 |
| B의 독립 Worktree 쓰기 및 Owner 변경 없음 | PASS |
| 기본 Run 단위 Worktree 정리 후 Attempt A·B 유지 | PASS |
| Host Runtime이 Owner 저장소 안에 있는 잘못된 배치 | 거부 PASS |
| TypeScript 검사·Runtime 빌드·테스트 빌드 | PASS |
| 관련 확장 회귀 | **40/40 PASS** |
| 모듈 경계 검사 | PASS — 9 modules / 310 files / 845 edges |

격리 Linux MCP 개발 Checkout에서만 Node 테스트를 실행했다. 원본 저장소 `node_modules`, 계정 Codex 설치, 운영 Runtime·DB 및 사용자 작업 세션은 변경하지 않았다. 실제 모델은 호출하지 않았다.

## 적용 판단과 남은 조건

1. **기존 병렬 Dispatcher 전체에 적용하지 않는다.** 지금은 명시적 Host Writer용 Worktree 준비 함수다. 새 Attempt 생성 권한·기존 Kernel Step 상태·Owner CAS를 변경하지 않았다.
2. **Attempt ID만 다르면 자동 실행 가능하다는 뜻이 아니다.** 새 Attempt의 유효성·동시 실행 허가·Outcome/Report는 기존 Kernel 권위가 결정한다. 이번 실험은 물리 쓰기 격리의 동작을 검증한다.
3. **정착된 OS 종료 후의 안전 폐기 API와 디스크 회수 조건은 미구현**이다. 종료 증거 없는 자동 삭제를 금지하는 대신 운영 적용 전에 보존량/폐기 책임을 확정해야 한다.
4. **진짜 Native Writable Turn과 Kernel Attempt의 단일 Host E2E, Writable Worker Outcome 정착, Owner CAS 단일 Delivery, Host 재시작 및 후손 종료 증명은 남아 있다.** 보호된 예약 경로의 OS 권한과 Windows Native Job Object 대조도 필요하다.
5. 동일 프로젝트에 특화된 브랜치 이름, Provider 폴백, 별도 DB·Queue·Scheduler를 추가하지 않았다.

**결론: Attempt별 물리 Worktree 준비 경계는 격리 PASS. G0 PARTIAL / W1 DEFER.**
