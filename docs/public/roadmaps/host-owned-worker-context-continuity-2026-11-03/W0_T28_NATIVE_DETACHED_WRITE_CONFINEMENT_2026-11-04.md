# W0 T28 — 독립 OS 후손의 Native 쓰기 범위 격리 검증

- 검증일: **2026-11-04**
- 기준: `main / ee01c90e971ea8ea1deac4e87040fbc30cdd06a3`
- 판정: **실제 macOS Codex App Server의 `workspaceWrite` 샌드박스가 독립 Process Group·PPID 1 후손에게도 적용됨을 확인.** 해당 후손은 원래 Attempt A에 쓰기를 계속했으나 sibling Attempt B와 Host 예약 테스트 경로의 파일은 수정할 수 없었다. **실제 OS 후손 수명 관리·강제 종료 및 전체 Worktree 안전 폐기는 여전히 미증명. G0 PARTIAL / W1 DEFER.**

## 문제와 구분할 증거

[T27 실제 detached Writer 반례](W0_T27_NATIVE_DESCENDANT_SURVIVAL_AND_RETIREMENT_GATES_2026-11-04.md)에서 `command/exec`와 App Server가 성공·종료한 뒤에도 독립 PGID Writer가 파일을 기록했다. 따라서 **프로세스 종료 증명**은 불충분하다.

이번 단계는 다른 질문을 별도로 시험했다.

> 이전 Writer A가 살아 있더라도, **A의 OS 쓰기 권한이 A의 독립 물리 Worktree 안에만 제한되어 새 Attempt B와 Host 예약 경로를 수정하지 못하는가?**

강제 종료가 아니라 **쓰기 범위 격리(write confinement)**의 증거를 수집한다. 전 OS와 임의 command/tool에 대한 보장을 추론하지 않는다.

## 1. 실제 Mac Native 직접 실행

- 환경: macOS/Darwin, Node `v24.6.0`, Codex CLI `0.162.1`, 이전 W0 전용 `CODEX_HOME`. 원본 Mac 저장소 및 사용자 세션 무변경.
- 실제 모델을 호출하지 않고 `codex app-server`의 독립 JSON-RPC `command/exec`를 사용했다.
- 정책: `type=workspaceWrite`, `writableRoots=[Attempt A 실제 경로]`, `networkAccess=false`, `excludeSlashTmp=true`, `excludeTmpdirEnvVar=true`.
- 임시 Attempt A는 자체 `heartbeat.log`에 append·fsync하는 유한 Node Writer를 생성했다. Writer는 `detached:true`로 별도 PGID를 갖고, App Server 종료 이후에도 작동했다.
- 각 기록 루프에서 동시에 Attempt B의 **시험 센티널**과 Host 전용 **가짜 예약 센티널**을 수정하도록 시도했다. 실제 Kernel Writer 예약 파일은 건드리지 않았다.

| 관측 | 결과 |
| --- | --- |
| `command/exec` 최종 응답 | exit 0 |
| 분리된 OS Writer | PID `77264`, PPID `1`, PGID `77264` |
| App Server 종료 후 A 로그 증가 | 7 → 12줄 |
| Attempt B 시험 센티널 수정 시도 | **115회 전부 거부 / 허용 0** |
| Host 예약 시험 센티널 수정 시도 | **115회 전부 거부 / 허용 0** |
| 유한 Writer 자체 종료·A 기록 정착 | 115줄, 최종 센티널 모두 불변 |
| 독립 조건 | **12/12 PASS** |

Mac MCP 실제 실행 영수증 `operationId=602a6f67-93ee-42b7-8d2b-278ab1eebc60`, exit 0. 구조화된 `t28-detached-sandbox-evidence.json`을 Mac 임시 W0 실측 폴더 `/tmp/moonrelay-w0-mac-real-attempt-Pg7Oqk`에 보존했다.

## 2. 재실행 가능한 테스트로 정착

`tests/kernel-native-sandbox-confinement.test.ts`를 추가했다. **테스트 전용 구현**이며 제품 Native Transport/Kernel/Dispatcher를 변경하지 않는다.

- 기본 Linux/Windows/macOS 테스트에서는 건너뛴다. Mac에서 실험을 수행할 때만 `W0_NATIVE_SANDBOX_CONFORMANCE=1`과 **격리된** `CODEX_HOME`을 명시한다.
- macOS `codex` 실행 파일은 `W0_CODEX_EXECUTABLE`로 선택할 수 있다. 코드에 계정 경로나 사용자별 Codex 경로를 하드코딩하지 않는다.
- 매 실행마다 새로운 `mkdtemp` 디렉터리를 생성한다. A/B/Host 경로는 모두 이 디렉터리 안에만 존재한다. `command/exec`의 명시적 `writableRoots=[A]`가 **후손에게도 적용되는지** 검사한다.
- 유한 Writer 최대 100회 append·fsync 및 각 회차의 B·Host 파일 쓰기를 시험한다. B/Host 파일이 그대로 남고 거부가 각각 100회, 허용 0회일 때만 PASS.
- App Server 프로세스만 종료하고, 후손이 A 내부에 추가 기록함을 확인한다. 유한 Writer가 정해진 수명을 마치고 로그 기록이 안정됐으며 해당 PID가 보이지 않을 때만 **테스트 임시 디렉터리**를 정리한다. 중간 실패 시 후손 종료를 추정하지 않고 증거를 남긴다.
- 실제 모델 없이 실행하며 사용자 원본 저장소·운영 Runtime·DB에 접근하지 않는다.

Mac 재실행은 실제 OS PID `83040`, PPID `1`, PGID `83040`, A 로그 100줄, B 외부 쓰기 **100/100 거부**, Host 외부 쓰기 **100/100 거부**, 허용 0건을 확인했다. **Mac conformance 1/1 PASS**, `operationId=bdde5d93-af04-4322-b8b5-a9b7a3bdcf93`, exit 0. 이때 재사용 테스트의 원본 TS/빌드된 MJS를 Mac의 임시 Clone에 복사하고, **Mac native 실행기에서 파일 존재를 확인한 뒤** 실행했다.

실행 예시(격리된 테스트 계정만 사용):

```bash
export W0_NATIVE_SANDBOX_CONFORMANCE=1
export CODEX_HOME=/absolute/path/to/disposable-w0-codex-home
export W0_CODEX_EXECUTABLE=/absolute/path/to/codex
npm run build:tests
node --test tests/kernel-native-sandbox-confinement.test.mjs
```

Mac의 파일 쓰기 MCP가 성공을 반환했지만 **native Host 실행기에는 해당 파일이 보이지 않는 경우**가 관측됐다. 동일 경로 이름만으로 파일시스템의 동일성을 가정하지 않았다. 최종 Mac 테스트 소스는 **native Host exec_command**로 임시 Clone에 실제 기록·크기 확인 후 실행했다. 이 차이는 도구 연결/호스트 가시성 문제이며 제품 Sandbox 검증 PASS 근거와 분리한다.

## 3. Linux 회귀 및 플랫폼 제약

Linux MCP W0 격리 빌드에서 `npm ci --include=dev`, TypeScript typecheck, `build:tests`를 수행했다. Mac Native conformance는 의도대로 SKIP되고, 기존 T25~T27 Writer/Attempt/Parallel/Process-tree 회귀는 그대로 실행된다.

- 집중(새 테스트 포함): **17건 중 16 PASS / 1 Mac 전용 SKIP / 0 FAIL**.
- 확대: **97건 중 95 PASS / 2 SKIP (Mac Native + Windows Native) / 0 FAIL**.
- `check:boundaries`: **9 modules / 311 files / 849 edges PASS**.
- Linux `/sys/fs/cgroup`는 `cgroup2fs`이지만 마운트가 **read-only**다. 컨테이너 내부에서 OS가 강제하는 새로운 cgroup 그룹을 구성하거나 후손 전체 종료를 검증할 수 없다. Linux의 Native 동일 수용은 이번 단계에서 **NOT TESTED**.
- 새로운 OS 격리 관리자, Provider별 종료 폴백, DB·Queue·Scheduler는 추가하지 않았다.

## 4. 구조적 결론 및 범위

| 다른 성질 | 이번 단계의 증명 |
| --- | --- |
| Native macOS 샌드박스가 분리된 후손에게 쓰기 범위를 상속하는가? | **PASS — 지정한 A/B/Host 임시 경로에서 직접 측정** |
| 오래된 A가 살아 있어도 B/Host에 쓰지 못하는가? | **PASS — 검증된 `workspaceWrite` 설정과 해당 실험 프로세스에 한정** |
| 임의 Native 모델 명령의 후손이 전부 종료됐는가? | **아니오, 미증명** |
| A의 Worktree/예약을 안전하게 자동 폐기할 수 있는가? | **아니오, 미구현** |
| 동일 UID의 비격리 프로세스, Mac 바깥 OS에서도 B/Host 수정 불가능한가? | **미증명** |
| 새로운 B Attempt 시작·Outcome/Owner CAS Delivery까지 검증됐는가? | **아니오, 이번 시험은 별도 임시 센티널의 쓰기 범위 검증** |

따라서 **Writer 종료를 반드시 증명해야 새 별도 물리 Worktree를 사용할 수 있는 것은 아니다.** 운영자 보호 조건을 실제 Host 샌드박스로 검증하고 Canonical Kernel/Owner 권위가 새 Attempt를 허용하는 경우에 한해, 물리적으로 격리된 B는 A와 별개로 진행할 가능성이 확인됐다. 그러나 **A Worktree를 폐기하려면 여전히 A의 모든 Writer 종료·쓰기 정착이 필요**하다.

기존 `runHostOwnedWritableAttempt`/`codex-app-server-transport.ts`의 명시적 `workspaceWrite` 정책과 Writer 예약 불변 규칙을 유지한다. 향후 Host OS capability가 실제로 강제하는 쓰기 범위와 종료 수명은 **서로 다른 검증 차원**으로 취급하되, 새 추상 상태·DB·Provider별 폴백으로 중복 구현하지 않는다.

## 5. 다음 단계

1. **Mac 실제 Canonical Kernel Attempt A와 B를 동시에 사용하는 실행 검증**: A가 살아 쓰는 동안 B가 동일 Host Runtime의 별도 Git Worktree에서 실제로 진행하고, A가 B/Owner/Host 예약을 수정하지 못하는지 확인한다. Outcome/Owner CAS는 기존 Kernel 권위를 사용한다.
2. **종료·안전 폐기**: 전체 후손을 OS가 관리하는 종료 수단 또는 검증 가능한 대안이 없으면 예약과 오래된 Worktree를 보존한다. 영구 누적에 대해서는 별도 cleanup 책임과 저장 예산을 관리한다.
3. **Linux·Windows 호환성**: 해당 Host가 실제 강제하는 네이티브 파일 쓰기 범위와 OS 후손 containment를 각각 검증한다. Windows native executor/Job Object 증거가 없으면 기본 실행기에 자동 적용하지 않는다.
4. **T24/T26·Owner CAS**: Main/MCP/Host 중단과 Goals/Dispatcher 중복 실행, 정상·stale 결과의 단일 Owner Delivery를 검증한다.

**최종: macOS detached Writer의 쓰기 범위 격리는 실측 PASS, Writer 수명 전체 종료는 미검증. G0 PARTIAL / W1 DEFER.**
