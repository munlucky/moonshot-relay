# W0 T27 — Native App Server 종료 이후 실제 OS 후손 Writer 생존 반례

- 검증일: **2026-11-04**
- 기준선: `main / 5d260f3192a0b5f692fbb20e164d9c164a1cf397`
- 판정: **실제 macOS App Server 명령 완료 및 서버 종료 뒤 독립 OS Writer의 추가 쓰기 재현 PASS**, **Linux 실제 detached Node Writer + Canonical Attempt + Host 외부 예약 불변 회귀 PASS**. 전체 OS 후손 종료 증명과 운영 Worktree/Marker 안전 폐기는 여전히 **NOT VERIFIED**. **G0 PARTIAL / W1 DEFER**.
- 변경 범위: 기존 `tests/kernel-codex-app-server-transport.test.ts`의 T27 회귀와 W0 로드맵 문서. **제품 기본 Native Adapter·Kernel Report/Proof·Owner CAS·Dispatcher·DB/Queue/Scheduler는 변경하지 않았다.**

## 실제 Mac Native 명령 종료와 Writer 종료의 차이

Mac Node `v24.6.0`, Codex CLI `0.162.1`에서 격리 W0 인증 홈과 기존 `/tmp/moonrelay-w0-mac-real-attempt-Pg7Oqk` 자료를 사용했다. 실제 `codex app-server` `command/exec`에 `workspaceWrite`·단일 임시 Worker 디렉터리 쓰기·네트워크 차단·암묵적 tmp 경로 제외 정책을 적용했다.

명령은 **유한 수명**(최대 115회, 30ms 간격)의 별도 Node OS Writer를 `detached` 그룹으로 시작하고 반환했다. 이 Writer는 격리 파일 `writer-heartbeat.log`에만 append+fsync했다. 실제 PID, PPID, PGID와 명령 반환·App Server 종료 전후의 파일 기록 수를 관측했다.

| 실제 OS 관측 | 값 |
| --- | --- |
| `command/exec` 완료 응답 | `exitCode=0` |
| 실제 분리된 Writer | PID `54147`, PPID `1`, PGID `54147` (시험 당시 관측) |
| 명령 완료 시 파일 기록 | 1줄 |
| 220ms 뒤 파일 기록 | **8줄** |
| App Server 종료 시 파일 기록 | 9줄 |
| App Server 종료 후 파일 기록 | **14줄** |
| 제한된 자체 종료 후 파일 기록 | 115줄, 추가 증가 없음 |
| 사후 PID 조사 | 위 PID는 더 이상 관측되지 않음 |
| 격리 실측 성공 조건 | **6/6 PASS** |

Mac MCP 실행 영수증: `operationId=39136e7c-0c0f-46a1-aeeb-d63e1d5c8f3a`, exit 0. 추가 사후 파일·PID 확인: `ef103ced-1e1a-47d8-8a18-a807ed5aad0e`, exit 0. 구조화 증거 `native-descendant-negative.json`은 해당 Mac 격리 디렉터리에 유지했다. 원본 Mac `moonshot-relay` Checkout은 clean이다.

이 시험은 **다음 두 주장을 실제로 반박한다**.

1. `command/exec`가 `exitCode=0`을 반환했으니 명령의 모든 자식·후손이 종료됐다는 주장.
2. `codex app-server` 프로세스가 종료됐으니 Worker에 쓰기 권한을 가진 후손이 없다는 주장.

분리된 Writer는 `PPID=1`, 별도 `PGID`로 관측됐다. 따라서 **App Server PID 종료나 App Server의 Process Group만 강제 종료하는 동작이 모든 Writer를 수거한다고 가정하면 안 된다.** 실제 Native 명령이 프로세스 그룹 밖으로 벗어날 수 있는 상황을 수용하려면 추가 OS 수준의 후손 containment/종료 확인이 필요하다.

※ 시험 Writer는 자체 종료를 코드로 제한하고 종료 후 기록 정착·PID 부재를 확인했다. 이것은 **해당 테스트 프로세스의 유한 수명 관측**일 뿐, 실측 Canonical Attempt Worktree에서 실행된 임의 모델 Tool의 후손 전체가 종료됐다는 증거는 아니다. 기존 Native Attempt Worktree·예약을 해제하지 않았다.

## Linux MCP 통합 반례

기존 `tests/kernel-codex-app-server-transport.test.ts`에 `TEST_MODE=writable-detached-descendant`를 추가했다. 모의 App Server는 **실제 OS detached Node Writer**를 만들고 `item/started`·`item/completed` 및 `turn/completed`를 반환한다. `runHostOwnedWritableAttempt`가 응답 후 App Server를 닫아도 실제 Writer 로그는 계속 증가한다.

- 실제 `createKernelControlPlane` Run/Attempt와 Attempt별 물리 Worktree를 사용했다.
- Native Turn의 `completed`, Host 자체 App Server 종료에도 `writerExitVerified=false`, `reportAuthority=none`을 유지한다.
- Kernel Attempt `started` 및 Host Writer 단일 예약 파일이 유지된다.
- 동일 물리 Workspace의 새 예약은 `host_writer_workspace_already_reserved`로 거부된다.
- Owner Git 저장소는 clean을 유지하고 후손은 별도 Attempt Worktree에만 기록한다.
- **테스트에서만** 유한 루프의 종료와 파일 쓰기 정착을 관측한 뒤 임시 Worktree를 폐기한다. 실패 경로에서도 제한된 Writer 수명 종료 이전에는 Test Worktree를 삭제하지 않도록 안전 대기를 둔다.
- Linux 집중 검사 **16/16 PASS**.
- Linux 확대 회귀 **총 96건: 95 PASS / 1 SKIP(Windows 전용) / 0 FAIL**. 기존 Windows `proof/process-tree` 검사도 해당 플랫폼 비대상 1건만 SKIP.
- TypeScript 및 `build:tests` PASS, `check:boundaries` **9 modules / 311 files / 849 dependency edges PASS**.
- Linux MCP 집중 영수증 `c9432632-741d-4e51-9b5e-9a1e358dd9ae` 및 확대 영수증 `9bb18a3c-7018-4de6-abed-74d71a99b5b1`.

## 기존 증거 경계 재사용·과도한 기능 추가 금지

`src/host/kernel/proof/process-tree.ts`에는 기존 **Windows** 용 PID·생성시각·부모 관계 확인, Host 조상 보호, 후손 종료 및 종료 후 재관측 절차가 이미 있다. 이 코드를 다시 구현하거나 단순히 macOS에 `taskkill` 대체 명령을 붙이지 않는다. Windows 알고리즘에서 **launcher가 사라진 뒤 재부모화된 후손을 항상 식별할 수 있다는 보장은 없다.**

G0 통합 수용에 필요한 공통 종료 증거는 다음과 같다.

- **출처**: 해당 Canonical Kernel Attempt와 Host가 실제로 소유한 OS 실행 Handle/격리 단위. 임의 모델 출력의 PID 문자열이나 `turn.completed`를 종료 영수증으로 쓰지 않는다.
- **범위**: 해당 Attempt가 만든 Writer 본체뿐 아니라 **쓰기 가능한 모든 자식·후손**이 실제로 격리 단위에 속했는지 확인해야 한다. 단순 PID/Process Group만으로 충분하지 않다.
- **종료 후 검증**: 식별된 실행 단위의 종료를 OS 관측으로 확인하고, 이후 쓰기 정착까지 검증한다. 식별 불가·PID 재사용·상태 불명·재부모화/그룹 탈출이 감지되면 **UNKNOWN**으로 유지한다.
- **물리 자원 폐기**: 이 증거가 **검증된 경우에만** 기존 Host 외부 Writer 예약/Attempt Worktree를 안전하게 폐기할 수 있다. **이번 단계에서는 일반 Writer 자동 해제·TTL·삭제 API를 추가하지 않았다.**
- **작업 연속성**: 기존 Canonical Attempt를 불확실한 상태에서 중복 실행하지 않는다. 실제 새로운 Attempt의 별도 물리 Worktree 실행은 기존 Kernel 소유권과 Owner CAS 결과 채택 조건을 통과해야 한다.
- **플랫폼 차이**: 제품별 분기·폴백을 누적하지 않는다. 필요한 것은 동일한 종료 증거 의미를 제공하는 **Host 실행 capability**다. 지원되지 않는 Host/명령은 종료 증거를 만들었다고 선언하지 않는다.

## 자료 보존·정리 결과의 한계

실제 Mac 테스트 자료는 `/tmp/moonrelay-w0-mac-real-attempt-Pg7Oqk` 하위에 보존했다. 원래 실제 Canonical Attempt의 Worktree와 Host Writer 예약은 미확정 종료 상태이므로 **삭제하지 않는다**.

Mac의 **실측 반례 전용 디렉터리**를 종료 후 정리하려는 시도에서는 Host 명령이 exit 2를 반환하고 검증 출력을 확보하지 못했다(`operationId=87b835d0-61d1-4b79-91d3-8f15834cd32e` 및 `e1fe2f02-7b04-4490-bb2f-c652c66570a8`). 이후 Mac Host 직접 조회에서 해당 디렉터리와 원래 Attempt 자료가 **여전히 존재**함을 확인했다. 실패한 정리를 재시도하며 추정으로 파일을 삭제하지 않았다. Mac 원본 Git Checkout은 clean이다.

이것은 보존 책임과 디스크 회수 조건이 아직 작업 과제로 남았다는 의미다. **실제 OS Writer의 후손 전체를 관측·격리·종료할 수 있는 Host 기능이 증명되기 전에는 운영 자동 폐기 기능을 추가하지 않는다.**

## 다음 미완료 단계

1. Host가 지원하는 **OS 수준의 강제 후손 containment**와 PID 재사용 방어, 종료 후 재관측을 Native Writer의 단일 실행 경계에 연결한다. 격리 수단은 플랫폼 Host capability로 표현하되 새 DB/Queue/Scheduler 계층으로 분리하지 않는다.
2. 실제 Native Kernel Attempt의 **정상 종료·연결 상실·강제 종료**에서 모든 Writer/후손 정착을 검증한 뒤 안전 폐기와 디스크 회수 조건을 확정한다.
3. 기존 Worker Outcome·Proof·Kernel Report와 Owner CAS 단일 Delivery의 실제 Host 실행 E2E를 검증한다.
4. T24 중복 Dispatcher, Windows Job Object, 다른 머신의 공유 파일시스템 안전 조건은 별도 수용한다.

**G0 PARTIAL / W1 DEFER 유지.**
