# W4 결과 — Proof·Review·Host 증거 연결

- 기준 HEAD: `34ccc4181fe30acdbdf2a95c7165a3e98b3d2622` (W3-B 완료).
- 판정: **SOURCE PASS / keep-baseline**, Linux 격리 범위. Windows/macOS native 필수 실제 Host 결과와 별개다.
- 독립 Reviewer·Host·Receipt·Route·Revision 검증 6개 suite: **66/66 PASS**.
- Proof binding, evidence semantics, 실제 proof process tree, Knowledge freshness 4개 suite: **73 PASS, 1 SKIP, 0 FAIL**.
- 총 140개 항목 중 **139 PASS / 1 SKIP / 0 FAIL**. Skip은 실제 Windows proof timeout clean-up 검사로 Linux에서 Windows Host 성공으로 승격하지 않는다.

## 확인한 경계

- 실제 검증 실패와 증거·Review Receipt 오류는 서로 다른 신뢰 경계다. 검증 실패를 synthetic PASS로 바꾸거나 미입증 프로젝트 명령을 대체하지 않았다.
- 독립 Reviewer의 route/receipt/lineage 무결성 및 protected obligation 우회 방지를 회귀로 확인했다. 기존 Review 강제 정책을 완화하지 않았다.
- 동일 입력의 모든 Proof가 불필요하게 재실행되는 운영 인과는 이번 격리 테스트로 확정되지 않았다. 새로운 캐시·우회·Host별 fallback을 추가하지 않았다.
- 운영 Codex Host에서 별도 Reviewer 세션과 사용량 Receipt가 실제로 제공되는지, macOS/Windows native 세션에서 동일한 독립성이 보장되는지는 추가 Host 관측이 필요하다. 해당 Host 범위는 W8의 환경 검증과 연결한다.

**생산 코드 변경: 없음.** 의무·Review 권위를 중복 구현하지 않고 W4 격리 범위에서는 기존 구현을 유지한다. 다음 W5에서는 동일 실패의 발생 횟수와 승격된 영속 Knowledge를 별도로 계측한다.
