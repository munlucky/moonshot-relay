# W0 T42-B2-B — 분리 Host Canonical 결과의 Owner CAS 직후 물리 Host 종료

- 작성일: 2026-11-04
- 기준 소스: main / 5169e0056cdf84616306381e4b817256749417f7
- 범위: 기존 T24/T42-B2-A 통합 회귀 테스트 파일의 동기식 Worker 시험 경계
- 판정: 검증 중. Native Writer 자동 합류 비활성화, G0 PARTIAL / W1 DEFER.

## 위협 모델

T42-B2-A는 서로 다른 과거 Host의 동기식 Worker 결과를 기존 Owner Fence 아래에서 합쳐 Owner CAS 0→1과 Canonical Report 2건을 정착했다. 하지만 CAS 직후 Report 전에 복구 Host OS 프로세스가 종료되면, 다른 Host가 이전 Commit/Report를 다시 자동 적용하거나 새 Worker를 시작해서는 안 된다.

이번 시험은 기존 T38의 일반 CAS 중단 계약을 T42-A에서 서로 다른 Host가 생성했던 Canonical Worker 결과에 직접 적용한다. 기존 실측 두 Host가 물리적으로 끝난 상태에서 세 번째 복구 Host가 새 Integration Worktree에서 두 Result Commit을 조합하고 Owner CAS까지만 수행한 뒤 실제 프로세스가 종료 코드 73으로 종료된다.

## 시험 순서 및 성공 조건

1. 두 기존 Host의 실제 OS 프로세스와 동기식 파일 쓰기 Worker가 종료됐다. Canonical Step Attempt 2건은 started이며 Git Result Commit/Report는 기록됐지만 Run Owner Revision은 0이다.
2. 세 번째 별도 Host가 기존 Owner Fence를 첫 cherry-pick 전에 획득한다. Canonical Git Result를 재조회하고 새로운 Integration Worktree에서 동일 Patch 및 Trusted Proof를 검증한다.
3. 기존 Kernel Owner CAS로 Revision 0→1을 저장한 뒤 Marker 파일에 CAS 상태·Attempt 상태·Fence Token을 동기식으로 기록하고, **한 건의 Report도 정착하기 전에 물리 Host 프로세스를 73으로 종료**한다. 종료 과정에서 Host의 Fence를 해제하는 정상 finally는 호출하지 않는다.
4. 네 번째 새 OS Host가 recoverPendingDeliveryMaterialization을 호출한다. Run이 delivery_materialization_recovery_required로 blocked 처리돼야 하며, Revision 1, Attempt started 2건, 재실행 가능한 Step 0개를 유지한다.
5. 다섯 번째 새 OS Host가 다시 조회해 동일 상태가 유지되고 Canonical Result 재소비가 거부되는지 확인한다.
6. 기존 T24의 두 복구 Host Fence 경쟁, 높아진 Epoch·stale Token 거부, 기존 T37/T38의 Fence 만료·CAS 중단 범위도 회귀 확인한다.

## 결과 표

| 항목 | 상태 |
| --- | --- |
| Linux TypeScript 및 제품·테스트 빌드 | **PASS** (operationId=c15140a9-2793-4d93-98d9-3f11a8b38a02) |
| Linux 두 Host 결과→세 번째 Host CAS 강제 종료→새 Host Recovery 차단 | **PASS**. 집중 4 PASS / 0 FAIL. 실제 별도 Host exit 73, 새 Host Recovery blocked 및 재조회 불변 |
| Linux 확대 회귀·경계 | **38 PASS / 5 OS SKIP / 0 FAIL**, 경계 **9 modules / 313 files / 855 edges PASS** (operationId=2cbe8bcb-ad14-4d0f-9e7a-16c099245fa6) |
| 실제 macOS 한정된 동기식 Fixture의 Host 중단과 OS Scoped Proof | 검증 전 |
| 임의 Native Writer 후손 종료·자동 Owner Delivery 권한 | 미검증·비활성화 |

## 별도 미완료 안전 조건

이번 시험은 OS 종료가 명확한 동기식 시험 Writer의 중단·복구 경계에만 적용된다. 서로 다른 두 복구 Host가 실제 cherry-pick 전에 동시에 경쟁하고 한 Host만 CAS를 적용하는 전체 흐름, Fence 만료의 실제 후손 늦은 쓰기, 모든 Native Writer 후손의 물리 종료/영구 OS 쓰기 차단은 별도 조건이다.

기본 Dispatcher, 제품 CAS/Report 코드, 기존 Writer 예약/Worktree 보존은 변경하지 않는다. DB·Queue·Scheduler·Provider별 폴백·OS 프로세스 감시 서비스를 추가하지 않는다. G0 PARTIAL / W1 DEFER.
