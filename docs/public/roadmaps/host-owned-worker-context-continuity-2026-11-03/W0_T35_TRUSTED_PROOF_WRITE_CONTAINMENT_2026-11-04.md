# W0 T35 — Trusted Proof 선택형 쓰기 격리 (OS 실측 선행)

- 기준선: `main / 558b2b13dc36a0c33465ee179aa5ab35d997f686`
- 날짜: 2026-11-04
- 상태: **macOS 독립 OS 후손 격리 실측 / 통합 Dispatcher 자동 경로는 미활성화**
- 범위: `src/host/kernel/proof/write-containment.ts`, `proof-executor.ts`, 기존 `TrustedProofInput` 계약 및 검증 테스트만 변경. 새로운 DB·Queue·Worker·Scheduler 없음.

## 문제와 최소 구현

T34는 기존 Owner Fence TTL이 만료된 뒤 이전 Trusted Proof의 detached Writer가 다시 쓰더라도 Kernel CAS는 이를 막지 못한다는 반례를 실증했다. Fence를 Proof 앞에 옮기기 전에 **Proof 프로세스 및 분리된 후손이 자기 물리 Worktree 외부에 쓸 수 없는지** 확인해야 한다.

1. `executeTrustedProof()`에 명시적인 `writeScope` 선택 옵션을 추가한다. **기존 Proof 호출의 기본 동작은 변경하지 않는다.** 활성화된 경우 실제 `projectRoot`와 `writeScope`의 `realpath`가 같아야 한다. `/tmp`와 `/private/tmp`처럼 별칭을 표준화하지 않으면 macOS Sandbox 정책이 우회될 수 있어 단순 `path.resolve`로 대체하지 않는다.
2. 현재 실제 시험이 가능한 Mac에서만 OS 기본 `/usr/bin/sandbox-exec`로 OS Seatbelt 정책을 적용한다. `(allow default)`로 기존 명령/읽기/프로세스 실행 권한을 유지하되, `(deny file-write* (require-not (subpath <canonical-worktree>)))`로 해당 물리 Worktree 외부의 쓰기를 차단한다. OS 프로세스에 적용된 정책은 표준 입출력을 상속한 detached Node 후손에도 상속되는지 실제 검증한다.
3. 요청된 OS 강제 경계를 사용할 수 없거나 scope가 현재 CWD와 일치하지 않으면 `PROOF_WRITE_CONTAINMENT_UNAVAILABLE`로 실행 **전**에 거부한다. Linux/Windows를 일반 spawn으로 폴백하지 않는다. 별도 OS별 하드코딩된 가상 격리 결과를 만들지 않는다.
4. 격리가 요청되고 Proof 명령이 실제 성공한 경우에만 `writeContainment` 실행 증거를 기록한다. 실패한 OS wrapper 실행을 격리 성공이라고 주장하지 않는다.

## 기존 동작과 주의 사항

- 사용자/Kernel의 기존 `executeTrustedProof()`는 `writeScope`를 넘기지 않으므로 그대로 실행한다. **Canonical 자동 복구, Owner CAS, 물리 Worktree 재사용/폐기, 외부 Writer 예약 해제는 이번 작업에 연결하지 않는다.**
- macOS 보안 정책은 실제 커널이 강제한다. 디렉터리 이름만 분리하는 것은 강제 격리가 아니며 Owner Fence 역시 OS 쓰기 권한을 회수하지 못한다.
- 보안 정책이 강해 일부 Node subprocess의 `stdio: 'ignore'` 등 OS 장치 쓰기가 거부될 수 있다. 명령 호환성을 위해 무조건 예외 경로를 늘리거나 Provider별 폴백을 추가하지 않는다. 테스트는 `stdio: 'inherit'`의 detached Writer를 사용한다.
- 실제 모델/Provider Tool의 모든 형태의 서브프로세스, 파일 링크/하드링크와 악의적 OS 경계 우회, Linux/Windows 실행 호환성까지 보장한다는 뜻은 아니다. **단독 보안 경계의 안전성은 검증된 OS·프로파일·경로 범위 안에서만 판단**한다.

## 검증

| 항목 | 결과 |
| --- | --- |
| Linux 격리 TypeScript·제품·테스트 빌드 | PASS |
| Linux 집중 Trusted Proof/Network/기존 T34 | 17 PASS / 2 OS SKIP / 0 FAIL |
| Linux `writeScope` opt-in | OS 강제 수단 부재 시 오류로 거부, 미격리 실행 없음 |
| Mac 기본 OS Sandbox 직접/분리 Write Scope 시험 | `realpath` 정규화 후 지정 경로 허용, Owner/형제 경로 쓰기 `EPERM` 차단 |
| Mac 실제 Kernel `executeTrustedProof(writeScope)` + symlink 반례 | **3 PASS / 1 OS SKIP / 0 FAIL**, TypeScript·제품·테스트 빌드 PASS, detached 후손의 자기 Worktree 쓰기 허용, Owner·형제·symlink Owner 쓰기 각각 `EPERM` 거부 |
| Linux 확대 회귀·모듈 경계 | **58 PASS / 3 OS SKIP / 0 FAIL**, 9 modules / 312 files / 850 edges PASS (`operationId=98ce9671-eaa3-443a-8bfd-d8173847f6c6`) |

Linux 최초 결과: operation `9f6cbb94-85cf-4e31-bd44-ce9575d8b2e7`. Mac 저수준 실측: operation `e091b3f8-ab49-46bc-a726-8053a10f6c19` (실경로 제한), `92d8d33d-cfdf-44da-85cf-8033ce140ba4` (scope 밖 기본 차단), `2ae726df-98da-4178-bb6f-73b904040222` (detached Node 실제 `EPERM`). 비정규화 경로에서 정책 미적용과 최초 기본 차단 Node 호환성 오류도 실패 기록으로 보존한다.

Mac 실제 격리 소스는 `feacc9d81c96e10de8a0a2d43d514e0b842aed6b`이며 Node v24.6.0에서 제품 `executeTrustedProof(writeScope)`로 Sandbox 정책을 적용했다. 실행 operation `2390b873-210e-43e2-84e7-3fe69acb87dc`, 로그 및 Runtime SHA 교차 확인 `183b3bf7-c43b-4d22-b6ce-76896490335d`, 시험 전용 소스/의존성 정리 `5fce7f3a-9ff0-4f30-b364-9e7288af3357`. 원본 Mac 저장소와 운영 Codex 세션은 변경하지 않았다. T34의 Fence 만료 후 늦은 쓰기 반례는 **여전히 PASS**이며 새로운 API의 쓰기 격리가 오직 명시적 선택형이기 때문에 기존 자동 결과 합류를 안전하다고 오판하지 않는다.

## 다음 게이트

**OS 쓰기 제한 검증과 Proof 시작 후 모든 후손 수명 확인은 서로 다르다.** 이전 Proof의 후손이 계속 살아 있으면 이전 Worktree 정리/재사용이 안전하지 않다. 따라서 복구를 구현하려면 다음을 함께 만족해야 한다.

- 각 복구 시도마다 별도의 실제 통합 Worktree를 배정하고 기존 시도의 물리 Worktree를 미확인 상태에서 재사용/삭제하지 않는다.
- 동일 Canonical Owner에 대해서는 기존 Owner Fence를 첫 `cherry-pick` 이전에 획득해 통합 Proof·Owner CAS·Report/Proof 정착 전 구간에 걸쳐 유지한다. 만료·새 Epoch·Crash/중복 Host 반례 검증이 필수다.
- 검증된 Canonical Step 결과만 새 Writer 실행 없이 회수한다. Native Writer 후손의 종료가 증명되지 않았다면 자동 합류·예약 해제는 계속 차단한다.

**현 상태: G0 PARTIAL / W1 DEFER.**
