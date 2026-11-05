# T50 후속 — 로컬 Native 전용 검증 실행계획 (Windows 우선)

- 작성: 2026-11-05 KST
- 실행 담당: **Windows 로컬 Codex / 실제 Windows Native 프로세스**. macOS 전용 단계는 해당 플랫폼의 실제 Native 실행기에서 별도 수행한다.
- 기준 저장소: `C:\dev\moonshot-relay` (Windows), Canonical MCP 소스 `/shared/moonshot-relay`; 시작 전 반드시 `git rev-parse HEAD`로 최신 `origin/main` 확인. 작성 시 기준 `dc25ef6ceb17ab6b7c8d97beb072138ef2a21d6d`.
- 기존 계약: [T50 결과](T50_NATIVE_OS_ISOLATION_FEASIBILITY_AND_FINAL_DECISION_2026-11-05.md), [검증 계약](VERIFICATION.md), [T49 증거](T49_PARALLEL_EVIDENCE_MATRIX.md), [현재 상태](STATUS.md). **I01~I12, T01~T27, G0~G6를 변경하지 않는다.**
- 목적: **원격 MCP에서 증명할 수 없던 실제 OS/Native 권한과 Codex App Server·Tool·분리 후손의 쓰기 격리만** 로컬에서 확인하고, 재사용 가능한 결과를 MCP 구현 단계로 인계한다. W1~W6 전체 구현·수용은 이 로컬 계획의 범위가 아니다.
- **현재 판정: `HOLD_SAFE`**. 이 계획은 Native 자동 합류, 예약 자동 해제, Owner CAS/Report 기본값을 승인하지 않는다.

## 0. 로컬과 MCP의 책임 분리

| 담당 | 수행 | 수행하지 않을 일 |
| --- | --- | --- |
| Windows 로컬 Codex | 실제 native 실행 확인, 보안 주체/DACL/Job Object 등 capability, 독립 Fixture에서 실제 Codex App Server·Tool 권한 상속과 공격·중단 시험, 증거 수집 | 운영 Codex 세션/프로필/인증 변경, 원본 `main` 수정·강제 reset/clean, 미증명 Native auto-join 활성화 |
| macOS 로컬 (별도 지원 검증) | 기존 T44 하드링크 우회·동일 UID 반례를 **새 독립 권한 계정/실제 Tool**에서 재시험 | Seatbelt 단독 PASS를 플랫폼 전체 PASS로 승격 |
| Moonremote MCP | 구현 설계·공통 코드 최소 변경, Kernel/fixture 회귀, 통합·문서·커밋·푸시, G0~G6 판정 | 로컬 Native 출력 없는 상태를 PASS로 주장하거나 테스트 권한 우회 |

**로컬 실행 순서:** L0 → (L1A, L1B는 서로 다른 격리 Fixture이면 병렬 가능) → L2 → L3 → L4 → L5(조건부) → L6. L2~L4는 같은 권한·파일 객체를 다루므로 반드시 순차 실행한다. macOS는 Windows와 독립 진행할 수 있다.

## 공통 안전 조건과 중단 기준

1. 기존 작업·세션·사용자 CODEX_HOME·운영 SQLite·예약·실사용 Git Worktree·원본 `main`을 대상으로 쓰기·삭제·종료를 하지 않는다. 별도 `TEMP` 디렉터리, **독립 Clone**, 테스트 Runtime 및 명시적으로 준비된 **테스트용 CODEX_HOME**만 사용한다.
2. 보안 토큰/인증 파일을 복사·로그·Commit하지 않는다. 실제 모델 Turn 인증이 필요하면 별도 정식 인증 수단을 확인하고, 불가하면 그 항목은 `DEFER`로 정착한다. 인증 실패를 모의 Native PASS로 바꾸지 않는다.
3. 호스트 OS에 새 서비스·상주 감시자·계정·ACL·정책을 **자동 설치/변경하지 않는다**. 격리 사용자 또는 AppContainer 준비에 관리자 승인/사용자 개입이 필요하면 위험·변경 범위를 기록하고 **사용자 승인 대기**로 정착한다. 실계정 권한을 바꾸지 않는다.
4. 각 단계의 시작·종료 시 프로세스 트리·OS 실행 주체·파일 소유자/ACL·경로·시간·hash를 **test-owned 범위 안에서** 캡처한다. 생성한 실제 손자/Tool의 생존·종료가 불확실하면 임시 루트도 제거하지 않는다.
5. 보호 대상 Owner를 Worker와 **다른 쓰기 권한 도메인**에 놓는다. Worktree와 Owner 간 사전 하드링크·공유 writable inode/FD를 허용하지 않는다. 경로 문자열·`git status clean`·`stat` 1회·Job 종료 코드만으로 보호 입증 금지.
6. **T25/T26 또는 I03 위반 1건**, 비의도 Owner/외부 파일 쓰기 1건, Worker 권한 상승·Tool 권한 상속 실패 1건, 인증 비밀 새 노출 1건이면 해당 후보를 `FAIL/HOLD_SAFE`로 정착하고 확대 실행을 중단한다.
7. 결과 상태는 `PASS | PARTIAL | FAIL | DEFER | NOT_RUN`. 실제 실행 없는 플랫폼은 `DEFER`. `unknown`과 `SKIP`은 PASS가 아니다. 증거 제출 전까지 이 계획에 PASS를 선기입하지 않는다.

## L0 — 환경 보호·Native 실행 증명 (필수 선행)

**작업:** Windows PowerShell을 **Windows OS 자체**에서 열고 다음 항목을 읽기 전용으로 관측한다.

- Windows 버전/빌드, 계정 SID, 관리자·Integrity Level, 실제 OS, 설치된 `codex` 실행 파일과 버전, Node 버전.
- `git status --porcelain`, `git rev-parse HEAD`, `git rev-parse origin/main`, 작업 중인 Git Worktree 현황. 기존 변경·staged·진행 작업이 있으면 **보존하고 독립 Clone**을 만든다. `main`에 `reset --hard`하지 않는다.
- 실제 Codex App Server 시작 경로와 transport 호출 인터페이스를 소스에서 확인한다(`src/host/kernel/codex-app-server-transport.ts`, `host-owned-writable-attempt.ts`). CLI 하위 명령, IPC 메시지, token 필드는 **현재 설치본 help와 소스 확인 후** 사용한다.
- 테스트용 계정·보호 디렉터리·DACL 정책을 만들 **권한이 있는지** 확인한다. 권한이 없으면 `DEFER`로 기록하고 계정 생성이나 UAC 승격을 자동 시도하지 않는다.

**증거:** `L0_ENVIRONMENT.md` (Native 여부, OS/버전·Git SHA·설치본·보호 영역·권한 가능 여부), 민감 정보를 제외한 command+exitCode+원본 로그 참조.

**Exit:** Native Windows와 테스트 격리 환경이 식별되고 사용자 작업 비간섭 확인. 연결이 WSL/컨테이너이면 Windows Native 결과로 쓰지 않고 해당 Gate `DEFER`.

## L1A — Windows OS 권한·프로세스 수명 후보 비교 (L1B와 병렬 가능)

**작업:** **새로 생성한 테스트 프로세스**와 파일만 사용해 Windows 권한 후보를 실측한다.

1. 서로 다른 보안 주체(별도 테스트 계정, 제한된 토큰 또는 AppContainer)의 **실제 Token SID/Group/Integrity/Privileges**를 확인한다. `Job Object`는 후손 수명 제어 **보조 수단**으로만 평가하고 파일 쓰기 권위와 구분한다.
2. ACL을 명시한 테스트 Owner 디렉터리와 Worker 전용 디렉터리를 만들고 Worker의 직접 접근, symlink/junction/reparse point, 사전 생성 hardlink, 동일 권한 외부 Writer를 각각 시험한다.
3. Worker 작업 결과 쓰기는 허용해야 한다. 낮은 권한 Writer가 Owner에 직접/별칭으로 쓸 수 있거나 권한을 되돌릴 수 있으면 해당 후보는 FAIL.
4. Job 할당·종료·breakaway/reparenting 가능한 경우의 결과를 기록한다. 단순 부모 종료를 **모든 후손 종료** 증거로 간주하지 않는다.

**증거:** `L1_WINDOWS_OS_BOUNDARY.md`에 기술별 실제 허용/거부 코드, OS Token·DACL·보호 주체, 실패 반례, 관리자 권한 필요 여부와 지원/미지원 범위.

**Exit:** 파일 권한과 프로세스 수명 제어의 책임이 분리된 후보 1개 또는 명시적 `HOLD_SAFE`. 정책을 새로 상주시켜야만 가능한 구조는 이유와 비용을 기록하고 자동 채택하지 않는다.

## L1B — 원본 Native Codex 기능·인증 분리 확인 (L1A와 병렬 가능)

**작업:** 실제 설치본의 App Server `initialize`와 모델 Turn/Tool을 **각각 독립 조건**으로 검증한다.

1. 실사용 계정이 아닌 임시 `CODEX_HOME`에 대해 **기존 안전한 인증 방법이 지원되는지만** 확인한다. 운영 인증 데이터 복사 금지.
2. 새 Worktree의 읽기/쓰기 허용 Scope, 실제 요청과 실행된 `model/effort/sandbox/approval` 차이를 기록한다.
3. 실제 모델·Tool 실행이 가능하면 시작 App Server PID/Token과 Tool 프로세스 PID/Token을 관측한다. `initialize`만 성공했으면 Tool 관련 부분은 `DEFER`.

**증거:** `L1_NATIVE_CODEX_CAPABILITY.md`, `initialize`와 Turn/Tool을 구분한 상태·원본 이벤트 참조. API key·토큰 내용은 저장하지 않는다.

**Exit:** 실제 Native Tool 권한 상속 실험의 준비 여부 판정.

## L2 — 실제 Native Tool·Shell·분리 후손 권한 상속

**선행:** L1A의 파일 보호 후보 + L1B의 실제 모델 Tool 실행 가능성. 하나라도 불가하면 `DEFER`하고 L3의 **Native 수용**까지 확장하지 않는다.

1. Host가 실제 App Server를 시작하기 **전부터** 격리 보안 주체를 부여한다. 모델 Turn의 권한 변경만으로 App Server가 낳는 OS Tool 전체를 격리했다고 주장하지 않는다.
2. App Server → Tool → Shell → 중첩 손자 → 독립 세션/PGID 유사 분리 후손까지 각각 Token/SID/Integrity/ACL 접근 결과 기록.
3. 생성 이후 부모 Host 종료, App Server 정상 종료·강제 종료, Tool의 지연 쓰기를 같은 보호 Owner와 **새 Owner 세대**를 대상으로 시험한다.
4. 같은 보안 주체의 외부 비협조 Writer도 시험한다. Worker와 동일 권한의 외부 Writer가 **Worker Worktree를 변경**하는 것은 파일 보호 모델에서 무시할 수 없는 위험이다. 발생하면 단순 DAC PASS로 전체 안전성을 승인하지 않는다.

**증거:** `L2_NATIVE_DESCENDANT_RESULT.md`, 실제 Tool 이벤트·PID/Token·전/후 hash·오류 코드·잔여 후손 정리 상태.

**Exit:** 임의 분리 후손 종료를 증명할 필요는 없더라도, 모든 해당 실행 주체가 이전·새 Owner·Proof/CAS 권위 영역을 **지속적으로 변경할 수 없는지**를 OS 수준에서 입증해야 한다.

## L3 — 파일 객체·결과 수확·Proof/CAS 이전 경쟁 반례

**선행:** L2가 유효한 실제 Native 도메인 증거로 통과한 경우에만 착수.

1. 테스트에 사용한 모든 대상 파일의 생성 시점, 파일 ID/inode 성격, 물리 저장영역, 공유 hardlink/reparse object, 열린 writable FD/handle을 점검한다.
2. Worker는 작업 중 쓰기를 지속하고 Host는 **격리된 새 파일 객체**로 결과를 수확한다. 복사 전후 source 파일 목록·내용 hash·Git result/patch/receipt를 대조한다. 원본 작업 중 변경이 관측되면 그 Snapshot은 무효. 임의 변경 가능 원본에 대해 동결을 증명하지 못하면 `DEFER/FAIL`.
3. 결과 수확/Proof/CAS 시 old Writer late write, 동일 scope 두 Host 경쟁, Fence 만료, 새 Host 재진입, 사전 존재 hardlink·새 링크/rename 시도를 실제 분리 Host에서 시험한다.
4. 기존 Kernel Owner CAS 한 번·Report 정착, 실패 시 0 중복 Worker의 불변식을 유지한다. **새 완료 권위, DB, Queue, Scheduler를 만들지 않는다.**

**증거:** `L3_SNAPSHOT_AND_FENCING_RESULT.md`, 파일·Git 정합성/전후 hash·CAS revision·Attempt·Report·후손 쓰기 거부의 원본 증거.

**Exit:** I02/I03/I04/I05, T25/T26 보호를 Native 실행에서 증명한 경우에만 구현 후보로 인계. 성공해도 제품 기본 자동 합류 활성화 금지.

## L4 — 격리 Host 중단·재연결·제어권 검증

**선행:** L3 통과.

- 연결만 종료, Main 교체, Host 프로세스 종료, App Server 종료, Tool 중단/생존을 **서로 다른 실험**으로 구분.
- Kernel Run/Step/Attempt 원본 재조회 및 `status/signal/cancel/approval` 적용 시점 관측. User Input 대기 시 자동 재개 금지.
- 기존 Goals/Dispatcher와 충돌하는 새로운 Loop가 없는지, 기존 Outcome/Trust·ContextReceipt·원본 transcript/event가 보존되는지 확인.
- Main 재연결이 OS 실행 중인 명령을 **그대로 재개**할 수 있다는 주장은 별도 증거가 없으면 하지 않는다.

**증거:** `L4_HOST_RECONNECT_RESULT.md`, I01/I04/I06~I12 및 T03~T18/T24/T26 중 실제로 실행한 항목과 미실행 항목 구분.

## L5 — macOS Native 별도 수용 (지원 목표인 경우)

- 별도 **시험용 macOS OS 계정/권한**과 보호 Owner 경계가 실제로 준비된 경우에만 수행. 사용자 Codex 홈/원본 Git 접근 권한을 변경하지 않는다.
- T44 사전 hardlink 쓰기 100/100 우회, T46 동일 UID 비협조 Writer, T39 분리 후손, T48 임시 CODEX_HOME App Server initialize를 **실제 모델 Tool·별도 권한 경계**에서 재검증한다.
- Seatbelt·`chmod` 단독은 T44/T47의 기존 실패 증거를 무효화하지 못한다. OS 계정/파일 객체의 권한 분리가 없는 경우 `DEFER`.
- Windows 결과는 macOS Native의 PASS가 아니며, macOS 미지원이라면 해당 플랫폼은 `DEFER`로 명시한다.

**증거:** `L5_MAC_NATIVE_RESULT.md` (실제 macOS OS 정보, Token/UID·자식 상속·hardlink·비참여 Writer·자료 비파괴).

## L6 — 로컬 증거 인계·최종 수용 범위 정리

**필수 결과 한 개:** `LOCAL_NATIVE_VERIFICATION_RESULT.md`. 포함 항목:
- 수행 Host/OS/build, Git SHA, Codex 설치본/모델/effort/실제 권한·runtime (비밀 제외).
- L0~L5별 `PASS/PARTIAL/FAIL/DEFER/NOT_RUN`; 성공한 항목과 재현된 반례 및 조건을 정확히 분리.
- I01~I12, T25/T26, G0/G1/G5에 관련된 관측 매핑. `G2~G4/G6`는 실제로 수행하지 않았다면 무조건 `DEFER/NOT_RUN`.
- 실제 프로세스/Tool/Event·파일 hash·OS ACL/Token·명령 종료 코드·입증 범위·증거 경로·자식 처리·임시 자료 정리 상태.
- 보호에 필요한 새 서비스/관리자 승인/사용자 입력·인증 필요 여부, 시스템 영향 범위와 되돌릴 조치.
- **`IMPLEMENT_CANDIDATE` 또는 `HOLD_SAFE`** 제안. 네이티브 자동 합류를 직접 켜지 않는다.

**인계 방식:** 같은 Canonical 소스 기준에서 문서/코드 변경이 없다면 MCP가 원본 증거를 읽을 수 있는 repo 문서 경로에 **비밀 제외 요약**을 반영한다. 원본 로그는 필요한 최소 참조만 남긴다. 로컬 변경사항이 있으면 별도 Branch/Commit/경로를 명시하고 사용자 `main` 변경을 임의로 덮지 않는다. 이후 공통 구현·리뷰·통합·커밋·푸시는 MCP 담당.

## 빠른 판정

| 상황 | 로컬 종료 및 인계 |
| --- | --- |
| Windows Native 구동/격리 주체 생성 불가 | L0/L1까지만 `DEFER/HOLD_SAFE`; 이후 Native Tool 검증을 허위 PASS로 대체하지 않는다 |
| 실제 Codex Tool 인증이 별도 테스트 환경에서 불가 | L1B는 `DEFER`, L2~L4 Native 수용 중단. 비밀 복사 금지 |
| L2에서 권한 상속 실패, Owner late write, 외부 inode 변경 | `FAIL/HOLD_SAFE`. 더 많은 예외 규칙 없이 실패 메커니즘 기록 |
| L2~L4 전체 OS·FS·Kernel 증거 충족 | `IMPLEMENT_CANDIDATE`를 **문서로만 제안**. MCP가 가장 작은 기존 Host 접합과 검증·G0~G6를 별도로 진행 |
| macOS 수행 불가 | Windows 결과만 제출, macOS `DEFER`; Linux/Windows 증거로 보완하지 않음 |

## Windows 로컬 Codex 첫 요청 (복사해서 시작)

> `C:\dev\moonshot-relay`의 최신 `origin/main`을 읽고, `docs/public/roadmaps/host-owned-worker-context-continuity-2026-11-03/LOCAL_NATIVE_VERIFICATION_EXECUTION_PLAN_2026-11-05.md`에 따라 **L0만** 수행해줘. 원본 `main`, 사용자 Codex 계정·인증·진행 세션·Runtime DB·예약은 변경하지 말고, 필요한 독립 테스트 디렉터리와 Clone만 마련해줘. Native Windows OS인지, 실제 Codex 설치본과 권한·격리 계정/DACL/Job Object capability를 확인하고 `L0_ENVIRONMENT.md`에 PASS/PARTIAL/DEFER 및 증거를 기록해줘. 관리자 승인이나 인증이 필요하면 임의로 진행하지 말고 정확한 요구 조건만 보고해줘. L1은 시작하지 말아줘.

**로컬 사전 준비를 위해 모든 단계의 코드를 먼저 작성할 의무는 없다. 각 단계가 검증된 뒤 다음 단계로 진행하며, 원본 계약 및 기존 Native 안전 차단을 유지한다.**
