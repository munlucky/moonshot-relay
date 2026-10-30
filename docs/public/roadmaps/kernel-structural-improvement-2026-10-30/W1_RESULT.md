# W1 최종 결과 — Run 선택·재개 권위

- 판정: **PASS / keep-baseline** (W1 기존 코드의 검증 범위). W0~W10 전체 COMPLETE는 아님.
- 기준 코드: `b059f8074c5974e21056bc5a9952d7e60ede0973` (`main`). 기존 production 실행 엔진·DB schema·수명 규칙은 수정하지 않았다.
- W1 작업: `c2046ed2-32db-4bd2-8ff4-296de3de7d3e`.

## 실제 영속 SQLite 재현

`fixtures/w1-persisted-run-authority-probe.mjs`를 별도 `/tmp` Runtime에서 실행했다. 아래 상태를 동일한 SQLite 데이터베이스에 영속화하고, State Store 연결을 닫았다가 다시 열어 `resolveBoundInvocation`으로 확인했다.

| 저장된 상태 | 일부러 만든 교란 조건 | 재시작 후 판정 |
|---|---|---|
| Active Run | 같은 프로젝트의 **완료된 다른 Run**에 연결된 active Session Binding이 같은 Host Session ID로 남아 있음 | `resume`, 실제 Active Run ID 유지 |
| Blocked Run | 새 Session으로 조회하고 Workspace Identity는 `null`인 부분 관측 | `resume`, 기존 Blocked Run 유지 |
| Completed + finalized Run | 과거 Session Binding이 여전히 active로 조회되는 비정상 경계 | `done`, 완료 Run ID 유지 |
| Completed Run + 다른 Task Contract | 동일한 stale Session Binding 존재 | `successor`, 원래 완료 Run이 predecessor |
| Blocked Run + 다른 Task Contract | 그 Run에 유효한 worktree mutation lease가 없는 경우 | `create`, Blocked Run은 그대로 보존 |
| 명시적 다른 Workspace Run ID | 기존 Session Binding이 잘못된 Run을 가리킴 | 명시적 binding mismatch를 fail-closed |

이 fixture는 **정상 Host 소유권 절차로 완료된 Session을 생성한 것**이 아니라, 결함 반례를 확인하기 위해 완료된 Run에 활성 Session Binding을 의도적으로 만든 격리 DB다. 실제 계정 DB에서 수정·재생하지 않았다.

## 기존 회귀 및 결론

- `kernel-run-locator-fail-soft`, `kernel-session-run-lifecycle`, `kernel-workspace-recovery` 집중 테스트 **16/16 PASS**(격리 HOME/Runtime/TMPDIR, 56.56초).
- `src/kernel/run/invocation-resolver.ts`는 Task/Project/Workspace·명시적 Run ID를 근거로 선택한다. `src/kernel/run/run-locator.ts`는 주소록을 내구 권위로 격상하지 않는다. Session Binding은 접근 수명으로 한정된다.
- Moonremote MCP `get_work_context`의 `completeness=partial`, `head=null`, `time_budget_exceeded`는 **MCP 측 관측 결과**다. 저장소의 Kernel 코드/Host 브리지에서 그 값을 Run 선택 입력으로 직접 해석하는 경로를 발견하지 못했다. 동일 checkout에서 직접 `git rev-parse`는 HEAD를 정상 반환했다. 이것만으로 Kernel이 잘못된 Run을 선택하거나 작업을 차단한다고 추론할 수 없다.
- 실제 `get_work_context` 관측 신뢰성 문제는 **Moonremote 전송/관측 계층의 외부 소유 항목**으로 구분한다. W1 PASS가 MCP 관측 문제의 해결을 뜻하지는 않는다.

## 변경하지 않은 이유와 남은 책임

W1 범위에서 새 원인으로 입증된 잘못된 Run 선택, 잘못된 임의 abandon, 재개 불능은 재현되지 않았다. 기존 Run 선택 코드에 추가 Fallback, 자동 수정, Session별 고정 규칙, 새 authority 저장 필드를 도입하면 중복 권위를 늘리고 복구 신뢰 경계를 약화시킬 위험이 있다. **생산 코드는 keep-baseline**으로 보존했다.

W8은 Host Session 수명·설치·Project Identity 원천 정책만 소유한다. W3-B는 승인 후 Git 전달 및 Identity 사용 지점 복구를 소유한다. W1의 Run 선택 구현을 이 Wave들에서 중복 수정하지 않는다.

W2부터 다른 Wave는 독립적으로 시작할 수 있다. 다른 Wave에서 실제 W1 반례가 발견되면 기존 재현 fixture와 비교해 필요할 때만 W1 결정을 다시 연다. 통합 계획 전체 판정은 여전히 미완료다.
