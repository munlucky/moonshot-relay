# W0 T43-A — macOS split-weak-proof Host 종료 미분류 후속 검증

- 검증일: 2026-11-05 (KST)
- 이전 기준선: ec17af6bef8b574df789d75323eecc8e1107c59d
- 테스트 종료 관측 개선: e63ce5ddae9d01c0dd6d1c952310478e1207bf51
- 판정: **동일 소스 macOS 원본 전체 7 PASS / 수정 후 전체 7 PASS**, 기존 실패 원인 **미확정**
- 전체 G0 PARTIAL / W1 DEFER 유지

## 이전에 확인한 문제

T43의 macOS 수정 소스 1aa17639 전체 집중 테스트에서 6 PASS / 1 FAIL이 발생했다. 마지막 split-weak-proof의 두 별도 Host가 exit code null로 끝났고, 종료된 이후 비동기 unhandledRejection도 기록됐다. 동일 소스의 split-weak-proof 단독 재검증은 1 PASS였다.

당시 오류 메시지는 자식 Host의 종료 signal과 PID를 기록하지 않았다. 따라서 macOS 자원압박, 외부 프로세스 종료, 상위 테스트 Assertion 실패 이후 test-finally에서 강제 종료된 경우를 구분할 근거가 없다. **기존 단일 실패는 성공으로 소급 변경하지 않는다.**

## 변경 없는 소스 재현 시험

macOS Native Host에서 사용자 Codex/원본 Worktree와 분리된 Git Clone으로 ec17af6b를 설치했다. Node 24.6.0과 macOS 실제 커널에서 TypeScript 및 테스트 빌드를 통과했다. 기존 7개 Host 충돌 시나리오를 단일 테스트 Runner에서 순서대로 모두 실행했다.

- **7 PASS / 0 FAIL / 0 SKIP**, 총 약 101초
- split-weak-proof 1 PASS
- 과거 Host가 exit null로 실패하던 상태는 이번 기준선 재실행에서 재현되지 않음
- 실행 증거: macOS operationId 184c457c-1d0d-4735-a0f3-78937e360628

**판정:** 소스의 확정적 회귀 결함이나 실제 종료 원인은 확인되지 않았다. 일시적 시스템/타이밍 영향은 가능성이 있지만, 측정되지 않은 추론이므로 원인으로 선언하지 않는다.

## 테스트 실행 인과 증거 개선

기존 tests/kernel-parallel-positive-two-hosts.test.ts 파일만 15줄 추가·2줄 수정했다.

1. Host Promise가 종료할 때 code뿐 아니라 signal과 OS pid를 오류에 표시한다.
2. 상위 Barrier/Assertion이 일반 Promise.all 이전에 실패할 수 있으므로, 생성 즉시 Host의 rejected Promise를 관측하여 비동기 오류가 최초 실패 뒤에 새 unhandledRejection으로 새어 나오지 않게 한다.
3. test finally는 시험이 생성한 Host 자식의 OS 종료뿐 아니라 그들의 Promise 결과도 모두 정착시킨다. 정착 실패를 PASS로 바꾸지 않고 본래 Assertion을 그대로 유지한다.

**제품 경로 미변경:** Dispatcher, Kernel Control Plane, Proof, Native Transport, 예약/Writer 리트라이, DB, Queue, Scheduler 및 신규 정책/폴백 추가 없음. 테스트 timeout 값, 실제 Worker 실행, Owner CAS/Report 계약을 바꾸지 않았다.

## 변경 후 검증 결과

| 범위 | 결과 |
| --- | --- |
| macOS 실제 Darwin 소스 e63ce5dd strict typecheck | PASS |
| macOS 테스트 빌드 | PASS |
| macOS 단일 Runner 전체 7개 시나리오 | **7 PASS / 0 FAIL / 0 SKIP**, 약 100초 |
| macOS module boundary | PASS, 9 modules / 313 files / 855 edges |
| Linux 격리 개발 의존성·TypeScript·테스트 빌드 | PASS |
| Linux focused 5개 테스트 파일 | **15 PASS / 2 OS SKIP / 0 FAIL**, 총 17 |
| Linux module boundary | PASS, 9 modules / 313 files / 855 edges |

- macOS 수정 뒤 전체 테스트·빌드·경계: operationId 6b3606b4-919b-429a-bf09-f18d1fbddf3a
- macOS 원본/수정 상태 대조: operationId ab7ca638-c28e-4f58-a7f4-cc9318e22125
- Linux 검증: operationId 4f81702a-3f7e-428b-ae62-4a059f6208cd
- 코드 변경·푸시: operationId 29759e3f-4b1a-41b6-bf84-6f2d57260bc5

## 남은 불확실성과 판단

- **기존 6 PASS / 1 FAIL은 미분류로 보존한다.** 이후 두 전체 성공이 과거 실패 원인을 증명하지는 않는다.
- 재발 시 Host 종료 신호, PID, 상위 Assertion 최초 실패 및 OS 메모리/프로세스 이벤트를 함께 대조한다. 확인되지 않은 이유로 Timeout을 무조건 늘리거나 자동 재시도·Provider별 폴백을 추가하지 않는다.
- 실제 Native App Server가 생성한 임의 분리 후손의 수명 전체 종료·장래 쓰기 권한 박탈은 여전히 미증명이다. macOS Seatbelt의 제한된 실증을 Linux/Windows PASS로 취급하지 않는다.
- Native Writer의 writerExitVerified:false, deliveryAuthorized:false 및 예약·격리 Worktree 보존, 기본 자동 합류 비활성 원칙은 유지한다.

**T43-A 실행 증거 강화 완료 / 기존 macOS 단발 실패 원인 미확정 / 전체 G0 PARTIAL, W1 DEFER.**
