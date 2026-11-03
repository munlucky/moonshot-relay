# W0 격리 인증 및 실제 Codex Turn 검증 결과

- 날짜: 2026-11-03 (KST)
- 실행 Host: **Mac Native**, Codex CLI `0.162.1`
- 코드 기준: `main / da2f3bf7c30afe29bb859de7580836aedaa23ad4` (시험 전)
- 범위: 기존 사용자 인증을 건드리지 않은 **W0 전용 CODEX_HOME 인증 + 1개 실제 모델 Turn의 완료와 완료 후 연결 교체 조회**
- **판정:** 격리 인증 PASS, 기본 Turn 실행·완료 PASS, 완료 후 Thread 이력 조회 PASS. **G0 통합 PARTIAL**, W1 DEFER.
- 상세 근거: [Native 후속](W0_NATIVE_FOLLOWUP_2026-11-03.md) · [기존 G0 결과](W0_RESULT.md) · [검증 계약](VERIFICATION.md)

## 격리 인증

`~/.local/state/moonshot-relay/w0-codex-auth/` 아래 `home`, `codex`, `workspace` 디렉터리를 분리해 `0700`으로 생성했다. 기본 사용자 Codex 인증을 복제하지 않았다. 실제 `codex login --device-auth`를 해당 `CODEX_HOME`에서 실행하고 사용자가 브라우저에서 직접 인증을 승인했다.

| 확인 | 관측 |
| --- | --- |
| 기존 device-auth 작업 | 원래 `operationId=6a3457df-a3e7-4ef2-aebd-2c34470d8b2c` 종료 코드 `0` |
| 격리 CLI 로그인 | `CODEX_HOME=<W0>/codex HOME=<W0>/home codex login status` → `Logged in using ChatGPT`, exit 0 |
| 원래 Mac 사용자 CLI 로그인 | 별도 `codex login status` → `Logged in using ChatGPT`, exit 0 |
| 격리 인증 저장소 | `auth.json` 존재만 확인, 내용·토큰·키를 읽거나 출력하지 않음; 디렉터리 `0700` |
| 기존 운영 계정 변경 | 로그인/세션/DB/앱 서버의 자동 종료·재로그인·인증 파일 복제 없음 |

이 인증은 **W0 전용 테스트 환경**에 보관된다. 인증 토큰이나 기기 코드는 프로젝트 저장소·로그·체크포인트에 기록하지 않았다.

## 최소 실제 Turn 1회

새 임시 Workspace 및 Unix WebSocket App Server를 생성했다. `CODEX_HOME`과 `HOME`은 위 W0 전용 인증으로 고정하고, 관련 API 키 환경변수는 전달하지 않았다. `thread/start`는 `sandbox=read-only`, `approvalPolicy=never`, `ephemeral=false`로 수행했다.

`turn/start`에 **짧은 고정 응답만 요청하며 도구 사용·파일 접근을 금지하는** 텍스트 입력 1개만 전송했다. 성공 또는 실패에 따른 추가 모델 요청/자동 재시도는 하지 않았다.

| 단계 | 실제 관측 | 판정 |
| --- | --- | --- |
| App Server + WebSocket 초기화 | 서버 살아 있음, Initialize 성공 | PASS |
| `thread/start` | 새로운 Thread ID 반환 | PASS |
| 실행 모델 | API 응답 `model=gpt-6.1-sol` | 관측 |
| `turn/start` | 실제 Turn ID 반환, `error` 없음 | PASS |
| `turn/completed` | `status=completed` 이벤트 수신 | PASS |
| 첫 클라이언트 연결 종료 | App Server 프로세스 생존 | PASS |
| 두 번째 클라이언트 연결 | 새 Initialize 성공, 동일 Thread ID의 `thread/read(includeTurns=false)` 성공 | PASS |
| 완료된 이력 포함 읽기 | `thread/read(includeTurns=true)` 성공 | PASS |
| 실행 중 Turn 연결 교체 | **이번 Turn은 연결 종료 전에 완료** | NOT TESTED |
| `turn/interrupt`·승인 전달 | 대상 없음, 호출하지 않음 | NOT TESTED |
| 사용자 입력 문구와 실제 모델 텍스트 일치 | 실제 메시지 본문을 이 시험 로그에 저장/검사하지 않음 | NOT VERIFIED |
| Token/비용 Receipt | 실제 사용량·단가를 계측하지 않음 | UNKNOWN |
| 인증 오류 | 이번 격리 서버 로그 `401 Unauthorized` 없음, `ERROR` 0건 | PASS (시험 범위) |
| 정리 | 임시 App Server 정상 종료, 해당 임시 Workspace 삭제 | PASS |

**중요한 해석:** 이전 **미인증 빈 Thread** 시험에서 `thread/read(includeTurns=true)`가 실패한 것과 달리 이번에는 **인증된 완료 Turn**에서 이력 포함 조회가 성공했다. 인증 차이와 rollout 생성 조건 등이 함께 달라졌으므로 앞선 오류의 유일한 원인을 인증이라고 단정하지 않는다.

**핵심 한계:** 완료된 Turn의 새 클라이언트 조회는 **in-flight Worker/실행 중 command의 연결 독립성**이나 Host/App Server 종료 뒤 재개와 다르다. OS Writer의 중지/이중 쓰기/`unknown` 명령 중복 방지는 아직 시험하지 않았다. 이 상태에서 W1을 도입하지 않는다.

## 증거

- device-auth 종료·격리/기본 로그인 확인: Mac tracked operation `6a3457df-a3e7-4ef2-aebd-2c34470d8b2c`, `b2fa313f-b459-4b9b-8e1a-f206f2b4ba38`
- 실제 `turn/start` 및 완료/새 Client history read: Mac tracked operation `a476bf86-8328-4849-9ba3-80971c3d05eb` (종료 코드 0, 잔여 출력 소진)
- 계정 인증 파일의 내용, 비밀 키, 접근 토큰은 증거로 출력·저장하지 않았다.

## 다음 검증 게이트

1. **Mac G0-T26:** 사용자 계정과 분리된 실제 *in-flight* Turn의 첫 클라이언트 종료 후 상태 조회. 후속 독립 시험은 사전에 모델 사용 횟수·실행 시간·취소 범위·제어 불가능한 child process 대비 안전 중단 방식을 고정한다.
2. **G0-T25/G1:** 실제 OS 명령이 실행되는 Worker A를 관측하고, 중단/완전 종료/Workspace revision 확인 뒤에만 Worker B가 쓰도록 하는 반례 검증. 단순 `PID alive`나 CAS만으로 대체하지 않는다.
3. **T24:** 기존 Host Dispatcher와 Codex Goals의 자동 실행 중복 방지.
4. **Windows Native:** executor heartbeat `persistence_unavailable` 복구 후 격리 capability 검증.
5. **W1:** 실제 Worker 수명·제어·old Writer 격리까지 입증되기 전 구현·제품 기본값 전환 금지.

이번 범위는 격리 인증 및 **단일 read-only 모델 Turn**의 성공을 입증하는 것이다. G0 통합 및 W1을 PASS로 올리지 않는다.
