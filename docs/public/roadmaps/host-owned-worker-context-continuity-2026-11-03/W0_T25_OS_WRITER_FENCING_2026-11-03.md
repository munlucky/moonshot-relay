# W0 T25 — 실제 Codex OS Writer의 Turn 취소 후 Late Write 반례

- 검증일: 2026-11-03 (KST)
- 기준 Git: `main / 324736f946a24b4c17cb79f44ca6c3c55898da83`
- 환경: Mac Native, Codex CLI `0.162.1`, **W0 전용 ChatGPT 인증** 및 `CODEX_HOME`, 격리 임시 Workspace, 격리 App Server Unix WebSocket
- 실제 모델 Turn: **1회**. `sandbox=workspace-write`, `approvalPolicy=never`, 수정 가능 대상은 임시 Workspace 내 Heartbeat fixture뿐
- 결과: **T25의 interrupt-only Writer 종료 가정 FAIL**. OS 프로세스 그룹을 식별할 수 있는 제한된 환경에서는 명시적 그룹 종료 + 정착 확인 후 B Writer 허용이 성공
- 통합 판정: **G0 PARTIAL / W1 DEFER**. 실제 Moonshot Relay Host·Kernel 제어 경계의 OS Writer fencing 기능은 미구현·미검증
- 참고: [W0 수명·연결 시험](W0_INFLIGHT_CONNECTION_LIFECYCLE_2026-11-03.md) · [Code Map](W0_CODE_MAP.md) · [검증 계약](VERIFICATION.md)

## 1. Native Codex 실제 자식 프로세스와 취소 실험

실험 Workspace에 `heartbeat.py`를 사전 생성했다. 0.2초마다 `heartbeat.log`에 `A:<counter>`를 append/fsync하며 최장 18초만 실행하는 자기 종료형 fixture다. `heartbeat.pid`에 실제 OS PID를 기록한다. 저장소/사용자 파일은 수정하지 않는다.

Codex에 오직 `python3 heartbeat.py` 실행을 요청했다. Turn을 시작한 App Server WebSocket은 **Host 역할로 유지**하고, 별도 WebSocket 클라이언트에서 실행 중 Thread를 읽고 `turn/interrupt`를 보냈다.

| 관측 | 결과 |
| --- | --- |
| `thread/start` 및 `turn/start` | 성공, Turn 상태 `inProgress` |
| Codex tool OS 프로세스 생성 | **PASS**. 실제 Python `heartbeat.py` 실행 및 `pid` 파일·heartbeat 생성 |
| PID, PPID, PGID | **PID=22813, PPID=22671, PGID=22813** (`ps` 관측). 실험 당시 값으로 재사용 금지 |
| 중단 전 Heartbeat | 4개 |
| 별도 클라이언트의 `thread/read` | 성공, `inProgress` |
| `turn/interrupt` | RPC `result` 성공 |
| 중단 직후 1.8초 후 | **Heartbeat 4→13개, 추가 쓰기 9회** |
| 중단 후 Python OS 프로세스 | `ps`에서 **여전히 살아 있음** |
| 다음 0.9초 동안 쓰기 정착 | **실패**. 계속 추가 append 관측 |
| 자식 정리 | 해당 fixture `heartbeat.py`로 확인한 PID를 별도로 종료. 격리 App Server도 종료 |
| 청소 증거 | PID 22813 부재, 시험용 `heartbeat.py`/App Server 및 `/tmp/mr-w0-t25-*` 잔존 0개 |

**관찰과 해석을 분리:** 이 시험에서 `turn/interrupt`는 실제 OS 도구 자식 프로세스의 정지·쓰기 차단을 보장하지 못했다. **다음 Worker B는 실행하지 않았으므로 실제 A/B 이중 Writer 동시 실행은 발생하지 않았다.** 그러나 A가 계속 쓰는 상황에서 Lease/CAS 교체만으로 B를 허가한다면 위험하다는 반례가 입증됐다. 이번 증거로 "모든 Codex 버전에서 `turn/interrupt`가 자식 프로세스를 절대 종료하지 않는다"고 일반화하지 않는다.

**영수증:** Mac Native `operationId=9c7d52d8-c01c-4c70-929d-de77ca378da9`, 후속 잔존 확인 `d4393965-6ac4-495e-8a12-2c585c915999`.

## 2. OS 프로세스 그룹 물리 차단 시험 (독립 fixture, 모델 호출 0회)

실제 Codex가 아닌 **독립 OS fixture**로 별도 임시 Workspace에서 Python Writer A를 전용 process group으로 실행했다. 이 시험은 Host가 실제로 그 그룹을 독점 소유·검증할 때의 물리 중단 **가능성**만 확인한다.

| 관측 | 결과 |
| --- | --- |
| Writer PID/PGID | `24044 / 24044` (실험 값) |
| PID·process group provenance | `start_new_session=True`로 격리된 child만 시작 |
| Writer 초기 append | 4개 |
| 전용 process group에 `SIGTERM` | child 종료 코드 `-15` |
| 프로세스 종료 확인 직후 append 개수 | 4개 |
| 추가 700ms 관찰 | **추가 쓰기 0개** |
| 종료 확인 뒤 Writer B의 단일 append | `B:only` |
| B 후 관찰 | 마지막 엔트리 `B:only`, A 후속 append 없음 |
| 격리 데이터/프로세스 정리 | 완료 |

**PASS 범위:** 전용 OS Writer 그룹의 **정확한 소유권**을 알고, 종료 완료를 기다린 다음 B를 허용한 단순 fixture. **미검증:** Codex tool의 프로세스 그룹과 모든 후손 프로세스를 Host가 안전하게 알아내고 통제 가능한지, OS PID 재사용·분리된 후손·정지 불가능한 프로세스·Windows Job Object·파일 시스템 지연이 발생하는 실제 상황.

**영수증:** Mac Native `operationId=7e19527a-b024-4815-a3ca-78b9637a8e29`.

## 3. 실제 소스와 연결한 최소 수정 후보 (아직 구현하지 않음)

| 기존 경계 | 실제 현재 책임 | 필요한 보완 조건 |
| --- | --- | --- |
| `src/host/kernel/process-observation.ts` | `process.kill(pid, 0)`로 프로세스 존재 관측 | 실제 관리하는 Worker/child의 PID·process group 귀속을 식별하고, 종료를 **입증할 수 있는 통제 경계**가 있는지 검증. 단순 PID alive는 fence 아님 |
| `src/host/kernel/adapters/codex.ts` | `spawn_agent` 결과를 기다리는 Native model wrapper | Turn 종료 이벤트와 OS command 종료 상태를 구별. `turn/interrupt` RPC를 OS 후손 프로세스 완료 영수증으로 사용 금지 |
| `src/host/kernel/parallel-dispatcher.ts` | Delivery `git apply`에 Lease 기반 deadline과 `SIGTERM`. Owner mutation CAS/Lock | **기존 Delivery 한정 방어는 유지**. 이를 전체 Codex command의 Writer 중단 증명으로 확장 주장하지 않음 |
| `src/kernel/persistence/work-attempt-store.ts` / `src/kernel/run/agent-recovery.ts` | Run/Step/Attempt/Receipt 복구 | 같은 mutation scope가 `running/unknown`이면 **실제 Writer 종료·격리 증거 + 결과 reconcile** 전 새 Attempt/Writer를 허가하지 않는 Gate 필요 |

**실행 설계 원칙:** 요청한 `cancel`과 확인된 `terminated`/`fenced`를 별개 상태로 다룬다. 실제로 관리·소유하지 않는 사용자/IDE/다른 Codex 프로세스의 OS PID를 일괄 kill하지 않는다. PID/PGID 단순 문자열 저장, 새 DB Table/Queue, 특정 Provider 버전 하드코딩 및 임의 owner-direct fallback으로 해결하지 않는다.

### W1 이전에 필요한 추가 반례

1. Codex 실제 도구 command의 **provenance**: Host가 획득한 OS child/session/process group과 격리 Workspace·Kernel Attempt의 일관된 매핑.
2. Host가 해당 프로세스 그룹을 **소유할 때만** SIGTERM → 대기 → 필요시 범위가 검증된 SIGKILL → 실제 프로세스/후손 종료를 증명.
3. 중단 전후 Heartbeat/file digest·Workspace revision을 비교하고, 계속 쓰는 Writer가 있거나 관측 불가능하면 **B spawn 차단**.
4. 중단된 Command의 `operationId`와 결과/terminal event가 **unknown**일 때 중복 실행 없이 같은 Attempt를 재조회.
5. Unix process group 가정이 통하지 않는 Windows Native/Job Object 경로를 **실제 Windows executor 복구 후** 별도로 검증.
6. `thread/read`는 Native 기록 증거, Kernel Work/Trust/Evidence만 완료 권위임을 유지. 별도 Worker Completion Authority를 만들지 않는다.

## 4. Gate 판정

- **T25 interrupt-only OS Writer 중단:** **FAIL** (실제 Codex child가 1.8초 뒤에도 9회 추가 기록)
- **T25 전용 process group 물리 중단 fixture:** **PASS — OS fixture 한정**
- **I03 실제 Kernel 단일 Writer 위반:** **NOT TESTED** (B를 실행하지 않았음)
- **I04 unknown 중복 command:** **NOT TESTED**
- **G0:** **PARTIAL**, 필수 OS Writer 제어 미수용. **W1 구현은 DEFER**
- **운영 리스크:** 새 Worker가 이전 Writer의 종료 증거 없이 같은 Workspace를 수정하도록 허가하는 설계는 금지

이번 Wave에서는 **문서 검증과 위험 판정만 정착**한다. 실제 Kernel/Host 제품 코드는 바꾸지 않는다. 기존 T23 수정·Source runtime 테스트는 반복하지 않는다.
