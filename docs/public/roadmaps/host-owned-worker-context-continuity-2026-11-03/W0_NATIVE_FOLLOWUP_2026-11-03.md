# W0 Native Capability 후속 검증 — Codex App Server 0.162.1

- 날짜: 2026-11-03 (KST)
- 시작 소스: `main / c35979c408da120e4827791700ccb5a4c06ab78f`
- 범위: **Mac Native 격리 Thread 시작·연결 교체·재조회** 및 Windows Native 재접속 상태 재검증
- 최종 판정: **G0 PARTIAL, W1 DEFER**
- 사용자 계정 Codex/DB/실사용 Thread/앱 서버는 변경·종료·업그레이드하지 않았다.

## 1. Native CLI 및 프로토콜

Mac Native Host의 실제 바이너리는 `/opt/homebrew/bin/codex`이며 `codex-cli 0.162.1`이다. 빠르게 종료되는 명령의 출력이 누락되는 경우가 있었으나, 실행 중 출력을 조회하고 종료 시점에 남은 출력까지 소진해 정상 버전과 도움말을 확보했다. 출력 누락의 내부 원인은 확정하지 않는다.

`codex app-server --help`에서 `stdio://`, `unix://PATH`, `ws://IP:PORT` 전송과 `daemon` 관리 기능을 확인했다. `codex app-server generate-json-schema --experimental --out <temp>`으로 **설치본이 생성한** 프로토콜을 분석했으며 다음 메서드/필드를 확인했다.

| 메서드 | 스키마 존재 | 실제 격리 실행 |
| --- | --- | --- |
| `initialize` | 있음 | PASS |
| `thread/start` | 있음 | PASS — 새 Thread ID 발급 |
| `thread/read(includeTurns=false)` | 있음 | PASS — 연결 교체 후 같은 Thread ID 조회 |
| `thread/read(includeTurns=true)` | 있음 | FAIL — `list_turns is not supported yet` |
| `thread/resume` (기본) | 있음 | FAIL — `list_turns is not supported yet` |
| `thread/resume(excludeTurns=true)` | 있음 | FAIL — `no rollout found for thread id` |
| `thread/list(useStateDbOnly=true)` | 있음 | 요청 성공, 빈 Thread 목록. **재개 증거가 아님** |
| `turn/start`, `turn/interrupt` | 있음 | 스키마만 확인; 모델 Turn 시작/중단은 **미실행** |
| `thread/goal/set` | 있음 | 스키마만 확인; 자동 Goals 중복 테스트 **미실행** |

`codex app-server daemon version`은 읽기 전용 호출 시 user-level control socket 파일이 없어서 **연결 실패**했다. 따라서 기존 사용자 Mac의 관리형 App Server Daemon이 살아 있다고 가정하지 않는다. `daemon start/restart/bootstrap/enable-remote-control`은 실행하지 않았다.

## 2. 격리 WebSocket 시험의 신뢰 경계

- 별도의 임시 `CODEX_HOME`, `HOME`, 작업 디렉터리, Unix socket으로 *테스트용* App Server 프로세스를 시작했다.
- Mac CLI의 `unix://` 전송은 raw JSONL socket이 아닌 **WebSocket HTTP upgrade**를 요구한다. 최초 raw JSON 요청은 HTTP parse 오류로 연결이 닫혔고, 올바른 WebSocket 클라이언트 마스킹/프레임으로 재검증했다.
- 첫 WebSocket 클라이언트가 새 빈 Thread를 시작한 후 연결을 종료했다. App Server 프로세스가 계속 살아 있음을 확인했다.
- 같은 격리 스크립트의 **새 WebSocket 연결**에서 두 번째 `initialize`를 수행하고, `thread/read(includeTurns=false)`로 같은 ID를 조회했다.
- 이는 **클라이언트 연결 독립성**과 빈 Thread 메타데이터 조회를 입증한다. **별도 OS Main 프로세스 종료 후 재연결**, 실제 실행 중 `turn`/`command`의 생존, App Server 종료 후 Resume 또는 old Writer 중지는 입증하지 않는다.
- 빈 Thread에 첫 Turn/rollout이 없는 조건에서 `thread/resume(excludeTurns=true)`는 "no rollout found"를 반환했다. 빈 Thread의 실패를 실작업 Thread 일반의 실패로 확대하지 않는다.
- 각 시험은 격리 App Server 종료와 임시 디렉터리 정리를 수행했다. 사용자 운영 App Server에 요청하지 않았다.
- 모델 Turn은 실행하지 않았고 API 사용료·사용자 승인·Credential 사용을 수반하는 동작을 시도하지 않았다.

## 3. Native Host 관측

| Host | 이번 추가 관측 | 결론 |
| --- | --- | --- |
| Mac Native | CLI 0.162.1 실행, 프로토콜 schema, WebSocket 초기화/Thread start/연결 교체 후 ID read 검증 | **연결 교체 부분 PASS / 실제 worker lifecycle PARTIAL** |
| Windows Native | `executionTarget=host` 호출 재시도는 새 읽기 전용 작업이지만 executor heartbeat stale (pre-spawn `persistence_unavailable`) | **DEFER**, 사용자 Windows Native executor 재시작하지 않음 |
| Mac/Windows Linux MCP | 별도 Linux workmachine. Mac은 초기 checkout이 구 버전이며 수정하지 않음. Windows-side 소스 `main`이 구현 작업의 소유권을 유지 | Native Worker 실행 결과로 대체 불가 |

## 4. 알고리즘 선택에 미치는 영향

1. **재사용 가능한 기반:** Codex의 Native App Server가 실제 Thread ID·연결 수명·WebSocket 전송을 소유한다. 향후 Host-owned Worker가 가능하더라도 기존 App Server에 연결하는 **얇은 호출 경계**부터 검토하고, 별도 Worker DB/Queue/Model Proxy를 만들지 않는다.
2. **필수 미확인:** 실제 모델 Turn의 start/status/interrupt/새 Main 조회, 사용자 승인 전달, 독립 App Server 종료 후 재개, 실행 중 command의 unknown reconciliation, old Writer 강제 종료·물리 펜싱.
3. **미관측 방어:** `thread/read(includeTurns=false)`의 성공을 `thread/resume` 성공이나 완전한 Transcript 보존으로 확대하지 않는다. Provider가 `list_turns`를 지원하지 않는다면 상위 Kernel Receipt의 완료 권위를 대신할 수 없다.
4. **계획상 Gate:** G0에는 *실제 실행 중* Worker 생존 및 제어의 Native 근거가 필요하다. 따라서 **W1 제품 코드 구현은 아직 시작할 수 없다.** 안전한 실모델 Pilot을 수행하려면 비용 상한, 격리 Credential, 승인·Sandbox 정책을 먼저 고정해야 한다.
5. **특정 버전 하드코딩 금지:** `0.162.1`의 `list_turns` 실패를 일반적인 모든 버전의 지원 부재로 가정하지 않는다. 향후 기능 검사는 설치 시 읽기 전용 실제 프로토콜/실행 결과에 기반해야 한다.

## 5. 증거

- Mac Native CLI 버전/help 정상 stdout: `operationId=561fd7cf-fbb1-4d4e-802c-e5a27c8c4536`.
- 프로토콜 schema 생성·요청 필드 분석: `operationId=6759909a-ce66-4a81-9ddc-b947a6ae3dc1` / `01c8d64d-eb36-4a53-a714-0d00f7863ff5`.
- 첫 raw Unix JSON이 WebSocket handshake 부족으로 실패: `operationId=d4b99e26-84b2-4e50-be66-65616563623a`.
- 올바른 WebSocket 연결 + 기본 `thread/resume` 실패: `operationId=c46f93b3-cbb3-469f-8690-77263a997e14`.
- 두 번째 연결의 `thread/read(includeTurns=false)` 성공, `resume(excludeTurns=true)` 빈 rollout 실패: `operationId=eab7a67e-89e9-47ba-a04e-f37a20d09855`.
- Mac 사용자 daemon의 관리형 socket 미존재 (읽기 전용): `operationId=f5e22cdc-43f2-4186-8b45-3303fc005902`.
- Windows Native executor stale heartbeat: `operationId=80339876-910b-4c37-bfde-7a971d18b895` (도구 호출이 프로세스 시작 전에 거절됨).

외부 사례 참고(직접 실험과 **구분**): [openai/codex 이슈 #37754](https://github.com/openai/codex/issues/37754)에는 일부 버전의 `list_turns is not supported yet`와 Thread resume 실패 보고가 있다. 원인에는 다양한 Thread 저장 방식/버전 불일치가 제시되어 있다. 이번 *빈 임시 Thread*와 동일 원인이라고 확정하지 않는다.

## 6. 다음 기술 검증

G0의 Native 잔여 조건은 (1) 정상적인 실제 Turn(격리된 별도 계정/예산/Provider 설정 포함) 시작·중단·진행 상태 재조회, (2) Main 프로세스 종료 후 다른 OS 프로세스에서 동일 진행 상태 관측, (3) 사용자 승인 대기 및 취소 시점, (4) old Writer의 파일 쓰기 중지/unknown 명령 정착, (5) Windows Native의 별도 실행기 연결 검증이다.

안전한 비용 없는 preflight가 더 없다면 G0를 PARTIAL로 유지하고 **W1 코드 구현을 억지로 진행하지 않는다**. 기존 Kernel Work/Trust/Knowledge와 owner-direct 실행은 계속 사용한다.


## 7. 추가 G0 비모델 명령 경계 관찰 (2026-11-03 후속)

Mac Native Codex 0.162.1이 **생성한 JSON Schema**에는 `thread/shellCommand`, `thread/backgroundTerminals/list`, `thread/backgroundTerminals/terminate`가 있다. `InitializeCapabilities.experimentalApi=true`가 있어야 `backgroundTerminals/list`를 호출할 수 있다. Background terminal 응답은 `processId`와 선택적 `osPid`를 표현할 수 있으나, 실제 목록에 프로세스가 존재한다는 증거는 아니다.

임시 `CODEX_HOME`/`HOME`/Workspace를 각각 분리하고 사용자 인증 정보를 환경변수에서 전달하지 않은 시험용 App Server에서 두 차례 검증했다.

- 첫 검증에서 `thread/start`는 성공했다. `thread/shellCommand`로 `printf W0_SAFE_CMD_OK`를 요청하면 `result: {}`가 반환됐다. Experimental API를 활성화하지 않은 `backgroundTerminals/list`는 `requires experimentalApi capability`를 반환했다. **빈 RPC result를 명령 실행/출력 성공으로 해석하지 않는다.**
- 다음에는 `experimentalApi=true`로 시작하고 5초짜리 격리 Python sleep 명령을 `thread/shellCommand`로 요청한 뒤 WebSocket 클라이언트를 닫았다. 연결 종료 전후에 해당 Python 명령 PID를 관측하지 못했다. 새 클라이언트의 `thread/read(includeTurns=false)`는 같은 Thread ID로 성공했고, `backgroundTerminals/list`는 빈 배열을 반환했다. **실제 명령 생존·재연결·취소는 검증되지 않았다.**
- 같은 App Server 실행의 stderr에는 `codex_api::endpoint::responses_websocket` 연결의 `401 Unauthorized`가 기록됐다. 이 실행 경로를 무료 로컬 셸 실행으로 간주할 수 없다. 오류의 인과나 모든 버전의 동작은 단정하지 않는다.
- 실험 전용 App Server/프로세스는 정지했고 임시 데이터는 정리했다. 사용자 운영 Codex 세션, 인증·설정, 사용자 프로세스는 변경하지 않았다.

**G0 판정 유지:** 실제 실행 중 Turn/Command 생성·상태·중단·재연결·old Writer의 물리적 차단은 `NOT VERIFIED`. 실제 실행 Pilot은 격리 Credential·비용 상한·승인 정책이 확정되기 전에는 실행하지 않는다.

**MCP 영수증:** Schema `c0d96ae6-18ee-45e9-8fe2-753234f89a33`, `6b407eaa-b1ba-4d8d-9540-5c23ad1aa293`; 첫 셸 명령 요청 `1d7c2d1b-86f4-4d2d-9eb9-f050e558a3ca`; 5초 프로세스와 연결 교체 시험 `10d531a6-a220-4118-a3c9-b89df7eb8aef`; Windows Native heartbeat 오류 `d5ebc95b-355b-4fd7-a448-a9594483bbab`.

## 8. 격리 인증 이후 실제 Turn 검증(후속 결과)

사용자 승인으로 **별도 W0 `CODEX_HOME`의 ChatGPT 기기 로그인을 완료**했다. 인증 후 임시 App Server에서 짧은 모델 Turn 1회를 `read-only`/`approvalPolicy=never`로 실행했으며 `turn/completed(status=completed)`를 수신했다. 첫 연결을 끊고 새 연결에서 동일 Thread의 `thread/read(includeTurns=true)`도 성공했다. 이번 서버 로그에는 Provider `401 Unauthorized`가 없었다. **이전 401·빈 Thread 이력 오류의 인과를 인증 하나로 단정하지 않는다.** 실제 *in-flight* 연결 교체/취소/OS Writer 차단은 여전히 미검증이다. 자세한 실행 증거와 사용 조건은 [W0 인증·실제 Turn 결과](W0_AUTH_TURN_RESULT_2026-11-03.md)를 참조한다.
