# T49 이후 — Host-owned Worker 통합 병렬 검증·구현·최종 판정 실행계획

- 작성: 2026-11-05 (KST)
- 소유 저장소: \`main\`, Moonremote canonical \`/shared/moonshot-relay\` (Windows \`C:\dev\moonshot-relay\`)
- 작성 시 기준: \`e3a4fef2cac6637f97b79d993bdc9e54c53f95bb\` / 기존 W0 G0 **PARTIAL**, W1 **DEFER**
- 종류: **실행 프리셋·검증 계획**, 새 제품 API·구현 승인·기존 테스트 PASS 판정 아님
- 원본 계약: [PLAN](PLAN.md), [VERIFICATION](VERIFICATION.md), [STATUS](STATUS.md), [W0_RESULT](W0_RESULT.md)
- 목표: **동시에 할 수 있는 검증을 묶어서 한 번에 끝내고**, 기술적으로 가능한 기능만 최소 구현·검증·채택한 후 **명시적 최종 상태**로 종료한다.

## 0. 최종 목표와 금지사항

최종 사용자 기능은 Main/MCP 연결 또는 Context 압축·교체가 발생해도 같은 Kernel Run/Step의 실제 Worker 실행 상태와 원본 Evidence를 새 Main에서 재조회하고, **검증된 경우에만** 재개·Owner 정착을 정확히 한 번 수행하는 것이다.

- Kernel Work/Trust/Knowledge가 단일 권위이다. Thread/Turn/PID/Lease/Host summary는 원본 실행 관측이지 완료 권위가 아니다.
- **I01~I12, T01~T27, G0~G6와 W1~W6 계약을 변경하지 않는다.** 이 계획은 그 검증을 병렬 배치하는 작업 안내서다.
- 실제 Native Writer와 임의 분리 후손의 물리 종료 또는 다음 Owner/Worktree에 대한 미래 쓰기 배제가 미증명이면 \`writerExitVerified:false\`, \`deliveryAuthorized:false\`, Native 자동 재합류·예약 자동 해제 **계속 금지**.
- T44의 **Sandbox 진입 전에 존재한 외부 inode 하드링크 100/100 쓰기 가능**, T45의 Git-clean 별칭 비검출, T46의 동일 UID 비예약 Writer 동시 쓰기, T47의 chmod/비참여 프로세스 한계는 **필수 반례**다. 긍정 시험이 통과해도 제거되지 않는다.
- 사용자 Mac Codex 계정/프로필/자격증명/진행 중 세션/실사용 DB·예약·원본 Worktree를 테스트 대상으로 사용하지 않는다. 비밀을 새 로그·문서에 복사하지 않는다.
- 제품 기본 Dispatcher·Owner 경로·자동 Cleanup을 동의 없이 활성화/변경하지 않는다. 선택형 경로에서 증명한 성질을 기본 경로에 전용하지 않는다.
- 새 Queue·Worker DB·Scheduler·전역 파일 스캔·항상 켜진 감시자·Provider별 폴백·일회성 예외 분기는 **실제 반례와 더 단순한 대안 검토 없이 도입하지 않는다**.
- Linux·macOS·Windows 증거는 각각 독립 판정. macOS Seatbelt PASS를 Linux/Windows PASS로 계산하지 않는다.

## 1. 재사용할 증거 — 재실행하지 않는 범위

| 기존 근거 | 이미 확인한 사실 | 아직 증명하지 못한 것 |
| --- | --- | --- |
| T39~T40 | Mac 실제 Native App Server/Tool 분리 Grandchild 생존, 그룹 종료와 OS 쓰기 격리의 차이; 새 복구 Worktree·Owner에 대한 제한된 쓰기 거부 | 모든 임의 후손의 종료·공유 inode 불변 |
| T41~T42-B2-C | 선택형 OS Scoped Proof, Fence 전 구간 보호, 복구 Host 경쟁, CAS 1회·2 Report, CAS 직후 Crash fail-closed | 임의 Native Writer 결과의 자동 정착 |
| T43~T43-A | Proof 중 Receipt 지연 변경 차단; 간헐 Host 종료의 시험 진단 개선 | 미래의 모든 쓰기 봉쇄, 간헐 실패 최초 신호 확정 |
| T44~T46 | Mac 기존 하드링크 우회, Git-clean Worktree 재사용 별칭, 동일 UID 비예약 프로세스의 생성 후·실행 중 쓰기 | 협조하지 않는 Writer 전체의 지속 격리 |
| T47 | Linux 다른 비특권 UID DAC 차단, 현 MCP Namespace EPERM; Mac 동일 UID chmod 복원 및 비Sandbox 형제 쓰기 | 별도 UID/Namespace를 현행 Native에 도입할 수 있는지 |
| T48 | Mac 임시 CODEX_HOME + canonical Seatbelt의 실제 App Server \`initialize\` 성공, Scope 밖 쓰기 거부/읽기 허용 | 격리된 실제 모델 Turn·Tool 후손, 인증·자격증명 호환, 전체 실행 보호 |
| W0 Context T23 | 필수 Context/Receipt 일치 보완 SOURCE PASS | G0 전체 Native capability PASS |

실행 전 기존 증거의 **커밋·원본 테스트·Host/OS 버전·출력·반례 적용 범위**를 검증 매트릭스에 연결한다. 출력이 없거나 오래됐다는 이유만으로 이전 PASS를 FAIL로 낮추지 않지만, 코드/환경이 달라져 무효이면 해당 케이스만 재검증한다. 과거 단일 FAIL은 추후 PASS로 소급하지 않는다.

## 2. 통합 병렬 실행 구조

**하나의 T49 통합 검증 Wave를 여러 독립 Lane으로 나눈다.** Lane 결과는 각각 PASS/PARTIAL/FAIL/DEFER로 판단한다. **동일 Git Checkout·SQLite WAL·실제 사용자 계정·Owner mutation scope를 공유하는 Lane을 동시에 실행하지 않는다.**

| Lane | 담당/실행 위치 | 독립 작업·검증 | 시작 의존성 | 독립 완료 산출물 |
| --- | --- | --- | --- | --- |
| A — Native OS 도메인 | Mac MCP, 독립 Git Clone + 임시 CODEX_HOME | App Server/Turn/Tool 상속, 분리 후손, 부모 종료 뒤 쓰기, sandbox 범위, 인증 필요조건 | W0 자료 및 T48 증거 | \`A_NATIVE_DOMAIN_RESULT\` |
| B — 파일시스템 권위 | Linux/Mac 각각 격리 Clone/OS Fixture | 이전 하드링크·동일 UID 동시 쓰기 반례가 후보 격리 경계에서 차단되는지; 다른 UID/FS 권한·제한 플랫폼 capability | W0 자료 및 T44~T47 증거 | \`B_FS_AUTHORITY_RESULT\` |
| C — Kernel 경쟁/복구 | Linux 독립 Clone·별도 Run/DB | 시작 전~Proof~CAS~Report Fence; CAS crash·TTL·stale Receipt·이중 Host·unknown 중복 차단 | W0 자료 및 T41~T43 증거 | \`C_RECOVERY_RESULT\` |
| D — 제어·원본·계약 | Linux 독립 Clone, 필요한 실제 Host는 격리 | Main 종료/재연결·status/signal, Attempt/Turn/원본·ContextReceipt, 승인/취소·비밀 누출·Goals 중복 권위 | W0/G0 기존 계약 | \`D_CONTINUITY_RESULT\` |
| E — 플랫폼 Capability | Linux, Mac 및 **실행 가능한** Windows native 별도 환경 | Codex 설치본/권한/보안 도메인·OS 자식 수명 지원/미지원 판정. WSL 테스트를 Windows native로 간주하지 않음 | 없음 | \`E_PLATFORM_MATRIX\` |

**A~E는 병렬 조사·테스트 가능**. 각 Lane 안에서 동일 mutation scope의 자식 생성·종료·파일 검증은 필요한 순서를 유지한다. Linux/Mac MCP 도구 호출을 동시에 하더라도 동일 추적 작업의 상태 업데이트/최종 Git Writer는 직렬 수행한다. 필요한 Windows native 실행기가 없으면 E/Windows는 \`DEFER\`로 확정하고 Linux PASS로 대신하지 않는다.

### 병렬 결과의 격리 조건

- Lane마다 고유 \`/tmp\` 테스트 루트, Git clone/worktree, \`CODEX_HOME\`, Runtime Home, Test Kernel DB, Run/Step/Attempt 및 프로세스 식별을 사용한다.
- Mac 실제 사용자 Checkout은 **검증용으로 clone만** 사용한다. Mac 원본 Git/계정 설치는 변경하지 않는다.
- 각 Lane의 OS 프로세스/후손 종료가 입증되지 않으면 그 시험 루트와 예약을 **삭제하지 않고 격리 보존**한다. \`ps\` 결과만으로 전체 임의 후손 부재를 주장하지 않는다.
- A의 Native 모델 실행에 기존 사용자 인증/비밀 복사가 필요하면 실행하지 않는다. 별도 인증 지원이 실제로 있는지 확인하고 없으면 A 해당 케이스만 \`DEFER\`한다. 모의 Node 시험을 실제 Native PASS로 대체하지 않는다.
- 공유 증거는 **읽기 전용**으로 참조한다. 한 Lane이 만든 파일이나 mutable Fixture를 다른 Lane에서 직접 사용하지 않는다.
- 출력은 간결한 결과/로그 경로/operationId를 기본으로 한다. 실패 원인 분석 때만 상세 로그를 재조회한다.

## 3. Wave 계약 — 병렬 조사 → 공통 설계 → 최소 구현 → 종합 검증 → 제품 판정

### Wave P0 — 계획 고정·증거 매핑 (구현 없음)

1. 기존 W0 \`STATUS/W0_RESULT/VERIFICATION\` 및 T39~T48의 **증거 출처·상태·무효화 조건**을 하나의 매트릭스에 연결한다.
2. A~E Lane의 정확한 테스트 이름·사용할 기존 \`tests/*.test.ts\`·실행 Host/OS·필요 인증·독립 임시 경로·시간/자원 예산·실패 시 보존 경계를 사전 확정한다. 경로/테스트 수를 고정해 새 파일을 양산할 의무는 없다.
3. Native 실제 모델 인증과 Windows native 실행 가용성을 **착수 조건**으로 분리. 불가하면 가능한 Lane을 중단하지 않고 해당 항목은 DEFER.
4. 유효한 이전 결과를 그대로 매핑하고 변경된 Code SHA/Runtime에 필요한 **최소 재검증만** 등록한다.

**Exit:** A~E 각각 준비/DEFER 사유, 실행 입력·확인할 불변식·중단 기준 확정. 산출물 1개 Matrix + 기존 체크포인트 갱신. PASS 선기입 금지.

### Wave P1 — A~E 병렬 Capability·음성 반례 검증

**Lane A — Native 부모/Tool/후손.** 임시 격리 App Server가 \`initialize\`를 완료하는 것과 실제 Turn/Tool가 작동하는 것을 분리한다. 실제 Tool 실행이 가능할 때 중첩 자식→분리 PGID 손자까지 OS 정책 상속, 파일 접근·부모 Host/App Server 종료·후손 쓰기 지속을 기록한다. 기계적으로 아는 유한 후손 종료와 **임의 후손 종료**를 다른 컬럼으로 관리한다. 실제 모델 접근 불가면 인증 파일을 복사하지 않고 DEFER.

**Lane B — FS/OS.** 정상 Worktree 생성·동일 내용 하드링크 치환·Sandbox 시작 전 외부 inode 별칭·실행 중 비Sandbox 동일 UID Writer를 통합 반례로 사용한다. 별도 비특권 UID와 DAC, Mac Seatbelt, Linux namespace/mount는 **실제로 제공되는 환경에서만** 수용한다. 단발 \`stat\`/ACL/모드 검사 통과만으로 지속 격리 PASS를 주지 않는다. 파일 접근은 권한 경계에서 막혀야 하며 파일 변경 이후 Git drift 감지는 사후 탐지일 뿐이다.

**Lane C — Kernel.** 기존 T41~T43 집중 회귀를 변경된 경계 위주로 재사용한다. 같은 Scope 1 Writer, first cherry-pick 전 Fence 유지, TTL 만료, stale epoch·CAS·Receipt drift·post-CAS crash·2 Host contention·정확히 1 CAS/2 Report·중복 Worker 0을 분리 판정한다. A/B의 물리 종료 증거 없이 Kernel CAS 성공만으로 Native Delivery를 승인하지 않는다.

**Lane D — Main/Session.** 실제 \`Run/Step/Attempt\` 재조회, 원본 transcript/이벤트 참조, ContextReceipt의 필수 내용, 새 Main의 status/signal, 권한 대기, cancel/change 경계, Goals/Dispatcher가 같은 Step을 동시에 실행하지 않는지, 비밀 없는 요약을 검증한다. 호스트 재연결은 실제 실행 중인 OS Tool 명령의 재개와 구분한다.

**Lane E — 플랫폼.** Linux/macOS/Windows 별 실제 가능 수단과 미지원 이유, 권한 요구, 사용자 환경 영향, 기존 계정·Git 도구 호환성 및 실험 증거를 채운다. 단일 플랫폼 성공을 공통 구현 약속으로 삼지 않는다.

**Exit:** 각 Lane은 \`PASS/PARTIAL/FAIL/DEFER\` 하나와 *구체적으로* 아직 미증명인 주장, 재현 명령·exit/status·증거, 안전한 임시 데이터 폐기/보존을 보고한다. 반례가 확인되면 숨기지 않는다. 미실행은 SKIP/DEFER이지 PASS가 아니다.

### Wave P2 — 단일 구조적 결정 (Lane 결과 합류 이후에만)

A~E의 결과를 바탕으로 **하나의 기술 결정**을 내린다.

| 조건 | 결정 | 허용 범위 |
| --- | --- | --- |
| 실제 Native 도구 후손의 write exclusion과 실행 권위/종료 경계가 **최초 준비부터 정착까지** 증명되고, T44~T46 별칭·비참여 Writer 반례도 경계 안에서 차단됨 | \`IMPLEMENT_CANDIDATE\` | 기존 Host/Kernel 함수의 최소 접합만 다음 P3에서 구현 |
| macOS 등 일부 OS/실행 유형만 실제 검증, 다른 Host에는 강제 수단 부재 | \`LIMITED_CANDIDATE\` | 실제 증명된 범위의 **명시적 opt-in**만. 기본 Native 자동 합류·지원 불명 Host는 DEFER |
| 임의 후손 종료나 미래 쓰기 봉쇄를 입증할 수 없고 회피 구조도 실증 안 됨 | \`HOLD_SAFE\` | 현재 보존·중복 차단 유지. Native 자동 합류·예약 해제·Owner 적용 구현 **하지 않음** |
| 실제 Owner 외부 쓰기·중복 정착·비밀 노출 등 신뢰 불변식 위반 | \`FAIL\` | 관련 실험 중단, 영향 범위 격리·근거 보존, 별도 원인 확인 후 최소 수정 |

- 2개의 Authority, 새로운 DB/Queue/스케줄러/OS별 영구 예외 목록을 대안 없이 추가하지 않는다.
- **검증이 막히면 새로운 T50/T51 번호를 자동 생성하지 않는다.** 불가능한 Capability, 필요한 외부 권한/환경, 보류한 제품 기능을 명확히 기록하고 **P1/P2를 결론까지 완료**한다.
- 안전한 우회 후보가 여러 개라면 의존성·운영 복잡도·실증 가능성을 비교해 **한 후보만** 실험한다. 여러 Sandbox 체계를 무조건 병렬 구현하지 않는다.

**Exit:** \`DECISION.md\` 1개. 근거·채택/기각 대안·변경 예상 경로·롤백·플랫폼 제한·미검증 조건 확정. \`HOLD_SAFE\`도 **정상적인 검증 종료 판정**이다.

### Wave P3 — 선택된 최소 구현 (P2에서 승인한 경우에만)

- 기존 \`host-owned-writable-attempt\`, \`codex-app-server-transport\`, \`physical-worktree\`, \`parallel-dispatcher\`, Owner Fence/Receipt/Proof 경계를 **재사용**한다.
- 새 기능은 코드 수준에서 의존된 OS Capability를 정확히 검사한다. 미지원/실행 불가 → **실제 Worker 생성 전에** typed fail-closed. 묵시적 owner-direct/Provider fallback 금지.
- 같은 실행의 Runtime·OS 원본 증거 없이는 \`writerExitVerified\`나 \`deliveryAuthorized\`를 \`true\`로 세팅하지 않는다. Token/TTL/단발 PID/clean Git/status alone은 증거가 아니다.
- Host 오류·연결 끊김·불확실한 종료 뒤 예약·Worktree는 보존. 새 Owner Writer와 겹치는 시점이 없음을 **OS 수준에서** 검증한 뒤에만 기능적 변경을 허용한다.
- **코드 변경 → 해당 Layer focused → Linux/Mac 실측 → 독립 리뷰**의 순서를 유지하되, 서로 독립된 Host별 테스트는 병렬로 실행한다.
- P2가 \`HOLD_SAFE\` 또는 제품 도입 불승인이면 **P3를 SKIP(의도적 미구현)** 처리하고 P4의 현재 안전 경계 최종 회귀·증거 정리만 수행한다.

**Exit:** 변경 파일·근거 반례·기존 함수 재사용·새 영속 상태/규칙/예외 증감·제품 동작/미지원 경계·롤백 기록. 테스트 실패 시 고치지 않은 제품 변경은 채택하지 않는다.

### Wave P4 — 통합 복구·적대적 Fault 회귀

P2/P3가 지정한 실제 적용 범위에서만 다음을 한 **격리 통합 Run**으로 검증한다.

| Fault | 반드시 확인할 불변식 |
| --- | --- |
| Main/MCP만 종료, Host 생존 | Kernel 권위/실행 ID 유지, status 원본 조회, 중복 spawn 0 |
| Host/App Server 부모 SIGKILL, Writer 분리 후손 계속 씀 | 안전한 배타성 확인 전 새 Writer/Owner 적용 0, 예약·Worktree 보존 |
| 이전 Writer 늦은 외부 쓰기/하드링크 사전 생성/준비 직후 교체 | 외부 inode/Owner 불변, 불확실하면 fail-closed |
| 두 복구 Host 첫 cherry-pick 전 동시 진입 | 같은 mutation scope 소유 1개, stale epoch 거부 |
| Proof 중 Fence TTL 만료, 예전 Writer 쓰기 | 예전 Token 재획득·CAS·Report 거부, Owner Revision 불변 |
| Owner CAS 0→1 직후 Host 강제 종료 | 확정 전 보고서/Delivery 중복 없음, 복구 상태 정확 |
| 승인 대기·취소·Unknown RPC·재연결 | 무단 진행·새 operationId 중복 실행·거짓 완료 0 |
| 원본 Event/ContextReceipt 손실·비밀 포함 입력 | 거짓 included/lossless 및 새 로그 비밀 노출 0 |

반드시 **실제 Native 적용 케이스**와 **동기식 Node Fixture**를 별도 결과로 기록한다. P2가 HOLD_SAFE이면 신규 자동 적용 테스트는 실행하지 않고 기존 fail-closed·중복 거부 회귀만 수행한다.

**Exit:** I01~I12 위반 0의 근거 또는 정확한 반례. 실제 Native 미실행을 PASS로 승격하지 않는다.

### Wave P5 — W1~W6 제품 목표와 최종 수용·성능 평가

기존 W1~W6을 *새 일련번호로 분해하지 않고* 실제 의존성 순으로 이행한다.

1. **G1/W1:** 실제 Worker 수명·Single Writer·시작 중복 방지. G0 Native 기술 경계가 미증명이면 \`DEFER\`하고 W1 Native 자동 재합류는 활성화하지 않는다.
2. **G2/W2:** G1에서 증명된 경로만 Main 재연결·status·signal·cancel/approval로 확장. \`running/unknown\` 실생존 불확실성은 차단.
3. **G3/W3:** G2 기준으로 기존 \`next→execute→report\` 루프와 Goals/Dispatcher를 하나의 권위로 연결. 3개 이상 Work Unit, 실패 후 정확한 재개, false done 0.
4. **G4/W4:** E(요약 없이 Kernel 원본 조회 Fresh Resume)를 우선. I03 old Writer 안전성 없으면 실행하지 않는다. 같은 checkpoint에서 C(E+handoff)를 비교하고 D(안전 경계 새 Thread)는 트리거 효과를 별도 비교. C/D의 고유 이점이 없으면 기본 미도입.
5. **G5/W5:** 위 실제 변경에 한정한 모든 fault/보안 반례. 기존 P4 증거가 같은 소스/Host에 유효하면 재사용하고 중복 실행하지 않는다.
6. **G6/W6:** A(owner-direct), B(Worker), E(Fresh), C(Handoff), D(Boundary)를 사전 등록된 **동일 초기 SHA/계약/Acceptance/모델-effort/Host/예산**으로 paired 평가. 총 메인+Worker+Reviewer 토큰, 캐시, 도구 출력, 지연, 완료 품질과 재작업을 기존 Usage Receipt로 측정. 모델 입력 토큰을 단순 도구 bytes로 추정하지 않는다.

G0~G6 중 미증명이 있으면 **그 뒤 Gate의 기능을 억지로 PASS시키지 않는다**. 진행 가능한 독립 문서/계약 검증은 수행하지만 실제 Native 채택은 보류한다. 성능 채택은 기술 안전성보다 앞서지 않는다.

**Exit:** \`FINAL_ACCEPTANCE.md\`에 G0~G6·I01~I12·T01~T27 상태를 \`PASS/PARTIAL/FAIL/DEFER/NOT_RUN\`로 명시, 허용된 플랫폼/실행 모드, 현재 활성 기본값, 채택 효과와 남은 조건을 한 페이지 요약 + 상세 근거로 정리한다.

## 4. 의존성·병렬화 제한

\`\`\`text
P0 증거/사전등록
   ├── A Native OS/후손  ──┐
   ├── B FS/UID/별칭     ──┤
   ├── C Kernel 복구     ──┼── P2 통합 기술 결정
   ├── D Main/Context    ──┤         │
   └── E 플랫폼 Capability ┘         ├── 구현 가능 → P3 최소 구현
                                     └── 미증명   → HOLD_SAFE
                                               │
                                   P4 통합 보안·복구 회귀
                                               │
                                   P5 G0~G6 최종 수용/평가
\`\`\`

**직렬로 유지할 것:** 같은 Attempt의 Writer 소유권 변경, CAS/Report 정착, 같은 Run DB 접근, 같은 Git Worktree 수정, OS 프로세스 종료 증명 후 정리, 제품 채택 승인. **병렬 가능한 것:** 독립 복제소스 분석, Mac Native OS 테스트와 Linux Kernel 테스트, 독립 FS/권한 시험, 문서/원본 참조 점검.

## 5. 실행·MCP 작업 복구 계약

1. 첫 호출은 Linux \`get_work_context(cwd="/shared/moonshot-relay")\`. Mac도 **별도** \`get_work_context\`로 동일 프로젝트의 Mac task를 조회한다. 기존 활성 taskId를 재사용하고 기존 Kernel 계약 재발급 금지.
2. 실행마다 \`taskId+operationId\`를 함께 사용한다. 같은 실행 입력의 복구 재조회는 같은 ID, \`nextSeq→afterSeq\`로 전체 출력 수집. \`running/prepared/unknown\`은 새 ID로 반복하지 않는다.
3. 원본 Git HEAD·\`origin/main\`·dirty/staged/실제 테스트 중 프로세스·증거 수정 시점을 대조한다. 현재 사용자 변경이나 기존 진행 중 시험을 덮어쓰지 않는다.
4. **Git writer는 Linux main 단 하나.** Mac은 독립 Clone 검증과 읽기 전용 결과 제공. Lane별 코드 변경은 서로 다른 branch/worktree를 써도 통합 전 중복 Authority·통합 커밋 충돌을 점검한다.
5. 각 Lane에 작업 상태 \`NOT_STARTED/RUNNING/COMPLETE/DEFER/FAIL\`과 \`sourceSHA/OS/Fixture/operationId/exitCode/failures/childExitVerified/cleanupStatus\`를 최소 기록한다. 긴 로그를 문서에 복사하지 않는다.
6. 매 P-Wave 통합 경계에서만 **한국어 상세 커밋·푸시**: 변경 목적, 구체적 반례, 검증 범위와 실제 PASS/FAIL/SKIP, 불확실성, 운영 영향, 복잡도 증가·제거, 롤백. Lane별 사소한 기록마다 불필요한 커밋·상태표 중복 갱신하지 않는다.
7. 독립 검증 Lane이 완료되면 완료된 단계와 증거를 checkpoint에 갱신하고, 동일 Run/명령은 다시 실행하지 않는다. 모든 Gate 만족 또는 명시된 최종 DEFER/FAIL 정착까지 이어서 진행한다.
8. 자원 충돌/테스트 실패/모델 인증 부재는 **해당 Lane만** 차단한다. 다른 Lane은 독립 격리 조건을 유지하면 계속 진행한다. 무한 재시도 금지.

## 6. 고정된 판정 체계·중단 규칙

| 상태 | 쓰는 경우 | 이후 행동 |
| --- | --- | --- |
| \`PASS\` | 실제 해당 Host/Runtime의 필수 불변식과 실행·종료/격리 증거가 충족 | 다음 의존 Gate 진입 |
| \`PARTIAL\` | 코드/Fixture는 확인됐으나 중요한 Native 실증이 부족 | 빈 항목을 명시하고 지원되는 Lane만 계속 |
| \`DEFER\` | 명확한 Capability/권한·환경 부재. 무단 우회 불가 | 해당 기능 미도입, 필요 환경을 명시하고 통합 판정으로 합류 |
| \`FAIL\` | Owner 외부 수정, 중복 Writer, 무단 승인/취소, 원본 손실, 비밀 노출 등 위반 | 해당 Lane 즉시 중단, 증거·시험 루트 안전 보존, 원인/수정 여부 판단 |
| \`NOT_RUN\` | 의존 Gate 미충족으로 의도적 미실행 | 원인과 다음 조건을 기록, PASS/SKIP으로 위장 금지 |
| \`HOLD_SAFE\` | P2 최종 제품 안전 미승인 | 현재 예약·Worktree·Native 자동합류 차단 유지하면서 계획의 나머지 문서·최종 판정 완료 |

테스트 실패를 고치기 위해 무작정 TTL/Timeout을 확대하거나, Windows/Mac/Linux 분기·경험적 재시도·새 정책 계층을 누적하지 않는다. 반례가 *이미 신뢰 경계를 보여줬으면* 같은 부정 시험을 반복해 확률적 PASS를 수확하지 않는다.

**전체 계획의 종료 조건:** (1) A~E 결과와 P2 결정, (2) 승인된 범위의 P3/P4 테스트 또는 HOLD_SAFE, (3) G0~G6의 명시적 최종 상태, (4) 사용 계정 무변경·안전한 시험 자료 정리/보존, (5) 결과 문서·상태·체크포인트 및 통합 커밋/푸시 완료. **모든 Gate가 PASS가 아니어도 근거가 분명한 최종 HOLD_SAFE/DEFER는 실행계획 완료다.** 기능 완성과 계획상 검증 종료는 구별한다.

## 7. 산출물 최소화와 착수 메시지

기존 \`docs/public/roadmaps/host-owned-worker-context-continuity-2026-11-03\` 아래에 필요한 파일만 만든다.

- 이 파일: **고정된 단일 실행계획**. 매 검증 건마다 T50/T51 파일 생성 금지.
- \`T49_PARALLEL_EVIDENCE_MATRIX.md\`: A~E별 증거/명령/결론 및 P0~P1 결과. 필요 이상으로 Host별 독립 보고서 생성하지 않는다.
- \`T49_DECISION.md\`: P2 기술 결론과 P3 최소 변경/보류 이유.
- \`T49_FINAL_ACCEPTANCE.md\`: P4~P5 후 최종 Gate/품질/비용/운영 판정. 기존 \`STATUS.md\`, \`W0_RESULT.md\`는 **Wave 경계에서만** 링크/핵심 결과 갱신.

실제 다음 세션의 첫 요청:

> Moonremote 기존 \`/shared/moonshot-relay\` 작업부터 복구해 T49 통합 실행계획의 **P0~P1**을 진행해. Linux/Mac 체크포인트와 현재 Git 상태, 기존 증거를 대조한 뒤 A~E를 독립 Fixture로 병렬 진행해. 이미 끝난 T39~T48은 재검증 없이 참조하고, 완료된 Lane/명령을 반복하지 마. 새 Native 자동 합류·Writer 예약 해제는 하지 말고, 각 Lane의 PASS/PARTIAL/FAIL/DEFER와 통합 P2 결정을 증거 기반으로 확정해. 인증·OS capability 부재는 해당 Lane만 DEFER하고 나머지를 계속 진행해. 제품 코드는 P2 결정 전 수정하지 마.

이 프리셋의 목표는 **검증 범위를 생략하지 않으면서 중복 실행·새 절차·개별 단계 번호를 줄이고, 완수 가능한 단계는 묶어서 끝내는 것**이다.
