# W1 — Agent/Host 작업 연속성·권한·인계 격리 검증

- 기준: `main / 1067ad32` (제품 변경 전); 2026-10-31
- 목표: Agent Local/MCP 병렬 실행에서 Run 소유권, 재개 및 인계 조건을 실제 Host에서 검증한다. 완료된 Run의 DB 삭제는 이 Wave에서 하지 않는다.
- 실행 표면: Windows 10 Native, WSL2 Linux MCP, macOS ARM64 Native, macOS Linux ARM64 MCP VM
- 작업 방식: 운영 DB/활성 Codex 세션은 읽기 전용 관찰. 별도의 `epk-w1-*` 폐기 fixture에서만 Kernel Run 생성·Report·다른 세션 ID 검증.
- 제품 코드 변경: `src/application/kernel-cli/main.ts`의 Host session 있는 CLI 진입 시 기존 Binding preflight 활성화. 전용 저장소/새 규칙 엔진/SQLite schema 변경 없음.
- 회귀: `tests/kernel-session-run-lifecycle.test.ts`에서 외부 세션 Report 거부 및 원본 Owner 정상 완료 테스트 추가.

## A. 동일 Host 격리 회귀 기준선

| 실행 표면 | 소스 (기존 기준선) | 테스트 | 종료 |
|---|---|---:|---|
| Windows Native | 1067ad32 | 29 / 29 | PASS |
| WSL2 MCP Linux | 1067ad32 | 29 / 29 | PASS |
| Mac Native | c53bcd63 (W0 이후 변경은 문서) | 29 / 29 | PASS |
| Mac MCP Linux VM | c53bcd63 | 29 / 29 | PASS |

호출 범위: `kernel-session-binding`, `kernel-session-run-lifecycle`, `kernel-parallel-fencing`. 권한 충돌, active owner, successor, stale fence, Git 완료 전 handoff, Run 초기화 rollback. **이 116개 통과는 각각의 OS에서 자체 임시 SQLite를 사용한 기존 코드의 기능 검증이지 Local↔MCP 실제 Run 인계 성공 증거가 아니다.**

## B. 실제 다른 OS의 동일 SQLite 파일 인계 실험

Host Native CLI에서 먼저 Run을 생성한 후, 같은 물리 DB를 공유마운트로 보는 MCP Linux에서 다른 세션 ID와 동일 Run ID로 `next`를 호출했다.

| 단계 | Windows Native → WSL2 9p MCP | Mac Native → virtiofs MCP |
|---|---|---|
| OS native `next --contract-json`로 임시 Run 생성 | PASS | PASS |
| Git 원격 없음, MCP에서 `next --run-id` | 거부: `runtime_binding_stale` | 거부: `run_project_mismatch` |
| Git origin 사전 설정한 새 fixture, MCP에서 `next --run-id` | 거부: `runtime_binding_stale` | 거부: `project_identity_git_common_dir_unverified` |
| 이후 원래 Host/Owner에서 `next --run-id` | 같은 Run 복구, `implement` | 같은 Run 복구, `implement` |
| 반환 후 Run `mutationRevision` | 0 | 0 |
| DB `PRAGMA quick_check(1)` | `ok` | `ok` |
| 원래 Owner Binding | 유지 | 유지 |

두 계층은 서로 다른 OS의 절대경로·Git common dir·Run Locator를 해석한다. 공유 파일은 프로젝트 Identity, Session Binding 또는 Fencing 권위를 통합하지 않는다. 단순 경로 문자열 치환·누락된 identity의 자동 재발급은 오히려 권위 분기를 만들 수 있으므로 구현하지 않는다.

## C. Native Host로 전달한 외부 세션 보고 P0

실제 MCP 호출의 Native Host execution으로 동일한 프로젝트와 Run을 지정하고, **소유자와 다른 Host Session ID**로 `next` 및 `report`를 실행했다.

현행 기준선에서는 양쪽 OS에서 다음이 재현됐다.

1. `next --session-id foreign`는 `implement`를 반환했고 기존 Owner Binding을 교체하지 않았다.
2. `report --session-id foreign`가 Kernel 검증 명령 `test`를 직접 실행했다.
3. Run은 `active → completed`; Verification 1개와 Completion Decision 1개가 저장됐다.
4. 기존 Owner Binding은 종료 전 자신이 직접 완료하지 않았는데도 `inactive`로 정착됐다.
5. 파일 변경은 없었고 `mutationRevision=0`; 테스트 명령은 실제로 성공했다. **이것은 가짜 검증 증거의 사례가 아니라 잘못된 세션의 제출 권한 허용 사례다.**

### 원인

`src/application/kernel-cli/main.ts`에서 모든 CLI의 `openControlPlane()`에 `requireHostBinding: false`를 전달하고 있었다. `src/kernel/control-plane.ts`의 `preflight()`는 Host Binding이 필수가 아니면 Session Owner 검사를 생략한다. 따라서 명시적 Session ID를 줘도 기존 `assertBoundRunAccess()`가 실행되지 않았다.

### 최소 수정 전략

`requireHostBinding: Boolean(sessionId)`로 변경한다. 실제 Host Session이 제공됐을 때 기존 Owner 검증을 활성화한다. 미지정 CLI는 신뢰하는 OS 사용자 직접 콘솔이라는 기존 호환 동작을 유지한다.

- **유지:** 직접 CLI 호출, 불변 Evidence 검증, 기존 Run/Trust/Knowledge 흐름, 기존 Host Bridge의 엄격한 Binding 검증.
- **차단:** Session ID를 명시한 다른 Host Session이 타인의 Run에 Report·Completion을 기록하는 행위.
- **잔여 경계:** OS 권한으로 직접 SQLite·CLI를 실행하는 계정은 신뢰된 실행자다. Session ID 없는 수동 CLI로 우회할 수 있다는 점은 Host 기반 접근 제어와 분리해 다룬다. MCP Bridge 자체는 항상 적절한 Host Session을 제공해야 한다. 새 인증/ACL 시스템을 만들지 않는다.

## D. Agent Session의 실제 보존 경로

- Windows Native `C:\Users\moon\.codex\sessions`와 WSL2 MCP `/root/.codex/sessions`는 Windows C:의 동일 계정 9p 경로다. 2026-10-31에는 양쪽 모두 4개 JSONL 파일 관측.
- Mac Native `/Users/seokgimoon/.codex`와 MCP VM `/root/.codex`는 virtiofs로 공유된 동일 계정 경로다. 확인한 `.codex/sessions/2026/10/31`의 JSONL 개수는 양쪽 0개였다.
- **판정:** Session 디렉터리 공유는 확인했지만 전체 Codex/ChatGPT 앱 세션 복구가 가능하다는 증거는 아니다. Mac의 앱-server 세션 저장 방식과 실제 resume 동작은 별도 확인해야 한다.

## E. Ephemeral Work로 남겨야 할 최소 활성 상태

| 객체 | 수명/권위 |
|---|---|
| Run/Task handle 및 Project/Worktree Identity | active 동안 Host authority. Agent Session 문자열만으로 대체 불가 |
| 정규화된 Task Contract digest, 허용 경로·필수 Acceptance | active 동안 유효한 범위·계약 원본 |
| 현재 Step, planRevision, mutationRevision | 정확한 재개와 stale proof 차단 |
| Owner Binding + Lease/Fencing | 실제 writer 권한. 요청에서 임의 재구성 금지 |
| 아직 정착되지 않은 Attempt, Report Key, Reviewer, Verification | 중단·재실행의 idempotence/Trust |
| Git closeout 및 required Knowledge 정착 진행 | 모든 부작용과 검증 저장이 끝나기 전까지 유지 |
| Agent Session ID 및 마지막 실행 위치 | 재개 힌트. 실행 권한 또는 검증 증거의 대체물이 아님 |

**완료 뒤** 모두 정착됐고 독립 Knowledge provenance에 필요한 최소 참조가 이전된 경우에만 Run/Attempt 등 임시 저장을 제거한다. W2 Knowledge 독립화·W3 정착 계약 완료 전에는 현재 DB 기록을 삭제하지 않는다.

## F. 남은 수용 조건과 Wave 판정

- 다른 OS의 raw SQLite 파일을 직접 여는 인계를 기본 성공 경로로 채택하지 않는다.
- Host 브리지 또는 소유 Host의 Kernel CLI 호출로 동일 작업을 수행할 수 있다. 단, **다른 세션이 Owner가 되는 실제 handoff API**는 별도 증명이 필요하다. 단순 Runtime 공유만으로 handoff를 주장하지 않는다.
- 호스트 종료/강제 재시작 및 새 Session으로의 명시적 소유권 이전 E2E는 별도 격리 확인이 필요하다. 운영 사용자 Codex 앱 프로세스는 강제 중지하지 않았다.
- Session Binding 우회 수정의 테스트·Windows Native/Mac Native 적용 결과를 아래에 반영한 후 판정한다. 미실행인 항목은 PASS로 승격하지 않는다.

## G. W1 수정·검증 결과 (추가)

### P0 수정 파일

- `src/application/kernel-cli/main.ts`: `openControlPlane()`의 상수 `requireHostBinding: false`를 `Boolean(sessionId)`로 변경했다. 새로운 권위 레이어·ACL·DB 테이블·환경별 폴백을 만들지 않았다.
- `scripts/application/kernel-cli/main.js`: 기존 TypeScript 빌드에서 생성된 canonical JS.
- `tests/kernel-session-run-lifecycle.test.ts`: Run 소유자의 초기 `next` → 외부 세션 `report` 거부 → Run active, revision 0, Verification 0, Completion 0 및 original owner binding 유지 → 원소유자 `report` 성공 회귀 반례.

### 검증 출처의 정확한 구분

- `npm run check:boundaries`: PASS, 308파일·841edges.
- `npm run build`: PASS, 308파일·841edges.
- `npm run build:check`: PASS, changed 0.
- **첫 번째 테스트 실행 `37/37`은 빌드 전의 구형 `dist/tests`를 사용했다. 새 테스트를 실행하지 않았으므로 새 수정의 회귀 통과 증거로 세지 않는다.**
- `npm run build:tests`: PASS, 289개 테스트/8개 헬퍼를 canonical TypeScript에서 갱신.
- `npm run build:tests:check`: PASS, 289개 테스트/8개 헬퍼 동일.
- 새 회귀만 실제 실행: Linux Node22 `1/1 PASS`, Windows Native Node `1/1 PASS`. 각 Host는 격리 `mkdtemp` runtime 및 fixture를 사용했다.
- 수정 후 실제 전체 4개 집중 테스트 파일을 재실행한 결과 Linux WSL2 **38/38 PASS (0 FAIL, 0 SKIP)**, exit 0. 이전 구형 빌드 기준선의 37/37과 구분한다. Windows Native 동일 4개 파일 **38/38 PASS (0 FAIL, 0 SKIP)**, exit 0. Windows Native 단독 새 반례도 1/1 PASS.

### 완료되지 않은 작업

- Windows Local↔MCP 및 Mac Local↔MCP **실제 승인된 소유권 이전/재개 E2E**. 두 OS에서 raw SQLite 공유를 통한 직접 인계는 원격 경로 차이로 거부됐다. 임의 path alias, Run ID 새 발급, 잠금 우회로 해결하지 않는다.
- Mac native 및 Mac MCP 설치본에서 이번 새 변경의 적용·검증. Mac baseline 29/29는 **수정 전** 소스의 증거다.
- 실제 사용자 Codex 세션 중단/복구. 안전한 임시 fixture와 계정 Session 디렉터리 공유 확인은 진행했으나, 활성 Codex app-server를 강제 재시작하지 않았다.

**판정은 기능 범위별이다.** Session-tagged foreign report 우회에 대한 W1 최소 수정은 해당 집중 테스트와 Windows Native 검증을 통과했으나, W1 전체는 **PARTIAL**이다. 다음 Wave의 영구 Run 제거를 허가하지 않는다.
