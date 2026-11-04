# W0 T39 — 실제 Native Writer의 다단계 후손 종료 증거와 자동 복구 게이트

- 날짜: 2026-11-04
- 기준 소스: `main / f75729314bd395d41d0dabee99e58e1784e03429`
- 범위: 기존 `tests/kernel-native-sandbox-confinement.test.ts`의 **실제 macOS Codex App Server direct `command/exec`** 회귀 확장. 운영 제품 코드·기존 Writer 예약·Kernel 자동 합류 정책 변경 없음.
- 판정: **테스트 소유의 유한 Writer와 부모의 종료는 관측할 수 있으나, 임의 Native Writer의 모든 후손 종료 증거는 아직 없다.** 자동 복구 게이트 G0 `PARTIAL` / W1 `DEFER` 유지.

## 조사 결과와 구조적 판단

기존 `codex-app-server-transport.ts`는 단일 App Server 자식 프로세스의 종료만 소유한다. Native `commandExecution.processId`는 Provider의 논리 핸들이고 OS PID가 아니다. `runTurn()`/`close()` 모두 `writerExitVerified:false`로 고정한 것은 T27·T28·T31의 실측과 일치한다.

실제 Native `command/exec`가 완료되고 App Server를 종료한 뒤에도 `spawn({detached:true})`로 별도 process group을 가진 Writer가 계속 쓸 수 있다. T33은 App Server **전체 PGID 종료**도 별도 PGID Writer를 정지시킬 수 없음을 확인했다. T34는 논리 Owner Fence 만료·신규 Epoch도 이전 OS 쓰기 권한을 박탈하지 못함을 보였다.

이번 T39는 여기서 한 단계 더 분리한다: `command/exec` 직계 Launcher가 **짧은 수명의 Supervisor**를 시작하고 Supervisor가 **별도 PGID Grandchild Writer**를 만든 뒤 종료한다. 종료된 직계·중간 프로세스의 OS PID가 확인되어도 손자 Writer의 실제 쓰기는 계속되는지, 기존 `workspaceWrite` OS Sandbox가 새 후손에 상속되는지 확인한다.

## 실증 수용 조건

1. 운영 Codex 인증·현재 세션과 분리된 `CODEX_HOME`, 격리된 A/B/Host-only 디렉터리, **기존 실제 Codex App Server `command/exec`**만 사용한다. 모델 Turn과 사용자 작업 저장소는 실행하지 않는다.
2. 시험 소유 App Server를 독립 PGID로 실행하고 실제 OS PID를 확인한다. Native `command/exec`가 `spawn.cjs` Launcher를 완료하면 Supervisor PID와 Writer PID를 독립 파일에 기록한다. Supervisor와 Grandchild는 서로 다른 PID/PGID다.
3. **Supervisor PID가 이미 소멸**한 상태에서 Writer의 실제 `/bin/ps pid,ppid,pgid,stat` 행을 확인하고, A 내부 heartbeat가 증가하는지 확인한다. A Writer는 B/Host-only 파일을 변경할 수 없어야 한다.
4. 정확히 시험이 생성한 App Server PGID만 종료한다. 손자 Writer는 다른 PGID이므로 **계속 쓰는 것이 음성 반례의 성공 조건**이다. 정상 종료와 타임아웃 자체는 Writer 전체 수명 증거가 아니다.
5. 유한 시험 Writer는 A heartbeat를 100회만 기록하고 자동 종료한다. heartbeat 기록이 안정적이고 Writer PID가 실제로 소멸한 뒤에만 **시험 A/B/Host 디렉터리**를 정리한다. 실패·확인 불명에서는 시험 증거를 보존하며 임의 OS 프로세스를 kill하지 않는다.
6. Native Turn 완료·App Server 종료·Supervisor 종료·손자 Writer PID 종료가 모두 확인돼도 **임의 모델이 생성한 다른 후손이 없다는 폐쇄성 보장은 아니다**. `writerExitVerified:false` 및 외부 Host 예약 유지, 실제 Owner Revision과 Canonical Attempt 결론 불변을 검증 결과에 명시한다.

## 코드 경계 및 불필요한 복잡도 검토

- 새로운 DB·Queue·Scheduler·Provider별 폴백, Runtime Lease, 감시 프로세스를 만들지 않는다. 기존 macOS 실물 회귀에 유한 Supervisor 한 단계와 종료 순서 assertion만 추가한다.
- PPID가 1로 바뀌거나 Supervisor PID가 목록에서 사라지는 것, `killpg` 성공, 파일 크기 안정화, 논리 RPC `completed`, 한 시점의 `ps` 부재는 **일반 Writer 완료의 충분조건이 아니다**.
- 전체 작업을 안전하게 자동 회수하려면 OS에서 모든 후손을 포괄하는 강제 containment, 또는 실질적으로 새 Worker/Host가 이전 실행의 물리 쓰기 경로에 접근하지 않도록 하는 세대별 OS Sandbox/Worktree 검증이 필요하다. T35·T36은 macOS의 물리 경로 분리를 보여 주지만 실제 Native API의 모든 후손 종료 판정까지 제공하지 않는다.
- T39에서 부정 결과가 확인되면 임의 PID 스캔 기반 예약 삭제나 `writerExitVerified:true` 승격은 **금지**한다. 이미 검증한 T38 CAS 직후 `blocked` 경계를 유지한다.

## 검증 기록

| 검증 대상 | 결과 |
| --- | --- |
| Linux strict TypeScript·제품·테스트 빌드 | **PASS** (`operationId=fc8b8991-d5ad-428f-8b36-c81ac82c15ee`) |
| Linux 기존 Native Transport/Disconnect 회귀 | **14 PASS / 2 OS SKIP / 0 FAIL** (실제 Native Sandbox 실험은 Mac 필요) |
| Linux 확대 Transport/Disconnected Host/T35·T36·T37·T38 교차 회귀 및 모듈 경계 | **20 PASS / 4 OS SKIP / 0 FAIL**, 9 modules / 312 files / 850 edges PASS (`operationId=0682a3a0-9c8d-4238-b5c1-7f1f28e7e514`) |
| macOS 실제 Native direct command/exec Grandchild 및 Sandbox 상속 | **1 PASS / 0 FAIL / 0 SKIP**, 동일 소스 `df58ce587778409e9419efcaecfd202868cd380d`, macOS strict TS·제품·테스트 빌드 PASS (`operationId=075d2570-6c11-4746-90b8-83a6f736bb48`) |
| 임의 Native Writer의 모든 후손 종료 보장 | **미증명 (자동 합류 DEFER)** |

## Mac Native 실측 결과

2026-11-04, 격리된 실제 Mac Native checkout `df58ce587778409e9419efcaecfd202868cd380d`와 별도의 빈 `CODEX_HOME`, 실제 `codex app-server`의 **모델 Turn 없는 직접 `command/exec`**를 사용했다. TypeScript·제품·테스트 빌드 PASS. 검증 시 출력을 다음과 같이 기록했다.

| 관측 | 실제 값 |
| --- | --- |
| App Server OS PID/PGID | `72544` |
| Supervisor OS PID | `72559` — Grandchild가 쓰기 중일 때 종료 확인 |
| 분리된 Grandchild Writer PID/PPID/PGID | `72560 / 1 / 72560` — 별도 PGID/PPID 1 |
| Supervisor 종료 및 App Server 그룹 종료 뒤 Writer | `fsync` heartbeat 계속 증가 |
| Worker A 내부 유한 기록 | 정확히 **100회** |
| B Worker Worktree 쓰기 거부 | **100/100**, 허용 `0` |
| Host-only 예약 경로 쓰기 거부 | **100/100**, 허용 `0` |
| 시험 자식 자체 종료 + PID 미활성 확인 | **PASS** |
| `writerExitVerifiedForArbitraryTurn` | **false** (변경 없음) |

위 증거는 `operationId=075d2570-6c11-4746-90b8-83a6f736bb48`의 실제 Native 테스트에서 수집됐다. 종료 후 별도 `operationId=492111ee-42a3-47a5-b7b0-44b70bd96f83`로 세 시험용 PID의 비활성 상태와 테스트 PASS·정확한 소스 커밋을 재검증하고, 시험 소유 Clone·빈 `CODEX_HOME`·의존성만 정리했다. 원본 Mac checkout/사용자 Codex 세션은 유지했다.

**판정의 정확한 범위:** 테스트가 생성한 *알려진 유한 Grandchild*는 마지막 기록 정착과 PID 부재를 확인했다. 그러나 model/Provider의 임의 코드가 추가로 생성할 수 있는 *관측되지 않은* Grandchild의 폐쇄성은 검증하지 못했다. 그러므로 `writerExitVerified:false`, 동일 Workspace 예약 유지 및 자동 Owner Delivery `DEFER`를 적용한다. Mac의 물리 Worktree·Sandbox 분리(T35/T36)는 외부 쓰기를 막을 수 있지만 전체 Writer 종료를 보장하지는 않는다.

다음 단계는 이 반례를 토대로 **OS 강제 집단 containment가 현재 실행 모델의 중첩 detached 하위 PGID까지 실제로 포괄할 수 있는지** 또는 기존 독립 Worktree·Sandbox로 안전한 재합류가 가능한지를 작은 실험으로 평가하는 것이다. `writerExitVerified`를 단순 PID 또는 프로세스 그룹 관측값으로 승격하지 않는다.

**전체: G0 PARTIAL / W1 DEFER.**
