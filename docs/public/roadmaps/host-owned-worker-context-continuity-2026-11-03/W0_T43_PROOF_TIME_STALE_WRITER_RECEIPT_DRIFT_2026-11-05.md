# W0 T43 — Proof 도중 이전 Worker 지연 쓰기와 Canonical Receipt 재검증

- 날짜: 2026-11-05
- 소스: 5e912072 (초기), 1aa17639 (시험 인자 수정)
- 판정: 제한된 지연 OS Writer 탐지 PASS / 임의 Native 후손 종료 미증명
- 전체: G0 PARTIAL / W1 DEFER

## 이유 및 검증 범위

T39/T40에서 실제 Codex App Server 부모 종료와 기존 Fence 만료는 분리된 Native Writer의 쓰기 권한을 없애지 못했다. T42-B2-C는 종료가 확인된 동기식 Worker의 복구 Host 경쟁과 TTL 경계를 증명했다.

이번에는 과거 두 Host의 Canonical Result Commit과 Receipt가 정상인 상태에서, 새로운 복구 Host의 Trusted Proof 도중 별도 시험 OS Writer가 원래 Step Worktree에 지연 쓰기를 수행하는 반례를 추가했다. Writer는 이 테스트가 생성한 유한 Node 자식이며 실제 Codex Native Tool Writer의 임의 후손이 아니다.

## 과정

1. 기존 Host A/B는 서로 다른 Step 결과를 Commit/Report로 남긴다. Owner Revision 0, Attempt started 2건이다. 최초 Canonical Receipt 조회는 ready다.
2. 새 복구 Host는 기존 Kernel Fence와 신규 물리 Integration Worktree에서 Trusted Proof를 수행한다. Mac에서는 macOS Seatbelt writeScope를 적용한다.
3. Proof가 시작되면 별도 OS Writer가 원래 Step Worktree에 추적되지 않은 파일을 기록하고 종료한다. Proof가 끝난 뒤 Receipt를 재조회한다.
4. 복구 후보는 recovery_receipt_changed_during_proof로 blocked 되어야 한다. Owner Mutation Revision 0, Attempt started 2건, 실행 가능한 Step 0개, Owner 파일 미적용, Report 정착 0건을 유지해야 한다.
5. 기존 Fence가 해제되고 작업을 재실행하지 않음을 검증한다.

이 결과는 시점 간 Receipt 재조회 보호 기능을 증명한다. 그러나 읽기 이후 발생하는 임의 미래 쓰기까지 OS 차원에서 막는 것은 아니다.

## 실측

| 검증 | 결과 |
| --- | --- |
| Linux 격리 개발 의존성 설치, typecheck, test build | PASS |
| Linux 집중 | 7 PASS / 0 FAIL |
| Linux 확대 Dispatcher/Fence/Recovery | 28 PASS / 2 OS SKIP / 0 FAIL |
| Linux 모듈 경계 | 9 modules / 313 files / 855 edges PASS |
| macOS Node 24.6.0, typecheck, test build | PASS |
| macOS 초기 소스 5e912072 전체 집중 | 6 PASS / 1 FAIL (시험용 Node 인자 오류) |
| macOS 수정 소스 1aa17639 신규 지연 쓰기 단건 | 1 PASS / 0 FAIL |
| macOS 수정 소스 전체 집중 회귀 | **6 PASS / 1 FAIL** — 기존 split-weak-proof의 Host A/B signal/unknown 종료, 원인 미분류. 전체 PASS로 계산하지 않음 |
| macOS 동일 소스 split-weak-proof 단독 재검증 | **1 PASS / 0 FAIL** (전체 회귀 실패 기록은 유지) |
| macOS 모듈 경계 | 9 modules / 313 files / 855 edges PASS |

초기 macOS 실패는 시험용 별도 Node -e Writer가 process.argv[0]을 Node 실행 파일로 처리하지 않아 대상 경로를 잘못 읽은 Fixture 오류였다. process.argv.slice(1,3)으로 수정했고 재검증했다. 초기 실패는 성공으로 계산하지 않았다.

- Linux 집중: operationId cda6f229-5bb4-4a0f-84e2-a8c5496c9b6d
- Linux 확대·경계: operationId fd6f5e12-fdbd-4d71-9000-4d83a4c9be98
- Mac 초기 실패: operationId 3c846ab3-e0d8-489d-b3a5-8c50a1f2faf7
- Mac 수정 뒤 단건 PASS: operationId b57d89d9-2816-4302-94c3-37f664cb315a
- Mac 재조회: operationId c507ac21-4943-442f-9975-0f4196b5f363
- Mac 수정 후 전체 집중 6 PASS/1 FAIL: operationId 968483b1-62e0-4f7e-a954-040bf30e619d. 기존 split-weak-proof의 Host가 code null로 종료됐으나 실제 signal과 최초 원인은 증거가 부족해 미분류로 보존한다.
- Mac 동일 소스 split-weak-proof 단독 재검증 및 경계 PASS: operationId 6c22a150-f976-4d1e-973d-13601fb06a23.

## 복잡도·권위 경계

기존 tests/kernel-parallel-positive-two-hosts.test.ts에 테스트 모드와 시험용 파일 Marker만 추가했다. 제품 Dispatcher, Proof Executor, DB, Queue, Scheduler, Provider별 폴백, Writer 예약 자동 해제는 변경하지 않았다.

writerExitVerified:false, deliveryAuthorized:false, Native 자동 합류 비활성, 불확실한 예약/Worktree 보존을 유지한다. 다음 단계는 Native 후손의 완전 종료 혹은 세대별 쓰기 격리의 일반화 가능성을 검증하는 것이다.
