# Windows Native MCP 실행기 재연결 및 L1A 실측 상태 (2026-11-05)

- 기준 HEAD: `c5f16c0fb078986d65dab4e67f0921fef865f7f6`, `main=origin/main`, 변경 전 clean.
- 기존 Windows 로컬 증거: [MCP 인계](LOCAL_NATIVE_VERIFICATION_MCP_HANDOFF_2026-11-05.md), [로컬 계획](LOCAL_NATIVE_VERIFICATION_EXECUTION_PLAN_2026-11-05.md).
- **변경된 사실:** `moonremote exec_command(executionTarget=host)`에서 `powershell -NoProfile` 명령의 실제 출력·종료 코드 관측 가능. 이전에 Native 출력이 불명확했던 구간의 실행 수단은 이제 사용 가능함.
- 성공한 OS 식별: `native-host-probe`, `Microsoft Windows NT 10.0.19045.0`, `C:\dev\moonshot-relay`; exit 0; 실행 operation `b5c10f9f-3b90-4ea4-ae11-7dd733cfb969`.
- **별개 미완료:** Windows 실제 제한 토큰/별도 SID 프로세스 생성·DACL 접근 시험은 이번 실행에서 성공한 증거가 없음. Token 권한 조사 호출은 도구 안전 검사에서 차단되어 우회하지 않음. 앞선 구문 오류 PowerShell 명령은 실행 결론이 아닌 명령 인용 오류.
- 현재 `codex-app-server-transport.ts`의 App Server `spawn` 및 `writerExitVerified:false`, `host-owned-writable-attempt.ts`와 `parallel-dispatcher.ts`의 `deliveryAuthorized:false`를 소스에서 다시 확인. 설계 변경·제품 승인 없음.
- **판정:** Host Native 실행 연결 확인 PASS, Windows 별도 OS 보안 주체의 실제 Tool/파일 접근은 **DEFER**, G0 PARTIAL / G1 DEFER / G6 NOT_RUN / P2 **HOLD_SAFE**.
- 다음 실제 실행 조건: 적법하게 승인된 Windows 별도 보안 주체의 Native 프로세스가 보호 Owner 테스트 DACL에 대해 직접·기존 hardlink·외부 Writer 모두 차단됨을 확인하고, 독립 CODEX_HOME의 정식 시험 인증이 준비된 이후에만 L2~L4로 확장한다.
- 기존 Kernel C Lane 성공 및 Windows L0/L1 원본 결과를 중복 실행하지 않는다. 단독 Job Object 종료/제한 토큰 객체 생성/initialize 성공을 실제 Tool 격리로 전용하지 않는다.
- 보안 차단이나 사용자 승인 대기를 가정한 우회 시도, 새 상시 감시자, DB, Queue, Scheduler, Provider별 예외 분기 없음. 제품 코드 및 사용자 OS 계정/인증/실제 Run 미변경.

## 로컬 후속 검증 — Windows 무결성 수준

- 기준 HEAD `b3239072`. 별도 시험 디렉터리에서만 실행했다.
- 실제 Low Integrity 토큰(`S-1-16-4096`)으로 시작한 프로세스는 Worker 파일에 쓸 수 있었다. 같은 토큰으로 실행한 Node 시험은 Owner 직접 경로, 사전 생성 하드링크, junction에서 모두 `EPERM`을 받았다. Owner SHA-256은 동일했다.
- 같은 사용자 SID의 Medium Integrity 대조군은 하드링크를 통해 Owner 파일을 변경했다. Low Integrity 후보는 테스트 Worker의 쓰기를 제한하지만 이 외부 Writer 반례를 해결하지 못했다.
- 독립 테스트 `CODEX_HOME`에 새로 로그인했다. 실제 Windows App Server의 `initialize`와 `account/read`에서 인증 계정을 확인했다. 별도 보안 주체에서 모델 Tool을 실행하는 시험은 보류했다.
- **판정: L1A PARTIAL / L2–L4 DEFER / HOLD_SAFE.** 다음 단계는 승인된 별도 Windows 테스트 계정과 Owner DACL을 사용하여 Worker 및 동일 Worker SID의 외부 프로세스 모두에서 쓰기 거부를 확인하는 것이다.

## 로컬 후속 검증 — 별도 표준 계정과 실제 App Server

- 별도 표준 Windows 계정의 Worker와 외부 Writer를 독립 프로세스로 실행했다. 두 프로세스 모두 Worker 파일 쓰기에 성공했고 Owner 직접 경로, 동일 NTFS 파일 ID의 하드링크, junction 쓰기에서 Win32 오류 `5`를 받았다. Owner SHA-256은 기준값과 일치했다.
- 같은 표준 계정의 독립 `CODEX_HOME`에서 새 OAuth 로그인을 완료했다. 실제 App Server의 `initialize`, `account/read`, 모델 Turn 완료를 관측했다.
- App Server의 직접 `command/exec`는 `workspaceWrite`와 단일 Worker 쓰기 경로를 적용해 두 번 성공했다. PowerShell 자식의 표준 계정 SID를 확인했고, 두 번 모두 Worker 쓰기 허용 및 Owner 직접·하드링크·junction 쓰기 거부를 관측했다.
- 모델 Tool의 첫 실행은 시험 폴더의 Code Mode 보조 실행 파일 누락으로 실패했다. 동일 설치본의 보조 파일을 배치한 뒤에도 모델 Turn의 셸 실행은 정책에서 거부됐다. 시험 로그의 Tool Router에서 첫 셸 명령의 거부를 확인했다. Worker 안에 파일 하나를 쓰는 양성 대조에서도 모델이 정책 거부를 보고했고, 쓰기 파일과 commandExecution 이벤트가 없었다. 정책을 거부한 구체적인 규칙은 미확정이다.
- **판정: 별도 SID 파일 DACL과 직접 App Server 명령의 관측 범위 PASS / L2 PARTIAL / L3–L4 DEFER / HOLD_SAFE.** 모델 Tool 실행과 권한 상속, Host 종료 후 후손의 지연 쓰기, 동일 Run 재개는 미검증이다.
- 별도 시험 실행에서 App Server 시작 옵션으로 `windows.sandbox="unelevated"`를 명시했다. 이전과 달리 `commandExecution` 이벤트 1건을 관측했으며, 상태는 `failed`, 명령 종료 코드는 `1`이었다. 모델 응답은 파일을 생성했다고 보고했으나 실제 파일은 없었고 Owner 해시는 기준값과 일치했다. 명령 출력은 기존 수집기에서 보존하지 않아 실패 원인은 미확정이다. L2 후손 검사와 L3–L4는 실행하지 않았다.
- 현재 사용자 SID의 별도 인증 홈에서 명령 출력과 작업 경로를 수집해 직접 재현했다. 첫 진단은 PowerShell 프로필 로드 오류와 제한 언어 모드의 `System.IO.File.WriteAllText` 메서드 호출 거부를 기록했다. 동일한 App Server 샌드박스 설정에서 `login=false` 및 PowerShell 기본 cmdlet `Set-Content`를 요청한 대조는 실제 `commandExecution` 종료 코드 `0`과 지정한 내용의 파일 생성을 모두 확인했다. 이 대조는 별도 Windows 테스트 SID에서 실행한 후손 격리나 재연결의 증거가 아니다.
- 별도 표준 계정의 통합 시험에서 모델 Tool이 실제 Node를 시작했다. Node가 Worker 내 결과 임시 파일을 열 때 `EPERM`을 받아 후손 생성 전에 종료했다. Owner와 후속 경로의 해시는 그대로였다. 해당 Worker 루트는 제어 계정이 소유했다. 후속 시험은 표준 계정이 소유하는 새 작업 디렉터리를 사용하도록 준비했다. 소유권 차이가 실패 원인인지는 미확정이다.
- 표준 계정이 만든 작업 디렉터리에서 모델 Tool의 Node, 자식, 분리 손자 모두 Worker 쓰기에 성공했다. 세 프로세스의 Owner 직접·하드링크·junction·후속 영역 쓰기 시도 12건은 모두 `EPERM`이었다. Owner와 후속 파일의 해시는 유지됐다. 샌드박스 내부 SID 조회가 값을 반환하지 않아 권한 상속 판정과 Host 종료 검사는 보류했다. 다음 시험은 제어 프로세스의 CIM 조회로 각 생존 PID의 SID와 부모 PID를 기록하도록 준비했다.
- **후속 시험에서 L2와 L3의 관측 범위를 확인했다.** App Server → Tool 부모 → 모델 Tool → 자식 → 분리 Writer의 실제 PID·부모 PID와 별도 표준 계정 SID를 CIM으로 확인했다. Tool·자식·Writer의 보호 경로 쓰기는 거부됐다. 제어 프로세스가 종료 전에 다섯 프로세스의 Windows 핸들을 열어 보존했고, Host 강제 종료 뒤 모두 약 4–10ms 이내에 종료된 것을 관측했다. 보호된 Owner·후속 파일의 해시는 유지됐다. 살아남은 Writer의 지연 쓰기 시험 결과는 없다.
- 이 결과는 단일 Windows 시험 트리에서 관측한 L2 쓰기 격리와 L3 종료 증거다. 제품 Host의 Writer 전체 종료 권위, L3의 Snapshot·Proof/CAS 조건, L4의 같은 Kernel Run 재개 및 W3~W6 수용은 별도다. 제품 자동 합류와 자동 재개는 `HOLD_SAFE`를 유지한다.

## 로컬 후속 검증 — Job Object와 스냅샷

- Windows Job Object에 시작을 정지한 프로세스를 먼저 할당한 뒤 실행했다. Job 핸들은 시험 제어 프로세스만 보유했으며 마지막 핸들이 닫히면 종료하도록 설정했다. 제어 프로세스를 강제 종료하자 실제 App Server, 모델 Tool, 분리 Writer와 중간 실행 프로세스의 종료를 모두 확인했다. 이 시험은 현재 Windows 계정의 독립 시험 홈에서 수행했으며 Job Object를 제품 Host에 연결하지 않았다.
- 실제 시험 결과 파일을 복제한 NTFS 단일 파일 수확 시험에서 열린 writable 핸들이 있는 동안 읽기 잠금이 거부됐다. 읽기 잠금을 잡은 뒤에는 직접 경로와 하드링크 쓰기 시도가 모두 Windows 오류 `32`로 거부됐다. 복사본은 별도 파일 ID를 가졌고 수확 전후 내용 해시는 일치했다. 전체 Git 트리 수확 및 Proof/CAS 정착은 이 시험 범위에 포함되지 않는다.
- Windows Kernel 집중 회귀는 11 PASS, 7 플랫폼 조건 SKIP이었다. 첫 실행의 4건 실패는 Git 시스템 설정 `core.autocrlf=true`의 줄바꿈 변환에 따라 재현됐다. 시험 프로세스에만 `core.autocrlf=false`를 적용한 재실행에서 해결했다. 두 Host의 물리 Workspace 중복 예약 거부와 CAS 후 복구는 기존 시험 경계에서 통과했다. 실제 Windows 모델 Worker의 같은 Run 재개는 미검증이다.

## 로컬 후속 검증 — Native 결과 정착과 동일 Run 수동 복구

- 기존 T30 시험의 Windows 로컬 변형에서 실제 App Server `command/exec`가 각각 두 Worktree에 결과를 썼다. 일반 Dispatcher에서 Proof 성공은 Owner revision `0 → 1`과 Report 두 건을 기록했다. Proof 실패는 revision `0`, Report 정착 0건을 유지했다. 두 시험 모두 통과했다. 이 변형은 `guardedIntegration`이나 모델 Tool 경로의 수용 근거가 아니다.
- 같은 계정에서 Windows `unelevated` Proof 후보를 별도 파일 객체로 비교했다. App Server `command/exec`에 한 개의 writable root 및 두 임시 경로 제외 옵션을 적용하면 직접 경로와 junction 쓰기는 `EPERM`이었다. 그러나 사전 하드링크 쓰기는 허용됐고 Owner 해시가 바뀌었다. 기본 CLI `:workspace` 프로필 시험에서도 보호 파일이 변경됐다. 현재 Windows 제품 Proof 보호를 활성화할 근거로 사용할 수 없다.
- 별도 Git·Kernel Runtime 시험에서 실제 모델 Tool과 분리 Writer가 쓰는 동안 Job 소유 Host를 강제 종료했다. 관측 PID가 모두 사라진 뒤 새 Control Plane이 같은 Run과 이전 Attempt를 다시 읽었다. 이전 Worktree 재예약은 거부됐다. 시험 제어기가 이전 Attempt를 명시적으로 실패 처리한 뒤 같은 Run·Step에 새 Attempt와 별도 Worktree를 만들었다. 실제 후속 모델 Tool 쓰기는 성공했고 Owner revision은 `0`이었다.
- 같은 시험 Run에 제품 Host의 Worker 시작을 별도로 요청하면 `host_worker_previous_attempt_unreconciled`로 차단된다. 수동 복구 성공은 제품 자동 재개가 아니다. **인계 판정: HOLD_SAFE.** Windows Proof의 별도 쓰기 주체와 제품이 검증할 수 있는 Writer 종료 근거를 연결한 뒤, 보호된 Proof/CAS 및 동일 Run 재개를 실제 경로에서 다시 검증해야 한다.

## AppContainer와 Job Object 결합 시험

- 고유 패키지 SID에 Proof 디렉터리 쓰기 ACL과 Low Integrity를 적용했다. Owner에 읽기만 허용한 뒤 기존 하드링크와 junction을 만들었다.
- 최초 Node 실행은 진입점 해석 중 드라이브 루트 조회에서 EPERM으로 실패했다. 시험 전용 옵션으로 이 조회를 피한 뒤 Node와 분리 자식에서 Proof 쓰기 2건 성공, 보호 쓰기 6건 거부, Owner 해시 보존을 확인했다.
- 정지 상태의 AppContainer 부모를 Job에 먼저 넣고 실행했다. 부모가 종료한 뒤 분리 Writer가 살아 있음을 프로세스 핸들로 확인했다. 마지막 Job 핸들을 닫은 뒤 동일 Writer 핸들이 5초 안에 종료 신호를 반환했다. 프로필 삭제 결과는 0이었다.
- 원본 출력은 Windows Public의 MoonRelayProbe61b8a699483741009faaa08452e41405/proof/stdout.txt에 있다. 재현 스크립트는 Windows TEMP의 moonrelay-appcontainer-profile-e734e179/Run-AppContainerJobProbe.ps1이다.
- 보호된 Windows Proof의 후보 경계다. 범용 명령 실행, 비참여 Medium Integrity Writer, 전체 Git 스냅샷 및 제품 Proof/CAS는 이 결과로 수용하지 않는다.

## AppContainer의 표준 Windows Proof 명령 검증

- 실제 Windows Proof 실행기가 사용하는 cmd.exe /d /s /c 경로로 npm.cmd run test:ok를 실행했다. 실제 C: 경로는 Node의 드라이브 루트 조회에서 EPERM이었다. 같은 시험 폴더를 임시 드라이브로 매핑한 뒤 Node 전용 옵션 없이 표준 npm 명령이 종료 코드 0을 반환했다.
- 새 폴더에 권한을 부여한 뒤 공격용 하드링크·junction을 만들었다. npm 스크립트와 분리 자식 모두 Proof에 썼고, Owner 직접 경로·하드링크·junction 쓰기 6건은 EPERM이었다. Owner 해시는 일치했다. 임시 매핑과 AppContainer 프로필을 정리했다. 원본은 Windows Public의 MoonRelayCommands4b633a40b9c04395a1070acdab0a1f72/mapped-adversarial.json이다.
- 기존 하드링크가 있는 폴더에 상속 ACL과 Low Integrity를 다시 적용한 별도 시험은 Owner 파일 객체 자체의 보안 정보와 내용을 바꿨다. 이미 존재하는 작업 트리에 재귀 ACL을 부여해서는 안 된다. 별칭을 포함한 외부 데이터를 들이기 전에 새 독립 파일 객체에 경계를 설정해야 한다.
- Git for Windows의 git status는 실제 경로와 임시 매핑에서 모두 /dev/null 접근 거부로 종료 코드 128이었다. 표준 npm 통과는 Git이나 범용 Proof 명령의 수용 근거가 아니다. 실제 제품 Proof/CAS와 자동 재개 차단은 유지한다.

## Windows guarded Dispatcher 시험과 CAS 이후 반례

- 시험 전용 Node 로더로 Windows Dispatcher 진입 차단과 쓰기 격리 실행기만 교체했다. 제품 코드와 기본 차단은 유지했다. 두 실제 App Server 명령이 각각 별도 Worker Worktree를 작성했다. 기존 Dispatcher가 별도 통합 Worktree에 결과를 합쳤고, 시험 실행기가 5개 입력을 새 파일로 복사한 뒤 원본 전후와 복사본의 해시를 확인했다.
- AppContainer 및 Job Object로 표준 npm Proof를 실행했다. 부모와 분리 자식의 Owner 직접·하드링크·junction 쓰기 6건이 거부됐다. Owner 대상 파일의 해시와 ACL이 유지됐다. 정상 Proof는 실제 Owner revision 0 → 1과 Canonical Report 2건을 기록했다. 실패 Proof는 revision 0과 Report 0건을 유지했다.
- 별도 반례에서 통합 Proof는 그대로 통과했다. CAS 이후 Canonical Report가 같은 검증 명령을 Owner에서 다시 실행할 때, 시험 스크립트가 Owner 저장소 밖의 시험 파일을 변경했다. Dispatcher는 revision 1과 Report 2건을 기록하고 성공을 반환했다. 보호 Proof 한 곳의 격리만으로는 정착까지의 쓰기 배제를 보장할 수 없다.
- 원본 시험 코드와 결과는 Windows TEMP의 moonrelay-guarded-dispatch-fixture-82c1d7에 있다. guarded-output.txt는 두 양·음성 사례, post-cas-output.txt는 정착 반례다. 파일 5개의 시험 수확은 전체 트리 동결의 증거가 아니다. 제품 시작 차단과 HOLD_SAFE를 유지한다.

## Report 정착 Proof 수정과 Windows 재검증

- Guarded Dispatcher가 기존 통합 Worktree를 내부 Report 정착 호출에 전달한다. Kernel은 Owner 전달 소스와 통합 Worktree를 비교하고, Proof 실행 전후에 통합 소스가 일치하는지 확인한다. 보호 실행 성공 근거가 없으면 증거를 정착하지 않는다. 기존 일반 Report 경로에는 같은 제한을 적용하지 않는다.
- 이전 CAS 이후 외부 쓰기 반례를 같은 Windows 시험 실행기로 다시 실행했다. 외부 파일은 그대로였고, 정상 사례의 Owner revision은 1, Report는 2건이었다. 실패 사례의 revision과 Report는 0이었다. 결과는 Windows TEMP의 moonrelay-guarded-dispatch-fixture-82c1d7/post-cas-fixed-output.txt에 있다.
- 기존 macOS guarded 테스트에도 정착 Proof의 외부 쓰기 회귀 검사를 추가했다. Windows 집중 회귀 12 PASS와 macOS 조건 2 SKIP, 빌드와 모듈 경계 검사 PASS, Moonremote 타입 검사 PASS를 확인했다. Windows 보호 실행기는 시험 전용으로 연결했다. 제품의 Windows 진입 차단과 자동 재개 보류를 유지한다.

## Windows Job 종료 회계와 동시 재개 시험

- 별도 시험 감독 프로세스가 시작 시점이 일치하는 Host의 프로세스 핸들을 보존했다. 실제 App Server와 모델 Tool을 시작하기 전에 정지된 실행 프로세스를 Job에 할당했다. Host 강제 종료 신호 뒤 TerminateJobObject를 호출하고 QueryInformationJobObject로 활성 프로세스 10 → 0을 확인했다. Job은 실행 중 총 22개 프로세스를 기록했다.
- 감독 프로세스가 Run·Attempt·Workspace와 Host 시작 시각이 포함된 종료 기록을 새 파일로 저장했다. 시험 제어기는 이 기록을 대조한 다음 이전 Attempt를 명시적으로 실패 처리했다. 독립 Control Plane 2개가 같은 Step의 기존 원자적 bindStepAttempt를 경쟁했다. 하나는 새 Attempt를 얻고 다른 하나는 STEP_ATTEMPT_ALREADY_CLAIMED로 거부됐다. 실제 후속 모델 Tool은 새 Worktree에서 한 번 실행됐고 Owner revision은 0이었다.
- 실제 모델 Tool에 감독 디렉터리의 시험 파일 직접 쓰기와 사전 하드링크 쓰기를 시켰다. 직접 쓰기는 EPERM이었으나 하드링크는 외부 파일을 변경했다. 같은 SID에서 파일 경로 분리만으로 감독 증거의 신뢰성을 증명할 수 없다. 종료 기록을 제품에서 소비하려면 감독 경계의 별도 OS 쓰기 권한 및 재조정/재개 접합을 검증해야 한다.
- 원본은 Windows TEMP의 moonrelay-native-drain-27ae47ee 및 mrd-55899581에 있다. 제품 시작 및 자동 재개의 차단은 유지한다.
