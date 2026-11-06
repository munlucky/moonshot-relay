# 로컬 Host Worker 제어

MCP 없이 기존 로컬 Worktree와 Kernel Run의 Worker를 제어한다. 새로운 Run·작업 저장소·데몬을 만들지 않는다. 먼저 기존 Kernel 경로로 작업 계약과 Run을 등록한다.

## 제품 진입점

```text
node bin/moon-relay-kernel.mjs worker-host --project-root <worktree> --runtime-home <runtime> --run-id <run-id>
```

명시적으로 실행하는 전경 Host다. 표준 입력과 출력에서 줄마다 JSON 객체 하나를 교환한다. `id`로 응답을 대응한다. 시작 명령은 모델과 effort를 명시해야 한다.

```json
{"id":1,"action":"capabilities"}
{"id":2,"action":"start","model":"<host-selected-model>","effort":"<host-selected-effort>"}
{"id":3,"action":"status"}
{"id":4,"action":"attach"}
{"id":5,"action":"resume","model":"<same-model>","effort":"<same-effort>"}
{"id":6,"action":"interrupt","attemptId":"<observed-attempt-id>"}
```

`--run-id`나 Host 환경 바인딩이 없으면 요청에 `runId`를 명시하거나 기존 Kernel의 Worktree Run 탐색 규칙을 사용한다. 요청이 Host의 Run 바인딩과 다르면 거부한다. 요청으로 Worktree·Runtime을 바꾸지 않는다.

## 기능과 기존 코드 연결

| 기능 | 처리 경로 |
| --- | --- |
| 시작 | `createLocalWorkerControl` → `HostWorkerSessions.startLocal` → 기존 Attempt 선점과 App Server 실행 |
| 결과 반영 | 기존 Worker 보고서·Git 후보 검증 → Manifest Proof → Owner Fence/CAS → Canonical Report |
| 중단 처리 재개 | `resume` → 같은 Attempt의 정착 재개. Report가 이미 저장됐다면 저장된 결과를 복구하고 파일을 다시 적용하지 않음 |
| 후속 Step | 같은 Host가 저장된 `report.next`를 소비. 후속 시작이 실패하면 `resume`으로 같은 지시를 재시도 |
| Main 교체·취소 | 같은 Host 세션에서 원래 Attempt와 Turn을 조회하고 해당 Turn에 신호 전달 |

`status`와 `attach`는 새 Worker나 실행 지시를 만들지 않는다. Canonical 상태와 현재 Host의 live 상태를 구분한다. `start`·`resume` 응답에는 Main이 다시 실행할 `next`를 넣지 않는다. 요청 종료나 채널 `close()`는 Worker 취소가 아니다.

## Native Host 연결과 지원 범위

Native Host는 `createHostWorkerSessions`를 한 번 만들고 `createLocalWorkerControl`에 `hostWorkerSessions`로 전달한다. 새 Main 연결에도 같은 세션을 사용한다. MCP가 필요한 경우에도 같은 세션을 전달할 수 있다. 별도의 MCP 실행 엔진은 없다. 세션은 Host가 선택한 동일한 `env`를 사용한다.

실제 Writer 배제를 제공하는 Host만 기존 `withWriterExcluded(candidate, operation)` 경계를 연결할 수 있다. 이 경계는 작업이 실행되는 동안 실제 Writer 배제를 유지해야 한다. 모델 입력이나 JSON 요청으로 설정할 수 없다. 성공 불리언·가짜 Receipt·일반 spawn 대체는 허용하지 않는다.

**현재 기본 CLI 구성에는 이 경계의 제품 구현이 없다.** 따라서 `capabilities`와 새 `start`는 `unsupported / host_worker_native_isolation_unverified`를 반환한다. 보호된 Manifest Proof는 현재 macOS Seatbelt만 제공하므로 Windows의 자동 Owner 반영도 지원되지 않는다. 이 진입점 추가로 Native 자동 반영을 활성화하지 않는다. 이미 연결된 실행의 조회·취소는 새 Writer 시작 조건과 구분한다.

전경 CLI의 표준 입출력은 한 연결이다. 다른 프로세스에서 종료된 표준 입출력에 재접속하는 소켓·상시 서비스는 제공하지 않는다. Native Host 안에서의 Main 교체는 동일한 `hostWorkerSessions`를 공유하는 새 제어 연결로 처리한다. Host 프로세스 자체가 종료되면 실행 핸들은 복원하지 않고 Canonical Attempt를 미관측 상태로 유지한다.

인증된 사용자 승인 왕복, Fresh Resume, Host 종료 후 실행 복원은 기존 선행 조건이 없으면 미지원으로 남긴다. 새 Windows 격리 플랫폼·DB·Queue·Scheduler·Handoff 체계는 추가하지 않는다.

## 변경 검증

`npm run test:host-worker-local-control`은 실제 App Server 프로세스의 시작·Main 연결 교체·동일 Attempt 조회·취소와 미지원 시작의 무변경을 확인한다. 이 시험은 Owner 반영 권한을 부여하지 않는다. 보호된 결과 반영과 후속 실행의 관통 증거는 기존 수용 시험과 별도로 구분한다. 이전 전체 A2/A3 Kernel Run의 완료 상태를 변경하지 않는다.
