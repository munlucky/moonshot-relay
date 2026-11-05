# T49 P4–P5 최종 수용 범위 — 기술안전 HOLD_SAFE

- 작성: 2026-11-05 KST
- 기준: `712185c1` (소스), [증거 매트릭스](T49_PARALLEL_EVIDENCE_MATRIX.md), [P2 결정](T49_DECISION.md)
- **계획 검증 종결 판단:** P2 `HOLD_SAFE`, Native 자동 결과 합류 **미채택**.
- **제품 기능 완료 판단:** G0 및 의존 Gate 미통과. 따라서 G6 최종 제품 채택 PASS가 아니다.

## Gate 수용 판정

| Gate/Wave | 판정 | 확인된 범위와 남은 조건 |
| --- | --- | --- |
| G0 / W0 | PARTIAL | T23 ContextReceipt SOURCE PASS; T39–T48 Native OS/FS 반례로 일반 Writer 종료/미래 쓰기 차단 미증명 |
| G1 / W1 | DEFER | Owner/Native Writer 안전 합류 미증명, 자동 예약 해제·중복 실행 금지 유지 |
| G2 / W2 | DEFER | 실제 Worker 권위 수명과 연결된 status/signal/approval/cancel 전체 계약 미검증 |
| G3 / W3 | DEFER | 실제 Native Worker와 기존 Kernel loop·Goals/Dispatcher 단일 권위 통합 미검증 |
| G4 / W4 | DEFER | 안전한 Native 실행 기반의 E/C/D 장기 세션 비교 불가 |
| G5 / W5 | PARTIAL | 기존 T39–T48 fault/안전 부정 증거 유지. T49 Linux Kernel 집중 회귀 11 PASS/1 FAIL/2 SKIP; 전체 수용 PASS 아님 |
| G6 / W6 | NOT_RUN | 동일 조건 A/B/E/C/D 효율·품질 비교는 G0/G1 안전 선행 조건 미충족으로 실행하지 않음 |

I01–I12, T01–T27의 **원래 계약을 수정하지 않았다**. 각 계약의 Native end-to-end 충족을 새로 확인하지 않은 것은 PASS로 환산하지 않는다. 현재 증거만으로 전 항목 무위반을 주장하지 않는다.

## 플랫폼·기본값

| 환경 | 범위 | 판정 |
| --- | --- | --- |
| Linux WSL2 Node22 | Kernel 단위/동기식 복구 테스트, 일부 OS sandbox capability 제한 | PARTIAL |
| macOS 실제 Native (기존 T39–T48) | App Server initialize·일부 opt-in Scoped Proof 및 분리 후손/하드링크 부정 시험 | PARTIAL |
| Mac MCP 기본 Linux 컨테이너 | Native macOS 실행을 대신하지 않음 | NOT_APPLICABLE |
| Windows Native | 유효한 이번 실행 증거 없음 | DEFER |

기본 Native 자동 cross-Host 결과 합류, 자동 Writer 재시작, 예약 자동 해제, 불확실한 Worktree 청소: **비활성/금지 유지**. 기존 Kernel Trust/Work/Knowledge 완료 권위와 Owner Fence/CAS 변경 없음.

## 검증·성능·복잡도

- `npm run build:tests`: PASS (304 tests / 9 helpers). `npm run build`: PASS (313 production files / 855 edges).
- 불일치 빌드 상태에서의 첫 회귀 1 PASS/4 FAIL/2 SKIP은 근거로 보존하되 제품 FAIL로 즉시 단정하지 않는다.
- 전체 빌드 갱신 뒤 C Lane 집중 3파일 회귀: **11 PASS/1 FAIL/2 SKIP, exit 1**. 이 실패를 PASS로 바꾸지 않는다.
- Native 자동 합류를 구현·측정하지 않았으므로 총비용/품질/지연 개선 수치 없음.
- 새 DB/Queue/Scheduler/Provider-specific fallback/제품 Runtime 상태 변경 **0**.
- 사용자 Mac Checkout/실사용 Codex 계정·DB·예약은 변경하지 않았다.

## 수용 결론

**안전 미증명 기능을 무리하게 출시하지 않는 검증 결론을 채택했다.** 기존 동기식 Kernel 계약의 제한된 성공 증거는 보존하고, Native 일반 자동 재합류는 HOLD_SAFE로 정지한다. 계획상 후속 P3/G6를 미완료라고 숨기거나 성공한 것처럼 처리하지 않는다. 재개 시 필요한 것은 *OS 물리 쓰기 경계 검증*과 *C Lane 남은 회귀 실패의 원인 확인*이다.
