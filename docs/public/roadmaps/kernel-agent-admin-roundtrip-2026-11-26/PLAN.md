# Moon Relay Kernel 후속 행동 결정 단일화 — 최종 작업계획

2026-11-26 · 기준 소스 `main@8ac626d3` · 계획 확정 · 제품 구현 및 실사용 비교 미실행

## 1. 작업 결정

**Kernel Control Plane이 Report, 독립 리뷰 결과, 기존 Run의 권한 있는 재개에서 다음 행동을 결정한다.** CLI와 MCP는 Kernel이 결정한 행동과 근거를 반환한다. Host는 Reviewer 실행, 실행 가능 여부 확인, Receipt 전달을 담당한다. 에이전트가 받아야 할 일은 구현·수정·필요한 판단이며, Kernel이 이미 가진 상태로 답할 수 있는 질문은 Kernel에서 끝낸다.

이번 변경의 단위는 **같은 결정 하나를 Kernel에 귀속시키고 두 진입점에서 기존 판단을 삭제하는 것**이다. S1과 S2를 함께 구현한다. 구현 전 기준선과 구현 후 결과를 대조해 구조 축소, 기능 보존, 모델 관리 왕복 감소를 각각 판정한다.

| 현행 경로 | 이번 작업에서 다룰 책임 |
| --- | --- |
| CLI `next`가 `action=report`와 빈 `pending/failed`를 조합해 정산 | CLI의 자동 정산 판단 블록 1곳 삭제. 명시적 `finalize` 명령과 Host의 baseline 캡처 계약 보존 |
| MCP가 일반 응답 및 리뷰 직후에 `isReadyReportDirective()`로 정산 여부를 재판정 | 헬퍼와 호출 블록 2곳 삭제. 응답의 `hostReview`와 Kernel이 확정한 정산 상태를 함께 전달 |
| Kernel `settleVerifiedReport()`가 Step, 미충족 의무, Lease를 확인한 뒤 정산 | 기존 Report 경계를 기준으로 사용. 증거 관측, 실제 변경 경로, Git closeout 요청과 fencing token의 의미 보존 |
| Kernel `ingestReviewerOutcome()`가 검증한 리뷰를 저장하고 Judgment Proof 기록 | 리뷰 수락, 증거 정착, 최종 정산의 결과를 구별. 수락 이후 중단되면 저장된 Receipt에서 이어감 |
| Kernel `prepareNext()`가 전달 복구, 검증 지원 확인, 후속 지시 생성을 수행 | 기존 복구 동작 보존. 조회 권한만 가진 호출이 완료 승인이나 Git 커밋을 일으키지 않도록 권한 있는 재개와 구분 |

범위는 기존 Control Plane과 CLI·MCP 어댑터, 리뷰 결과를 전달하는 Host 경계다. 기존 Run 수명주기, 독립 리뷰의 신뢰 검증, Worker·Handoff 계약을 사용한다. 새 상태 머신·저장소·공개 명령·폴링 서비스·진입점별 폴백은 도입하지 않는다. 자연어 Acceptance에 대한 추가 판단은 기존 Reviewer 또는 사용자 권한에 맡긴다. [Control Plane](../../../../src/kernel/control-plane.ts) · [CLI](../../../../src/application/kernel-cli/main.ts) · [MCP](../../../../src/kernel/bridge/mcp.ts) · [리뷰 결과 전달](../../../../src/host/kernel/turn-dispatcher.ts)

## 2. S0 — 구현 전 기준선 고정

기준 SHA의 격리된 프로젝트와 runtime home에서 아래 세 경로를 관측한다. 동일 상태로 CLI와 MCP를 비교할 때는 각자 독립된 초기 사본을 사용한다. 첫 호출의 정산이 두 번째 호출의 입력을 바꾸지 않게 한다.

1. **이미 모델 왕복이 0인 경로.** 현행 MCP 테스트에는 한 번의 `kernel_report`에서 리뷰를 거쳐 `next.action=done`, `status=completed`를 반환하는 사례가 있다. 기준 버전에서 이 동작을 확인하고, 구현 후에도 추가 모델 호출 0회를 요구한다. 이 경로는 비열화 기준이다. [MCP 통합 테스트](../../../../tests/kernel-bridge-mcp.test.ts)
2. **기존 Run 재개.** 기준 버전에서 마지막 증거가 저장되고 정산 가능한 Run을 준비한다. 새 프로세스로 권한 있는 소유자가 재접속해 새 Report·Receipt 없이 기존 Run을 이어갈 때의 명령, 반환값, 최종 상태를 기록한다. 같은 초기 상태에서 조회 전용 호출의 영향도 기록한다. S3에서 기준 버전이 작성한 상태를 그대로 읽는다.
3. **생산성 측정 과제.** 실제 개발 과제 하나의 목표·Acceptance, 초기 Git tree, Host/Kernel 버전, 진입점, 모델·effort, Reviewer 능력과 인증 조건을 고정한다. 가능하면 변경 전 실행을 이때 확보한다. 원본 궤적에는 모델 도구 호출과 Host 내부 호출을 구분하고, 직전 응답으로 이미 해결할 수 있었던 추가 `next/status/빈 report`와 그 횟수를 표시한다. 비교 가능한 라이브 기준선을 확보하지 못하면 해당 사실을 기록하고 구조 작업은 진행한다.

**S0 종료 조건.** 삭제할 블록, 권한 있는 재개의 현재 경로, 정산에 필요한 입력, 세 기준선의 관측값 또는 미관측 사유가 정해지면 S1로 넘어간다. 과거 세션 전수 조사와 별도 계측 도구 제작은 작업 범위 밖이다.

## 3. S1·S2 — Kernel에서 결정하고 어댑터의 판단 삭제

### S1. 기존 정착 경계 연결

- **Report.** `settleVerifiedReport()`가 Step과 현재 계약의 증거를 평가해 생성한 결과를 사용한다. Lease 소유 확인, 보고된 경로와 실제 변경 경로의 검증, `gitCloseoutRequest`에 연결된 report key와 workspace identity를 보존한다. 유효한 closeout 요청이 없는 상태에서 커밋을 생성하지 않는다.
- **독립 리뷰.** Host 실행 계보, Reviewer 독립성, 검토 대상 Revision과 Workspace를 확인한 기존 경로만 Receipt를 수락한다. 현재 구현은 Receipt를 저장한 다음 Judgment Proof를 기록한다. Host는 ingestion 예외를 `incomplete_review_chain`과 빈 Receipt ID로 반환하므로, 수락 이후의 정산 실패가 이 예외 경로로 되돌아가지 않게 한다. 저장된 Review Receipt ID와 해당 Proof를 확인해 빠진 작업만 이어간다. Usage Receipt만 있을 때에는 Review Receipt가 수락된 것으로 처리하지 않는다.
- **재개.** 새 이벤트가 없어도 기존 소유자가 Run에 재접속하면 기존 바인딩·Lease·현재 Workspace를 확인하고 저장된 증거에서 정산을 이어간다. 이미 승인된 부작용을 반복하지 않으며 모델에 빈 보고를 요구하지 않는다. `prepareNext()`에는 전달 복구와 차단된 Run의 재개 동작이 있으므로 모든 호출을 순수 조회로 취급하지 않는다. 읽기 전용 attach·상태 조회에는 완료 승인이나 커밋 권한을 추가하지 않는다.
- **완료.** 현재 계약의 필수 Proof·Judgment와 Step이 충족되고 Finalization까지 끝났을 때 `done`을 반환한다. 보강된 요구를 기존 증거로 입증할 수 없으면 필요한 Proof·Review 또는 차단 근거를 반환한다. `incomplete_gates`의 원인은 `reason`, `unmetGates`, `completionResult`에서 확인한다. 정산 실패와 Reviewer의 실패 판정은 각자의 근거를 유지한다.

### S2. CLI·MCP 삭제와 응답 호환

CLI의 자동 정산 블록, MCP의 `isReadyReportDirective()`와 자동 정산 블록 두 곳을 삭제한다. 같은 조건식을 CLI·MCP가 호출하는 공용 헬퍼로 옮겨 독립 판단을 유지하는 구현은 수용하지 않는다. CLI의 계약·Run 선택, MCP의 Reviewer readiness·dispatch와 `hostReview` 출력은 기존 진입점에 둔다.

같은 상태·권한·능력에서 같은 이벤트가 정착되면 두 진입점의 후속 행동이 일치해야 한다. `next`, `report.next`, `status`, `goalStatus`, `continuation`, `finalization`의 조합이 Kernel 결과와 맞는지 확인한다. 리뷰 후 최신 지시를 읽는 내부 호출은 허용한다. 기존 Report의 재전송은 저장된 Report 결과를 재생하고, 그 안에 남은 과거 `review` 지시로 Reviewer를 다시 실행하지 않는다. [Report 재생 계약](../../../../tests/kernel-report-replay.test.ts) · [Run 수명주기](../../guidelines/moon-relay-kernel-session-run-lifecycle.md)

## 4. S3 — 실행 검증과 인수 기준

| 사례 | 실행 및 합격 조건 |
| --- | --- |
| 정상 Report 및 리뷰 | 필수 의무가 남아 있으면 해당 작업을 반환한다. 마지막 유효 리뷰가 정착되면 기존 권한으로 정산한다. 기준선의 단일 MCP Report가 계속 한 번에 완료된다. |
| **Receipt 저장 직후 중단** | 격리 fixture에서 Receipt 저장 후 Judgment Proof 기록 전, 그리고 Proof 기록 후 정산 완료 전에 각각 중단한다. 새 프로세스가 같은 Review Receipt ID에서 재개한다. Reviewer 추가 실행 0회, 빠진 Proof만 정착, 최종 승인·요청된 Git closeout 각각 최대 1회. 회복 불가능하면 기존 Receipt ID와 실제 차단 사유를 반환한다. |
| **기존 Run의 재접속** | S0의 기준 버전 상태를 후보 버전에서 열어 같은 소유자·세션 권한으로 재개한다. 새 Report·Receipt 없이 정산 가능한 Run이 완료되고 빈 모델 보고는 0회다. 타 Owner·읽기 전용 attach에서는 완료 승인·커밋·Writer 생성이 0회다. |
| 동시 요청·재전송 | 동일 Report·리뷰 결과를 재전송하거나 두 연결에서 동시에 재개해도 같은 작업에 대한 Proof 실행·Reviewer·Writer·승인·커밋이 중복되지 않는다. 원래 Report의 저장된 결과와 현재 Run 상태를 구별한다. |
| 계약 개정과 리뷰 | 원본 Moonremote와 같이 Step 통과 후 보안 리뷰가 대기 중일 때, 같은 Run ID로 Acceptance를 보강해 CLI로 재진입한다. 구현 범위가 같으면 기존 Step ID를 유지한다. 기존 증거로 새 조건을 입증하지 못하면 추가 증거를 요구한다. 실제 범위 변경에는 정당한 Replan을 허용한다. |
| 실패·권한·부분 정산 | Reviewer 실패, Receipt 계보 불일치, Lease 상실, Workspace 변경, 필수 의무 미충족을 각각 발생시킨다. 이전 성공으로 승격하지 않고 해당 원인을 반환한다. 완료 결정이 수락됐어도 Finalization이 미완료라면 공개 응답은 `done`이 될 수 없다. |
| 실제 개발 과제 | S0의 동일 조건을 독립된 작업공간·대화에서 실행한다. 원래 기능·수용 기준·필수 리뷰·최종 상태를 확인하고 모델 관리 왕복을 전후 비교한다. 작업 결과(완료·차단)와 대상 분기의 관측 여부를 따로 기록한다. |

구현 후 저장소 루트에서 빌드와 집중 회귀를 실행한다. 기존 테스트가 중단 지점이나 이전 버전의 재개를 다루지 않으면 해당 경로의 회귀 사례를 기존 테스트 모음에 추가한다.

```sh
npm run build
npm run build:tests
npm run check:boundaries
npm run lint:kernel
node --test tests/kernel-cli-main-contract.test.mjs tests/kernel-bridge-mcp.test.mjs tests/kernel-review-host-bridge.test.mjs tests/kernel-report-replay.test.mjs tests/kernel-session-run-lifecycle.test.mjs tests/kernel-structural-bottleneck-remediation.test.mjs
```

## 5. 최종 판정

| 판단 | 증거와 처리 |
| --- | --- |
| 구조 | diff에서 어댑터의 독자 완료 판단과 자동 정산 호출이 사라지고, Report·리뷰·권한 있는 재개가 기존 Kernel 권위를 사용하면 `STRUCTURE_PASS`. |
| 기능 | S3의 공개 진입점·권한·중단·복구·재전송 검증과 기능 회귀가 통과하면 `FUNCTION_PASS`. 오완료, Receipt 유실, 무권한 변경, 중복 실행 또는 기존 Run의 재개 퇴행은 `REJECT`. |
| 생산성 | 비교 가능한 실제 과제에서 기능과 필수 검증을 보존하고 특정 원인의 추가 **모델** 왕복이 감소하면 `PRODUCTIVITY_PASS`. 시간·토큰·캐시·비용은 관측값만 부기한다. 실패·차단된 실행도 결과에 포함한다. |
| 채택 | 세 항목이 통과하면 `ADOPT`. 구조와 기능만 통과하고 라이브 비교가 미실행이면 `PARTIAL / PRODUCTIVITY_NOT_RUN`. 대상 분기를 거치지 않았으면 `NOT_OBSERVED`. 비교를 실행했고 감소가 없으면 `NO_MEASURED_GAIN`으로 구조 정리 효과만 기록한다. |

## 6. 인수 사례의 출처와 현재 상태

Moonremote 원본 Codex 세션은 `01a1897f-8432-7251-8e1a-aa3498d9b36b`, Kernel Run은 `run-3b323819-76c4-43bb-bdd0-6ffea8d3fc25`다. 2026-10-30 06:38 KST에 `step-3-1`이 통과했고 Report는 `security-review` 대기를 반환했다. 06:41 KST에 기존 Run ID로 계약을 다시 제출하자 `step-4-1`이 생성됐다. 당시 전체 Run의 Replan 수를 이번 변경의 절감량으로 사용하지 않는다.

기존 기록상 `3a6e91b2`와 `8ac626d3`의 격리 재현에서 완료된 Step의 범위를 유지하고 Acceptance 문구를 변경했을 때 Plan 교체가 1회에서 0회로 줄었다. 이 결과는 `8fa428ab`의 RCA-1 회귀 근거다. 당시 집중 테스트는 4/4, 설치 실행 파일 대조는 6/6이었다. 원본 CLI 분기의 완전 재현과 라이브 생산성 비교는 미실행이다. 이 계획의 S0~S3 결과는 구현 작업에서 기록한다. [RCA 회귀 테스트](../../../../tests/kernel-structural-bottleneck-remediation.test.ts) · [이전 구조 개선 결과와 미실행 항목](../codebase-first-harness-2026-11-24/FINAL-RESULT.md)
