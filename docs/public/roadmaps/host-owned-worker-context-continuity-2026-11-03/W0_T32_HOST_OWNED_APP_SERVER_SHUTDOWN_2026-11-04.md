# W0 T32 — Host가 소유한 App Server 초기화 실패·종료 수명 검증

- 날짜: 2026-11-04
- 작업 대상: `src/host/kernel/codex-app-server-transport.ts`, `tests/kernel-codex-app-server-transport.test.ts`
- 기준선: `main / c91baf4329f605413a7e0e1280a44a7c66d2f2f8`
- 판정: **Host가 직접 생성한 App Server 프로세스의 초기화 실패/중복 close 종료 경계 보완**. **Native Writer의 OS 후손 전체 종료 증명과 자동 결과 합류는 미완료**. G0 `PARTIAL`, W1 `DEFER`.

## 결함 및 변경 경계

기존 Host transport는 정상 `close()`에서 자신이 시작한 App Server PID에 SIGTERM을 보낸 뒤 짧게 기다렸지만, `initialize` RPC 실패에서는 SIGTERM만 보낸 채 예외를 다시 던졌다. 초기화에 실패하면 호출자에게 Transport 객체가 반환되지 않으므로 별도 `close()`로 종료를 확인할 수 없다. 또한 기존 `close()`는 SIGKILL을 보낸 후 실제 `exit` 이벤트를 기다리지 않았고, 두 번째 `close()`는 첫 종료 처리 중에도 일찍 반환할 수 있었다.

제품 로직은 **동일 App Server 자식 프로세스에 대한 단일 종료 절차**를 재사용하도록 최소 변경했다.

1. 초기화 실패와 일반 `close()`에서 같은 Host 소유 프로세스 종료 Promise를 재사용한다. 기존 SIGTERM 기한을 유지하고, 살아 있다면 정확히 **직접 생성한 App Server 자식**에 SIGKILL을 전송한 뒤 종료 이벤트를 제한된 시간 동안 기다린다.
2. 초기화 실패는 App Server 종료가 확인되면 기존 원인 코드(`codex_app_server_rpc_timeout` 등)를 유지한다. 종료조차 확인되지 않으면 `codex_app_server_shutdown_unconfirmed`로 명시하고 원래 실패를 `cause`에 유지한다.
3. 중복 `close()`는 동일한 종료를 기다린다. `appServerExited`는 이 App Server 자식의 종료에 대해서만 참이 될 수 있고, `writerExitVerified`는 계속 **항상 false**다.
4. Signal을 무시하는 시험용 Node App Server를 유한 수명으로 생성해 두 경로 모두에서 강제 종료·실제 PID 부재를 확인한다. 단순 PID 파일을 보고 다른 프로세스에 kill 신호를 보내는 테스트 또는 운영 코드는 추가하지 않는다.

## 범위 및 한계

- 이 수정은 **Transport 시작 직후와 종료 시점의 단일 App Server 소유 프로세스**에 한정한다. 실제 Codex가 실행한 `command/exec`의 자식과 분리된 OS 후손은 직접 소유하지 않는다.
- 기존 Mac Native T27/T28에서 분리된 후손이 App Server 종료 뒤에도 남을 수 있음을 이미 확인했다. 이 반례는 수정 후에도 유효하다. 모든 OS Writer 종료, Host 예약 자동 삭제, Attempt Worktree 폐기, Owner Delivery 활성화에 사용하지 않는다.
- 모델·Provider별 재시도, 별도 DB/Queue/Scheduler, 새 Host 서비스, Kernel 완료 정책·스키마는 추가하지 않았다.
- Linux cgroup v2 쓰기 권한이 없는 검증 환경에서는 후손 전체 종료를 강제할 수 없다. 실제 Mac에서의 App Server 프로세스 단위 검증과 **OS 후손 containment 검증**을 별개로 관리한다.

## 검증 기록

| 검증 | 결과 |
| --- | --- |
| Linux 격리 TypeScript 타입·제품·테스트 빌드 | PASS |
| Linux Native transport 집중 회귀 | 14 PASS / 0 FAIL / 0 SKIP |
| 초기화 실패 시 SIGTERM 무시 프로세스 종료 | PASS — RPC timeout 원인 보존, Host-owned 자식 종료 확인 |
| 동시 `close()` 후 SIGKILL 종료 | PASS — 두 반환 모두 App Server 종료, Writer 종료는 false |
| 기존 detached OS 후손 Writer 반례 | PASS — 종료·예약 승인으로 승격하지 않음 |
| Linux 확대 회귀·모듈 경계 | **58 PASS / 5 OS SKIP / 0 FAIL**, 9 modules / 311 files / 849 edges PASS |
| Mac 실제 OS Node App Server (격리 소스 `03e56ad1`) | **14 PASS / 0 FAIL / 0 SKIP**, Node 24.6.0, TypeScript/제품/테스트 빌드 PASS |

Linux 확대 회귀 증거: `operationId=d44e37df-4b73-4c64-97ed-2794e0cbd859`.

Linux 집중 증거: 별도 의존성·빌드 사본 `operationId=51805eb9-9407-4f9c-b85b-c14f247e2a09`. 격리 소스의 처음 TypeScript 호출은 기존 계정 `node_modules` 참조에 플랫폼 바이너리가 빠져 실패했으나, `npm ci --include=dev`로 독립 의존성을 설치해 TypeScript·제품·테스트 빌드와 집중 실행을 통과했다. 저장소 의존성은 변경하지 않았다.

Mac 교차 증거: 운영 checkout과 분리한 동일 커밋 소스 clone에서 `operationId=deedb744-f796-4e18-8586-02a6b71188e5` (exit 0). 검증한 SIGTERM 무시/동시 `close()`의 대상은 **테스트가 직접 생성한 Node App Server**다. 기존 T27 detached 후손 생존 회귀도 같은 전체 테스트 실행에서 PASS였으며 후손 종료·자동 예약 해제의 권위로 해석하지 않는다. `operationId=d27ff7d4-3e40-4e5d-8fa2-6474304887c0`에서 `14 PASS / 0 FAIL / 0 SKIP`를 재확인하고 시험 전용 Git clone·임시 의존성만 정리했다. macOS 원본 checkout/운영 Codex 세션은 변경하지 않았다.

## 다음 작업

기존 Native `writerExitVerified=false`와 외부 Host 예약을 유지한다. 실제 Native Writable Attempt에서 모든 쓰기 가능한 OS 후손이 **동일 강제 containment 단위**에 속한다는 증거와 종료 후 재관측을 확보한다. 이 증거가 없는 Host에서는 자동 Worktree/예약 정리나 Canonical 결과의 Owner 자동 합류를 허용하지 않는다. 통합 Proof 이전 Owner Fence 확보 및 lease 중단 반례는 이 후속 단계에서 별도로 다룬다.
