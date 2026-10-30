# W1 Run 선택·작업 재개 권위 조사 기준선

- 시작: 2026-10-30, W0 최종 기준선 commit `40921a61a297fd33084c8368c792dfc7d6dc3baf29`
- W1 작업 추적: `c2046ed2-32db-4bd2-8ff4-296de3de7d3e`
- 판정: **W1 IN PROGRESS**, 코드 변경 없음. 현재 테스트로 재현된 W1 제품 결함은 없다.

## 현재 소스에서 확인한 권위 경계

- `src/kernel/run/invocation-resolver.ts`: Project/worktree·Task Contract와 명시적 Run ID가 실행 선택의 근거다. Provider/Session ID는 검증된 접근 핸들이며 Task identity가 아니다.
- `src/kernel/run/run-locator.ts`: Locator는 Runtime 주소록이며 상태 권위가 아니다. 미존재 Runtime이나 Run은 stale로 판정하며, 명시한 stale `--run-id`는 새 Run으로 대체하지 않는다.
- `src/kernel/run/session-binding.ts`: Session Binding은 접근 수명/권한이다. 같은 Session이 작업 identity를 소유하는 별도 경로를 만들지 않는다.
- Blocked Run에 새 Task Contract가 들어오는 경우 기존 holder를 보존하거나 조건에 따라 abandon/lease reclaim하는 현재 정책이 존재한다. 이를 임의로 제거하면 기존 보호 동작을 깨뜨릴 수 있다.

## W1 읽기·실행 검증

격리 HOME·Runtime·TMPDIR에서 `tests/kernel-run-locator-fail-soft.test.mjs`, `tests/kernel-session-run-lifecycle.test.mjs`, `tests/kernel-workspace-recovery.test.mjs`를 순차 실행했다. **16/16 PASS, 실패 0, 56.56초**. stale Locator의 Turn 0 새 Run, 명시적 stale Run fail-closed, Session Binding 비권위, active Run의 불법 successor 차단, 완료 후 successor, finalization 미완료 차단, workspace 변경 승인 경계를 포함한다.

기존 백업에서 Session Binding 415건(active 25건)이라는 개수는 검증됐지만, 그 자체로 다른 Run을 잘못 선택한 사례를 증명하지 않는다.

## C01 원인 소유권 분리

- Moonremote `get_work_context`는 `time_budget_exceeded` 시 `head=null`, `completeness=partial`, `inspectedFiles=0`으로 반환한 반면, 별도의 명시적 Git 명령은 HEAD와 clean 상태를 확인했다.
- 이는 Moonremote **관측 예산과 결과 표현**의 차이다. 이 데이터만으로 Kernel의 Run authority가 유실되거나 실제 구현 작업이 차단됐다고 판정하면 안 된다.
- Moonremote 연결 도구의 부분 관측은 외부/전송 경계에서 조사하고, Kernel W1의 수정 조건은 동일한 현상이 실제 Run 선택 오류·승인 후 재개 실패로 연결된 증거가 있을 때로 한정한다.

## 다음 실행 검증

1. 독립 Runtime fixture에 Active/Blocked/Completed Run과 stale Session Binding을 함께 구성하고, 올바른 Run 선택 또는 의도된 fail-closed를 검증한다.
2. 부분 관측(null HEAD, 관측 예산 초과)이 입력된 실제 Kernel 경로가 있는지 추적한다. 연결이 없다면 Moonremote 관측 문제를 Kernel에 새 규칙으로 흡수하지 않는다.
3. 잘못된 Run 선택·임의 abandon·중단 후 미복구 등 실제 결함이 재현되는 경우에만 가장 작은 기존 authority 경계에서 수정하고 집중 회귀 후 다음 결과를 판단한다.

Wave 소유권: W1은 Run 선택·재개 권위만 수정한다. W8의 Host Session 수명·Identity 원천 정책, W3-B의 승인 후 Git 전달은 이 Wave에서 중복 구현하지 않는다.
