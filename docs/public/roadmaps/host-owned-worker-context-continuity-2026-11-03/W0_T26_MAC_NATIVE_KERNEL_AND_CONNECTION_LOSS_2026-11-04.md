# W0 T25/T26 — 실제 Mac Codex + Canonical Kernel Attempt 및 연결 상실 반례 검증

- 날짜: **2026-11-04**
- 코드 기준선: `main / b6054a146e7d37b5d5a22b5f97f9ae3de46c51f5`
- 변경: `tests/kernel-codex-app-server-transport.test.ts`에 단일 T26 연결 상실 테스트 추가. 기존 Host/Kernel 제품 코드는 변경하지 않는다.
- 결론: **실제 Mac Native 모델·Kernel Attempt 단일 Host E2E PASS**, **App Server 재실행 후 Canonical Attempt/예약 재조회 PASS**, **실제 Mac `command/exec` Workspace Sandbox 외부 쓰기 거부 PASS**, **Linux T26 clean Workspace 연결 상실 시 중복 Writer 시작 거부 87/87 회귀 PASS**. **OS Writer 후손 전체 종료·단일 Owner Delivery·안전 폐기 미검증 → G0 PARTIAL / W1 DEFER.**

## 1. 격리·실행 환경

Mac Native Host는 Darwin, Node `v24.6.0`, Codex CLI `0.162.1`이다. 원본 Mac Git 저장소는 `3797c60f662d7b61e7b57b00bc41f96bf7525e94`에서 **clean** 상태로 보존했다. 원격 `main`의 기준 SHA를 `/tmp/moonrelay-w0-mac-real-attempt-Pg7Oqk/source`에 별도 clone하고 `npm ci`, TypeScript 검사 및 정규 Runtime 빌드를 수행했다. 격리 W0 Codex 인증 홈 `~/.local/state/moonshot-relay/w0-codex-auth`만 사용했다. 사용자 운영 Codex 세션·계정 설치·원본 Checkout·운영 Kernel DB는 변경하지 않았다.

실제 모델 호출은 **Mac Native Codex 실행 테스트에만 사용**했다. 첫 E2E 모델은 `gpt-6.1-sol`, effort `medium`이다. 그 외 코드는 Moonremote MCP의 Linux 저장소에서 수정·검증했다.

## 2. 실제 Native 모델 + Canonical Kernel 단일 Host E2E

Mac 임시 Owner Git 저장소와 새 Kernel Runtime에서 `createKernelControlPlane`로 Run 및 `started` Attempt를 생성했다. 배포 코드 `runHostOwnedWritableAttempt`를 그대로 호출하여 **Attempt별 물리 Worktree 준비 → Workspace 등록·Attempt 소유권 정착 → Host 외부 예약 → 실제 Codex App Server `thread/start`·`turn/start` → Command 이벤트 관측**을 한 Mac Node 프로세스에서 수행했다.

실제 모델은 Attempt 전용 Workspace에 `w0-native-proof.txt`를 작성했으며 파일은 정확히 `MAC_KERNEL_ATTEMPT_OK\n`이었다. `item/started`와 `item/completed` 두 Command 이벤트가 관측됐고, 모든 Command 이벤트의 Run·Step·Attempt·Workspace 소유권이 해당 Canonical Attempt와 일치했다.

| 독립 검사 | 결과 |
| --- | --- |
| Canonical Kernel Run·Attempt 발급 및 활성 상태 | PASS |
| 실제 Codex Native Writable Turn `completed` | PASS |
| 같은 명령의 started/completed 이벤트 | PASS |
| Command 이벤트의 Canonical Attempt·Workspace 일치 | PASS |
| Attempt 전용 물리 Worktree에 실제 파일 쓰기 | PASS |
| Owner Git 상태 clean 유지 | PASS |
| Host 외부 Writer 예약 파일 잔존 | PASS |
| Turn 완료 뒤 Kernel Attempt `started` 유지 | PASS |
| `writerExitVerified=false` 및 `reportAuthority=none` 유지 | PASS |

구조화된 검증 영수증은 **Mac MCP `operationId=5c740f03-0587-4ab1-a092-541f0d39f054`, exit 0**이며, `native-evidence.json`에 개별 항목이 기록됐다. 별도 Mac 프로세스에서 Kernel Runtime을 다시 열어 Run·Attempt·Workspace ID, 파일 내용, Host 예약, Owner clean, 미완료 상태 등 **7개 재조회 조건 모두 PASS**했다(`operationId=f77c57a2-9bc1-4fab-9ceb-62a1b049d7bb`, exit 0).

**범위 구분:** 실제 Native 명령이 완료됐다는 것은 모델 Turn과 해당 명령 항목의 이벤트가 종료됐다는 뜻이다. 이 결과는 **모든 OS 자식·후손이 사라졌다는 강한 종료 증명은 아니다.** Kernel Report, Review, Owner CAS Delivery도 실행하지 않았다.

## 3. Native macOS 샌드박스 쓰기 경계

실제 모델에게 외부 임시 시험 파일 삭제를 요청한 별도 시도는 먼저 Kernel `worktree_run_conflict`로 거부됐다(동일 Owner의 기존 Run 활성). Kernel 권위를 우회하거나 해당 Run을 임의 종료하지 않고 다른 격리 Kernel Runtime을 사용했다. 이후 모델 Turn은 `completed`였으나 Command 이벤트가 **0건**이어서, 모델의 삭제 시도를 확인할 수 없었다. 이 **모델 기반 시험은 INCONCLUSIVE**이며 PASS 근거에서 제외한다.

대신 **Codex CLI 0.162.1에서 생성한 실제 App Server JSON Schema의 `CommandExecParams`**를 확인했다. `command/exec`는 Thread/Turn 없이 독립 명령을 실제 서버 샌드박스에서 실행하며, 최종 응답은 해당 실행 프로세스가 종료한 후 반환된다. 다음 시험은 **새 독립 디렉터리**를 Worker로 사용해, 이전 Native Attempt Worktree에 재진입하지 않았다.

- 명시적 정책: `sandboxPolicy.type=workspaceWrite`, `writableRoots=[해당 Worker 실제 경로]`, `networkAccess=false`, `excludeSlashTmp=true`, `excludeTmpdirEnvVar=true`.
- Worker 내부 `direct-ok.txt` 쓰기: **PASS**.
- Worker Worktree 바깥 Host 전용 경로의 **가짜 테스트 센티널** 삭제: **exit 1, "Operation not permitted"**, 파일 그대로 유지.
- 독립 `command/exec` 자체 종료: exit 0 (복합 셸 명령의 최종 종료). 내부 삭제 시도의 오류 코드는 별도 파일로 확인했다.
- Mac MCP `operationId=c4a58a14-0b0f-44a4-9bc9-1c2a3b6d9ca1`, exit 0. 구조화된 `direct-sandbox-evidence.json`의 검사 **5/5 PASS**.
- 동일 Mac 계정의 **비격리 프로세스**는 그 테스트 파일에 쓰기 권한이 있었다. 따라서 이 결과를 **OS 계정 전체의 강제 ACL 방어**로 확대하지 않는다. 검증한 것은 해당 정책의 **샌드박스 내부 프로세스**다.

실제 Writer 예약 파일 자체는 삭제 시험에 사용하지 않았다. 모든 삭제 시도는 별도 임시 센티널로 제한했다.

## 4. T26 연결 상실 및 같은 Attempt 중복 실행 금지

Linux MCP 회귀에 `TEST_MODE=writable-disconnect`를 추가했다. 모의 Codex App Server가 **Writable `turn/start` 요청을 받은 뒤 종료**하는 반례다. Thread/Turn 시작 전 Host 외부 예약은 이미 생성됐지만, 모델의 실제 실행 상태와 OS 후손 생존 여부는 알 수 없다.

이때 실제 Kernel `Run/Attempt`와 불변 Workspace ID는 **`started`로 유지**되고, 원격 Host의 같은 Attempt 재시작은 **외부 예약 `EEXIST`로 거부**된다. 시험은 Worktree 안에 임의 변경 파일이 없는 깨끗한 상태에서도 거부됨을 확인했다. Owner Git 상태는 clean을 유지한다.

- 새 연결 상실 반례 포함 집중 검사: **15/15 PASS**, Linux MCP `operationId=7c5895de-6e8c-4cbe-beb9-43072637cfad`.
- Native Transport·Kernel Attempt·Parallel Fencing/Recovery·Workspace Lock·Codex Adapter 등 관련 확장: **87/87 PASS**, `operationId=369ab1ea-4a67-42ec-ae19-9420ab7f4d3b`.
- TypeScript 검사·Runtime/테스트 빌드 및 `check:boundaries` PASS (9 modules / 311 files / 849 edges).
- 실제 모델·샌드박스 시험은 Mac Native Host에서만 진행했고, Linux는 MCP의 격리 모의 서버·프로세스로 검증했다.

## 5. 수용 조건과 보존 자료

실제 Mac E2E·재시작 재조회·샌드박스 직접 실행의 구조화된 산출물은 **Mac 호스트 임시 경로** `/tmp/moonrelay-w0-mac-real-attempt-Pg7Oqk`에 보존했다. 사용자 Checkout에는 저장하지 않았다. 최종 독립 확인 영수증 `operationId=9f72b93d-a1dc-45fa-83f2-e3fe5839de02`에서 실제 Kernel E2E **10개 항목 PASS**, 모의 외부 삭제 모델 시도 **INCONCLUSIVE**, 직접 Sandbox **5개 항목 PASS**, Mac 원본 저장소 clean을 확인했다.

이 임시 경로에는 아직 OS 후손 종료를 증명하지 않은 실측 Attempt Worktree·예약과 증거가 포함되어 있다. **종료 불명 상태에서 기존 Attempt Worktree를 일괄 삭제하는 코드는 추가하지 않았으며, 시험 자료의 책임 있는 정리·디스크 회수는 후속 수용 조건이다.**

남은 핵심:
1. 실제 **Native Writer/후손의 OS PID·process group 수명 및 종료·쓰기 정착**을 관찰해, unknown 상황에서 Writer 재시작·동일 경로 폐기를 거부한다. `command/exec`의 개별 명령 종료 결과를 모델 Tool의 모든 후손 종료로 오인하지 않는다.
2. 검증된 Worker Outcome/Kernel Report/Proof와 기존 **Owner CAS 단일 Delivery**의 실제 Writable 경로를 연결한다.
3. 실제 Native Host/Main/MCP 분리 및 T24 Goals/Dispatcher 중복 실행 위험, Windows Native Job Object, 분산 Host/공유 볼륨의 원자성은 추가 수용이 필요하다.
4. 기본 실행 경로·계정 설치·별도 DB/Queue/Scheduler·Provider별 폴백은 변경하지 않는다.

**G0 = PARTIAL, W1 = DEFER.**
