# W0 T25 — Canonical Kernel Attempt와 Host-owned Native Writable 실행 통합

- 검증일: **2026-11-04**
- 구현 기준: `main / 478998a96563cddc0aa97e63b7f5beb3dfe8e889`
- 판정: **선택적 Host-owned Writable Attempt 단일 실행 경계, 기존 Kernel State Store 및 모의 Native App Server 통합 PASS**. 실제 Codex 모델/OS 자식·후손 종료, Kernel Report·Owner Delivery, 기본 Dispatcher 자동 전환은 미검증·미구현. **G0 PARTIAL / W1 DEFER** 유지.

## 1. 무엇을 연결했는가

`src/host/kernel/host-owned-writable-attempt.ts`에 `runHostOwnedWritableAttempt`를 추가했다. 이번 구현은 기존 모듈을 조합하는 **명시적 Host 진입 함수**이지, 새로운 Kernel·DB·Queue·Scheduler·Provider 폴백이 아니다.

1. 실제 `controlPlane.getRun` 및 `getAttemptById`에서 상태 `active` Run과 `started` Attempt를 확인한다. Kernel이 발급하지 않은 Run·Step·Attempt ID, 다른 Owner 저장소, Owner 내부 예약 경로, 실행 기준 커밋 불일치는 거부한다.
2. 앞선 [Attempt별 물리 Worktree](W0_T25_ATTEMPT_ISOLATED_WORKTREE_2026-11-03.md) 준비 함수를 호출한다. Run·Step가 같아도 새 Attempt는 다른 물리 Git Worktree를 사용한다. 기존 일반 병렬 Run 정리와는 별도이다.
3. 기존 `registerExecutionWorkspace`로 실제 실행 Workspace를 등록하고, 기존 `updateStepAttempt`의 불변 필드 규칙에 따라 Canonical Attempt에 Workspace ID와 기준 Workspace Identity를 처음 결합한다. 이미 다른 Workspace에 결합된 Attempt는 거부한다. State Store를 다시 읽어 결합 상태를 확인한다.
4. Host-owned Codex App Server를 해당 Worktree에서 실행한다. Turn 전 Run·Attempt 상태 및 Workspace 소유권을 다시 검사한다.
5. 앞선 [Host 외부 Writer 예약](W0_T25_EXTERNAL_WRITER_ADMISSION_2026-11-03.md)을 Native `thread/start`·`turn/start`보다 먼저 적용한다. 동일 물리 Workspace의 재할당은 예약 존재로 차단하고, 신규 Attempt의 별도 Workspace는 각각 허용한다. 기존 `workspace-write`/`workspaceWrite` 정책을 사용한다.
6. 기존 `bindNativeCommandEvent`에서 검증한 명령 식별자만 Host에 전달한다. 출력 결과에는 `nativeTurn` 상태, Canonical Attempt/Workspace ID, 명령 관측값을 구분해 보존한다. **`writerExitVerified=false`, `reportAuthority='none'`**으로 반환한다.
7. 연결 종료 시 이 함수가 직접 생성한 App Server만 닫는다. **Turn 완료·App Server 종료를 OS Writer/후손 종료, Kernel Report 승인, Owner CAS Delivery로 승격하지 않는다.**

이 함수는 제품의 기본 `spawn_agent` / Codex Adapter / Parallel Dispatcher를 교체하지 않는다. 기본 실행기는 기존대로 동작한다. 실제 실행 경로로 전환하려면 Native Worker Outcome·Report/Proof 검증·Owner Delivery를 기존 Kernel 절차와 연결해야 한다.

## 2. 격리 실행 검증

Linux MCP의 임시 Git Owner 저장소와 실제 `createKernelControlPlane`에서 Run 및 Attempt A를 만들었다. 운영 DB나 사용자 Codex 계정을 사용하지 않았다. 선택형 실행 함수는 **모의 App Server의 실제 JSON-RPC stdio 프로세스**에서 명령 시작/완료 이벤트를 받았다.

| 검증 | 결과 |
| --- | --- |
| 실제 Kernel Run·Attempt A → 실행 Worktree 등록·불변 Workspace ID 정착 | PASS |
| Native 명령 started/completed 식별자와 Canonical Attempt/Workspace 일치 | PASS |
| Native Turn completed 뒤 Kernel Attempt `started` 유지 | PASS |
| Writer 종료 `false`와 Report 권위 `none` 유지 | PASS |
| Owner 저장소가 Writer 결과로 변경되지 않음 | PASS |
| 동일 Attempt 다시 실행 시 기존 Worktree 오염·단일 예약으로 재시작 차단 | PASS |
| 다른 Owner 경로·Owner 내부 예약 디렉터리 거부 | PASS |
| Kernel에서 A Attempt 실패 후 재실행 거부 | PASS |
| 같은 Run·Step에서 새 Canonical Attempt B → 별도 실행 Worktree와 Workspace ID | PASS |
| 새 B 실행 후 A 결과·실패 상태 보존 | PASS |
| TypeScript 및 Runtime/테스트 빌드 | PASS |
| 집중 시험 | **23/23 PASS** |
| Native Transport·Writer·Parallel Fencing/Recovery·Dispatcher·Workspace Lock·Codex Adapter 관련 확장 | **86/86 PASS** |
| `check:boundaries` | PASS — 9 modules / 311 files / 849 dependency edges |

- 첫 격리 테스트: Linux MCP `operationId=4828cdad-6586-4b55-bbf2-cc8cc086f0a1`, 23/23 PASS.
- 추가한 **Turn 직전 상태 재검사** 및 확장 검증: `operationId=7ea2f7a7-9ba2-43c0-95a8-9020c2cb6a51`, 86/86 PASS, 모듈 경계 PASS.
- `git archive HEAD` 및 변경 소스/테스트를 임시 `/tmp` 환경에 복사하여 개발 의존성·빌드·테스트를 실행했다. 원본 계정 도구 설치·Node 모듈·운영 Runtime/DB·사용자 Codex 세션은 변경하지 않았다.

## 3. 제한·다음 단계

**이 검증은 실제 Kernel + 모의 Native App Server의 종단 간 통합이다.** 실제 Mac Codex 모델에서 동일 Helper를 실행하고 OS Worker·후손의 종료를 확인한 결과가 아니다.

- 새로운 Attempt B가 다른 물리 Worktree를 쓰더라도 **동시 Worker 허가·재시도 정책·최종 결과 채택**은 기존 Kernel 단계가 판단해야 한다. 물리 격리를 보고 B를 무조건 승인하지 않는다.
- Model Turn 완료는 Worker Outcome/Proof/Report가 아니다. **Kernel Report·Owner CAS 단일 Delivery 연결은 이번 변경에 없다.** 기존 병렬 Dispatcher의 결과 검증·소유권 검사를 우회하지 않는다.
- Worker가 Host 예약 디렉터리에 접근할 수 있는 동일 UID 비격리 실행, OS 샌드박스 경계, Writer/자식·후손 종료, 안전 폐기 및 디스크 회수는 해결되지 않았다.
- Host 중단·연결 상실·unknown 중복 spawn 방지, 운영 Native 실행기 경로 강제 적용, Mac 단일 호스트 실제 E2E, Windows Job Object·다른 OS 머신/공유 파일시스템은 남는다.
- 이번 기능을 기본 실행기에 무조건 추가하면 안전 폐기나 재시도에 불필요한 중단이 생길 수 있다. 수용 조건이 확인되기 전에는 **Opt-in**을 유지한다.

**G0 = PARTIAL / W1 = DEFER.**
