# W0 Native in-flight 연결 수명 · 중단 · 재시작 이력 검증

- 작성: 2026-11-03 (KST)
- 코드 기준: `main / 5c71d59608c1eb8ee7fb5bf227c184427a692f45` (검증 시작 전)
- 시험 환경: macOS Native Codex CLI `0.162.1`, W0 전용 인증 `CODEX_HOME`, 임시 Unix WebSocket App Server 및 Workspace
- 실행 범위: **실제 모델 Turn 2회 이내**, 모든 요청 `sandbox=read-only` / `approvalPolicy=never`, 격리 임시 Workspace 사용. 실제 사용자 계정 Codex App/DB/운영 작업 중단 없음.
- 최종: **Host 연결 유지 조건의 in-flight Turn 재조회·다른 연결에서 중단 동작 확인. G0 전체 PARTIAL / W1 제품 코드 DEFER.**
- 기반: [계획](PLAN.md) · [안전·검증 기준](VERIFICATION.md) · [인증 및 첫 Turn](W0_AUTH_TURN_RESULT_2026-11-03.md) · [상태](STATUS.md)

## 1. 관측한 세 가지 수명

| 단계 | 실행 및 직접 관측 | 판정 |
| --- | --- | --- |
| **A: Turn을 시작한 WebSocket 종료** | `turn/start` ACK 직후 `status=inProgress`. 첫 연결 종료 후 App Server 프로세스는 생존. 두 번째 연결의 `thread/read(includeTurns=true)`에서 같은 Thread의 Turn 상태가 **`interrupted`** | **해당 직접 연결 방식의 Turn 생존 실패 관측** |
| A의 후속 interrupt | 두 번째 연결에서 `turn/interrupt` RPC는 `result` 응답. 그러나 이 요청 **전에 이미 `interrupted`**였음 | 중단 RPC 처리 관측 / 실제 중단의 인과 **NOT VERIFIED** |
| **B: 시작 WebSocket(Host 역할) 유지** | 실제 Turn 시작 `inProgress`; 다른 WebSocket 클라이언트 연결 후 종료. **원래 시작 연결 유지**, 세 번째 WebSocket 연결에서 같은 Thread의 `turn.status=inProgress`를 재조회 | **비소유 연결 종료 후 진행 상태 재조회 PASS** |
| B의 원격 interrupt | 원래 시작 연결이 살아 있는 상태에서 세 번째 연결의 `turn/interrupt` RPC 성공. 후속 `thread/read(includeTurns=true)`의 Turn 상태 **`interrupted`** | **다른 연결에서 실행 중 Turn 중단 PASS (시험 범위)** |
| **C: App Server 프로세스 완전 재시작 후 read** | 이전 임시 App Server를 모두 종료하고 W0 전용 `CODEX_HOME`으로 새 App Server 기동. `thread/list` 성공(3개 Thread), `thread/read(includeTurns=true)`로 중단된 Turn 이력 조회 성공 | **재시작 후 영속 기록 조회 PASS** |
| C의 진행 중 command 재개 | 재시작 후 `turn/start` 재수행, 중간 command 재개·PID 보존 시험 없음 | **NOT TESTED** |

**B의 한계:** 두 번째 연결에서 첫 `thread/read` 요청은 결과가 없었고, 해당 오류 정보는 충분히 기록하지 못했다. **세 번째 연결의 후속 `thread/read`는 실제 성공**했으므로 "모든 연결·조회가 항상 성공한다"는 뜻이 아니다. App Server 메모리 상태와 실제 파일·OS command writer 상태는 별개다.

## 2. 무엇을 보장하지 않는가

- A는 **App Server WebSocket 클라이언트** 연결 해제 실험이지 ChatGPT Main 세션 자체를 종료한 시험이 아니다. "Codex의 모든 버전은 연결이 끊어지면 Turn을 중단한다"고 일반화하지 않는다.
- B는 **Host 역할 연결을 유지한 상태에서 다른 클라이언트 연결을 해제**한 모의 제어 실험이다. 실제 Moonshot Relay Host의 런타임 수명과 MCP 호출 분리 구현 또는 사용자 Main 종료 이후 테스트는 아니다.
- B의 입력에는 읽기 전용 `sleep 12` 명령 실행 요청이 있었지만 실제 `sleep` 프로세스가 생성·지속 실행됐다는 **OS PID·tool receipt를 확보하지 못했다**. 그러므로 T25의 old Writer 종료·이중 쓰기 금지는 아직 검증되지 않았다.
- A/B의 `turn/interrupt` 응답은 App Server **Turn-level 취소**의 근거이지 모든 후손 OS 프로세스·파일 변경의 물리 차단 근거가 아니다.
- C의 재시작 후 `thread/read` 성공은 **영속된 기록 조회**다. 진행 중 Turn/OS command/토큰 스트림의 복구가 아니다.
- 모델의 실제 입력·출력 token 및 청구 비용은 계측하지 않았다. W6 절감률을 임의로 주장하지 않는다.
- Windows Native의 `persistence_unavailable`/heartbeat stale은 같은 날 재현되어 동일 기능 교차 검증 불가.
- T24 Codex Goals와 Host Dispatcher의 실제 자동 실행 중복 및 T26 Host/App Server 종료 후 in-flight 실행 수명은 여전히 독립 검증 필요.

## 3. W1에 주는 구조적 의미

**실측된 최단 경로:** 기존 `src/host/kernel/adapters/codex.ts`의 동기 `spawn_agent → waitForOutcome`를 무조건 새 Scheduler/DB로 감싸지 말고, 실제 Native App Server **Host 소유 연결을 Main 연결과 구분**하는 최소 실행 경계부터 검토한다.

실험 B가 보여준 것은 **시작 연결을 Host가 유지하면 외부 클라이언트의 연결 교체 중에도 동일 Turn을 조회하고 다른 연결에서 interrupt할 수 있다는 것**이다. 따라서 Main 연결이 끊어지더라도 Worker 실행 연결을 독립 Host가 유지하도록 하는 방향은 시험 가능하다.

다만 제품 적용은 다음 Gate가 필수다.

1. **W1 진입 확인:** Host-owned 연결이 실제 사용자 Main/MCP 종료와 독립 생존하는지, 다른 Main에서 Run/Attempt/Thread를 중복 spawn 없이 조회하는지.
2. **Writer 보호:** 실제 Codex 도구 명령의 OS PID·process group·Workspace Revision 관측. 이전 Writer 종료/격리 후에만 새로운 Writer를 허가한다. `Lease/CAS`만으로 보호됐다고 판정하지 않는다.
3. **실행 중 오류:** WebSocket 연결이 끊어지면 Turn이 `interrupted` 또는 `unknown`일 수 있다. `Kernel report`를 성공으로 가정하거나 새 operation ID로 무조건 재실행하지 않고, 기존 Attempt/Receipt와 원본 rollout을 조회한다.
4. **과잉 설계 방지:** DB·Job Queue·Model Proxy·Provider 버전별 임시 fallback·새 Completion Authority 추가 없음. `Kernel Work/Trust/Knowledge` 권위를 유지하고 기존 Host Dispatcher/Control Plane을 우선 재사용한다.
5. **교차 검증:** Windows Native executor 연결 복구 시 같은 연결 소유권·Turn-level interrupt·OS Writer 차단을 동일 조건으로 시험한다.

**G0 통합 판정은 PARTIAL 그대로다.** Connection-level 기술 후보는 좁혀졌지만 I03/I04/I09/I10/T25/T26의 실제 사용자 Main·Host 연결과 물리 Writer 제어는 통과하지 않았다. W1 제품 코드 구현은 이번 Wave에서 시작하지 않는다.

## 4. 재현·검증 영수증

| 실험 | Mac Native tracked operationId | 실행 결과 |
| --- | --- | --- |
| A: 시작 연결 종료 | `a82b5aec-d8dc-409f-8e9c-62a2369e80da` | exit 0, ACK `inProgress` → 새 연결에서 `interrupted` |
| B: Host 연결 유지·원격 interrupt | `9b1c96f7-e77c-4f28-b7d8-60352bd505bf` | exit 0, 세 번째 연결에서 `inProgress` → interrupt → `interrupted` |
| C: 새 App Server에서 persisted Thread 조회 | `f489cdcf-2fdc-45aa-a5a0-f76e260fdc50` | exit 0, `thread/list` 3개·이력 조회 성공 |
| Windows Native 연결 재조회 | `f8c0583e-a6f9-429c-b2a9-fdcd5ef037dc` | pre-spawn `persistence_unavailable` |

모든 시도는 W0 전용 Codex 인증을 재사용했으며, 인증 파일 내용·토큰·기기 코드를 출력하지 않았다. 각 임시 App Server는 종료하고 관련 임시 Workspace를 삭제했다. 실제 사용자의 Codex 운영 프로세스를 종료하지 않았다.

## 5. 외부 설계 문서와의 구분

공식 [Codex App Server 문서](https://learn.chatgpt.com/docs/app-server)에는 Thread/Turn 제어·완료 알림 및 복구 API가 기술되어 있다. 공개 [Codex 이슈 #40306](https://github.com/openai/codex/issues/40306)에는 특정 버전/전송 조건에서 클라이언트 해제 중 in-flight exec가 정착하지 못한 사례가 보고됐다. 이는 참고 자료일 뿐, **이번 Mac Codex 0.162.1의 원인을 같은 이슈로 단정하거나 버전 간 동작을 일반화하지 않는다**.
