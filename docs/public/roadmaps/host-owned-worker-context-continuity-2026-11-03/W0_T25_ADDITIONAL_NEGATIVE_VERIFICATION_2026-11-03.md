# W0 T25 추가 검증 — 실제 Writer의 잠금 만료와 격리 Worktree

- 일자: 2026-11-03 (KST)
- 조사 대상: `main / 9d875dc1e43ea98f1f02c4cb87e1de19b9534040` (시험 시작 전)
- 실행 원칙: **일반 코드 조사·격리 실행·문서는 Moonremote MCP**. 실제 Codex 모델 Turn만 W0 전용 Mac Native `CODEX_HOME`에서 시험
- 범위: 기존 W0-T25b/c의 **Owner Workspace 재할당 및 Native 연결 종료 보완 실험**. 제품 소스·운영 Runtime·사용자 Codex 세션·실제 프로젝트 파일 무변경
- **최종 판정: Workspace Lock/Lease는 물리 Writer 종료를 보장하지 않는다(PASS 반례). 격리 Worktree는 직접 쓰기 격리에 유효하다(격리 fixture PASS). 실제 Native 연결 해제 중 Handle 회수 실험은 INCONCLUSIVE. G0 PARTIAL/W1 DEFER 유지.**

## 1. 동일 Workspace: 기존 Lock 만료 중 실제 A Writer가 계속 쓰는가?

MCP Linux 임시 Runtime에 Workspace, Run, Step, `status=started` Attempt를 만든 뒤, 세션 A가 짧은 TTL Lock을 획득했다. **별도 OS process group의 Python Writer A**가 같은 Workspace 안의 `shared.log`를 반복 append/fsync했다. Lock 만료 후 다른 세션 B가 **같은 Workspace·Run**에 Lock을 재획득했다. 실험 종료 때 OS Writer A를 중단하고 임시 Runtime/Workspace를 삭제했다.

| 관측 항목 | 실제 결과 |
| --- | --- |
| A 최초 잠금 획득 | `true` |
| A 최초 쓰기 | 4회 |
| B가 같은 Workspace Lock 획득 | **`true`** (A의 TTL 만료 후) |
| B 획득 당시 A OS Writer | **살아 있음** |
| 기존 Work Attempt | **`started` 유지** |
| fencing token 증가 | `true` |
| B 획득 당시 A 누적 기록 | 11회 |
| B 획득 이후 A 누적 기록 | 16회 (**추가 5회**) |
| A가 이전 fencing token으로 Lock 해제 | `workspace_lock_handoff_failed`로 **거절** |
| B의 실제 파일 변경 | **실행하지 않음** |

**해석:** 새 fencing token은 이전 소유자의 Kernel 작업과 Lock Release를 차단하지만, 실제 OS Writer의 디스크 append를 차단하지 않는다. **B까지 파일을 써서 데이터 손상이 발생했다는 결과가 아니다.** 본 반례는 정상 만료 재획득 API와 실물 프로세스를 결합하여, 기존 Attempt 상태와 물리 Writer 생존이 분리된다는 사실을 직접 확인한 것이다. `Lock reacquired`만으로 `writer terminated`를 인정하지 않는다.

- MCP tracked `operationId=f69b52ab-a3a6-42a3-a0f6-a6a5747d54de`, exit 0, 임시 Runtime/Workspace 및 전용 Writer process 정리
- 기완료 Lock 테스트 `12/12` PASS는 재실행하지 않았으며 [이전 보고서](W0_T25_NATIVE_OWNER_ATTEMPT_FOLLOWUP_2026-11-03.md)의 의미와 충돌하지 않는다.

## 2. 서로 다른 Worktree: A가 살아 있어도 Owner 파일이 안전한가?

MCP Linux 임시 Git 저장소에 Owner, Worker A, Worker B의 **서로 다른 물리 Worktree 3개**를 구성했다. A가 자기 Worktree의 `shared.txt`에 계속 append하는 동안 B가 별도 Worktree에서 `B:only`를 커밋했다. Owner에는 B의 커밋을 `git cherry-pick`으로 반영했다.

| 관측 항목 | 결과 |
| --- | --- |
| 세 Workspace canonical root | 서로 다름 |
| Owner로 B Delivery 중 A 프로세스 | **실행 중** |
| A의 별도 Worktree 기록 | 5 → 13회 |
| Owner 파일 내용 | **`B:only` 유지** |
| Owner HEAD | B Delivery 후 기준 HEAD에서 변경됨 |
| 기존 A 기준 HEAD를 새 Owner HEAD와 대조 | **불일치** |
| A가 Owner를 직접 수정 | **없음** |
| A·B 작업 자료와 임시 프로세스 | 삭제/종료 |

**해석:** 이 실험에서 분리된 파일 경로 덕분에 A의 후속 쓰기가 Owner의 B Delivery 결과를 덮지 않았다. **기존 Kernel의 CAS 검사 함수를 직접 호출한 실험은 아니다.** 이전 A 기준 HEAD가 현재 Owner HEAD와 달라졌다는 관측만 수행했다. 따라서 "Kernel이 실제 stale A Delivery를 거부했다"는 PASS를 주장하지 않는다. 이 fixture의 안전성은 **A가 처음부터 Owner Checkout에 직접 쓸 수 없었음**에 의존한다.

- MCP tracked `operationId=6b7cd7c7-3efa-4183-ab3d-a4452deae693`, exit 0, 임시 Worktree·프로세스 정리

## 3. Native 연결 끊김/핸들 회수: 이번 시험 결과

별도 인증된 Mac Native `codex-cli 0.162.1` App Server에서 `turn/start` ACK `inProgress`를 받은 뒤, 임시 Python Writer가 실행되기를 관찰했다. 그러나 **이번 단일 실제 모델 Turn에서는 제한 시간 안에 writer PID, 파일 기록, 명령 시작 이벤트를 관측하지 못했다.** 따라서 실제 실행 중인 Writer를 대상으로 원본 WebSocket을 종료하거나 새 연결에서 `backgroundTerminals/list`·`terminate`를 시험하지 않았다. 격리 App Server·Workspace는 종료/삭제했고 Provider `401`은 관측되지 않았다.

| 항목 | 결과 |
| --- | --- |
| 실제 모델 Turn `turn/start` ACK | `inProgress` |
| Writer OS PID 및 파일 기록 | **미관측** |
| `commandExecution item/started` | **미관측** |
| 실행 중 Writer의 Host 연결 해제 | **NOT TESTED** |
| 새 WebSocket에서 Handle 복구·Terminate | **NOT TESTED** |
| 시험 App Server/임시 Workspace 정리 | PASS |

**해석:** 한 번의 실행에서 모델 도구가 시작되지 않은 것은 실제 도구 핸들 복구의 실패 반례가 아니다. 기존 [T25 Native 소유권 시험](W0_T25_NATIVE_OWNER_ATTEMPT_FOLLOWUP_2026-11-03.md)에서 확인한 `itemId/processId`와 `backgroundTerminals/terminate` 성공은 그대로 보존한다. **이번 시험만으로 연결 종료 후의 handle 재조회 가능성이나 old Writer 물리 중단을 판단하지 않는다.** 재시도/새 모델 요청을 자동 실행하지 않았다.

- Mac tracked `operationId=e9c91aa1-3974-4fda-b67b-976d485d2ae3`, exit 0, Writer 미생성
- 인증 토큰·기기 코드·사용자 설치 Codex 데이터는 출력·복사하지 않았다.

## 4. 작업 분리 원칙과 다음 검증 기준

검증 결과는 **동일 Workspace 재할당**과 **새 격리 Worktree 준비**를 다르게 판단해야 함을 보여준다.

1. **동일 Workspace**: A의 실제 Writer가 살아 있는지 불명확하거나 종료 증거가 없다면 B의 변경을 허용하지 않는다. Lock TTL 만료·fencing token 증가·`turn/interrupt`·단일 Terminal 종료 RPC만으로 물리 Writer 종료를 대체하지 않는다.
2. **처음부터 물리적으로 분리된 Worker**: A/B가 Owner Checkout에 직접 쓸 권한이 없으면 A가 살아 있어도 B의 별도 Worktree 준비는 가능하다. 다만 Owner에 적용할 때에는 **기존 Delivery CAS/Lock, 실제 Mutation Revision, Writer 권한**을 검증한다. A가 Owner Checkout에서 이미 작업했다면 별도 B Worktree의 존재만으로 안전을 보장하지 못한다.
3. **Native Handle 소유**: 실제 App Server `threadId/turnId/itemId/processId`와 기존 Kernel `attemptId/workspaceId`를 일관되게 결합하는 Host Runtime 경계가 아직 없다. `osPid=null`, 명령 미관측, Host 연결 상실 시에는 **동일 Workspace Writer 종료를 확인할 수 없음**으로 처리한다. 개별 조건용 DB·fallback·무조건 PID kill을 추가하지 않는다.
4. **다음 실제 통합 테스트**: Attempt→Native commandExecution 연결, Host 수명/재연결, 승인·interrupt·Background Terminal terminate의 구분, 실제 프로세스/후손 종료 증거, 잔여 A Writer 상태에서 **동일 Workspace B의 실행 거부** 및 별도 Worktree B의 **승인된 Delivery 1회**를 대조한다. 마지막은 현재 작업에서 PASS로 올리지 않는다.
5. **Host 교차 검증**: Windows Native executor heartbeat `persistence_unavailable` 해결 뒤 실제 child/Job Object 수명 확인. Windows 기능 실패로 단정하지 않는다.

**결론:** T25는 Kernel의 Lease 규칙을 누적하는 작업으로 해결되지 않는다. **Host 소유 실행·실제 process 종료 관측·물리 Workspace 격리**의 기존 경계를 정밀하게 연결해야 한다. G0 통합 `PARTIAL`, W1 제품 코드 `DEFER`. 이번 실험은 검증과 문서 갱신만 수행했다.
