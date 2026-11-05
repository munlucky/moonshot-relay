# T49 P2 기술 결정 — HOLD_SAFE

- 날짜: 2026-11-05 KST
- 소스: `main 712185c15fea3ff406676e81cdae3d553b34df4c`
- 판정: **HOLD_SAFE** (기술안전 검증 결론이며 기능 완료 PASS가 아님)
- 근거: [증거 매트릭스](T49_PARALLEL_EVIDENCE_MATRIX.md), [실행계획](T49_END_TO_END_PARALLEL_VERIFICATION_EXECUTION_PLAN_2026-11-05.md), [STATUS](STATUS.md).

## 결정 근거

1. T39/T40에서 실제 Native App Server 부모·Process Group 종료와 분리 후손 생존의 차이가 확인됐다. 임의 후손 물리 종료 증명은 없다.
2. T44에서는 macOS Sandbox 밖 기존 inode로 연결된 **사전 생성 하드링크 쓰기 100/100**이 가능했다. 경로 기반 Seatbelt 성공만으로 외부 Owner 불변성을 보장할 수 없다.
3. T45/T46에서는 Git-clean Attempt Worktree 재사용 시 기존 하드링크를 발견하지 못하고, 동일 UID 비예약 OS Writer가 fresh/reserved Worktree에 쓸 수 있었다. 협조적 Kernel Reservation은 OS 파일 쓰기 배타성을 뜻하지 않는다.
4. T47에서는 현 WSL2의 namespace 실행이 제한되고, macOS 동일 UID 비참여 Writer는 sandbox/ chmod 경계 밖에서 파일을 변경할 수 있음을 확인했다.
5. T48의 분리 CODEX_HOME App Server `initialize` 성공은 실제 Native Tool/후손의 종료·공통 데이터 보안 검증이 아니다.
6. T49 Linux 재빌드 후 집중 Kernel 회귀는 **11 PASS / 1 FAIL / 2 SKIP**이다. 이 자체로 G0 신뢰 경계를 통과했다고 할 수 없다. 실패 1건은 세부 분석 필요.

## 채택·기각한 대안

- **채택:** 기존 안전 차단 유지. `writerExitVerified:false`, `deliveryAuthorized:false`. Native 자동 합류/예약 자동 해제/불확실한 Worktree 삭제/중복 Worker 재실행 금지.
- **기각:** Process Group 전체 종료만으로 후손 종료를 인정하는 접근, Git clean 및 단발 stat 검사만으로 Physical Worktree 신뢰를 승인하는 접근.
- **미채택:** 새로운 DB, Queue, Scheduler, 상시 감시자, OS별 일회성 예외·Provider 폴백. 이 기능들이 현재 반례의 OS 쓰기 불변식을 증명하지 못한다.
- **제한 적용 유지:** 이미 검증된 macOS opt-in Scoped Proof와 유한한 동기식 Kernel CAS/Report 시험만 원래 적용 범위에서 사용한다. Native 일반 자동 합류로 확대하지 않는다.

## P3/P4/P5 처리

- **P3:** HOLD_SAFE이므로 Native 자동 합류 구현 **NOT_RUN (의도적 미구현)**. 제품 코드 변경 0.
- **P4:** T39–T48 기존 부정/경쟁/복구 증거를 재사용하고 T49 집중 Kernel 회귀 실패를 보존한다. 새 Native 통합 성공 시험은 승인하지 않는다.
- **P5:** G0–G6 및 W1–W6 제품 채택은 [최종 수용 보고서](T49_FINAL_ACCEPTANCE.md)에 미검증/의존관계로 구분한다. 비용 A/B는 안전 Gate 선행 미충족으로 실행하지 않는다.

## 재개 조건

실제 Host가 시작한 Native App Server·Tool·분리 후손의 **지속적인 OS 쓰기 권한**과 **모든 외부 inode alias 및 비협조 Writer**를 Owner 정착 시점까지 보호할 수 있어야 한다. 이를 증명할 수 있는 권한/OS 실행 경계를 먼저 확보한 다음, 같은 기준선으로 Kernel 집중 회귀의 남은 실패 원인을 확인하고 최소 범위를 검증한다. 새로운 폴백이나 검사 규칙을 누적하는 것으로 대체하지 않는다.
