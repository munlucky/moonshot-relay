# W3-B 결과 — 승인 후 Git 전달·Identity 사용 지점 복구

- 기준: `main / 9d8003eaac7cd39d963f026b83876c56641029ed` (W3-A 독립 종료).
- 작업 추적: `9c36d2da-18d8-4b56-a186-ea58d97296e5`.
- 판정: **PASS / keep-baseline (격리 승인·재시작·Identity 사용 지점 회귀 범위)**. 생산 코드를 수정하지 않았다. W3-A의 승인 전 실제 파일 반영 결과와 별개다.

## 코드 소유권 경계

- `src/kernel/control-plane.ts`는 보고서 Operation ID·영속 Checkpoint·`gitCloseoutReceipt`·`verifiedWorkspaceIdentity`·현재 Workspace 관측을 대조한다. 승인된 동일 Commit SHA의 Git closeout 상태가 맞고 작업 트리가 clean일 때만 재시작 후 같은 Operation을 이어간다.
- `src/kernel/git/closeout.ts`와 Host `src/host/kernel/git/closeout-operations.ts`는 **명시적 approvalReceipt**, 승인된 commit 생성, push/retry, remote parity, index 보호를 수행한다. 승인 후 쓰기와 영속 결과를 새 권위로 복제하지 않는다.
- Knowledge 및 Projection 등의 후속 처리는 승인 코드 전달과 별도다. **필수** Knowledge가 미완료면 전체 완료로 둔갑하지 않아야 한다. 필수가 아닌 Knowledge 후속 실패는 승인된 코드를 되돌리거나 Git closeout을 중복 실행해서는 안 된다.
- W8의 Host Session 수명·Project Identity **원천 정책**은 W3-B에서 변경하지 않는다. 여기서는 승인된 Identity를 **사용하는 지점**의 실패·재시작만 검사한다.

## 격리 실제 실행 검증

| 검증 묶음 | 주요 확인 범위 | 결과 |
|---|---|---|
| `kernel-git-closeout-retry`, `kernel-report-replay`, `kernel-finalization-knowledge-nonblocking`, `kernel-report-identity-migration` | 실제 로컬 bare Git 원격 push 실패→재시도, 승인 commit SHA 재사용·중복 커밋 0, `commit_created`와 `completed` 시점 crash 후 보고서 재전송, 외부 index/파일/HEAD 변경 거부, 필수/선택 Knowledge 후속 분리, report identity migration | **24/24 PASS** |
| `kernel-project-identity` 선택 검사 | Identity preflight, linked worktree, 기존 namespace 승인 채택, 동일 repository split 승인 수리, Git 공통 디렉터리·Root 철자만으로 소유권 병합 금지, 기존 Git 증거 충돌 거부 | **9/9 PASS** |
| `kernel-git-closeout-safety`, `kernel-git-closeout-e2e`, `kernel-git-closeout-index-integrity`, `kernel-git-remote-parity` | staging·Git 경계·index 무결성·실제 commit/remote parity | **6/6 PASS** |
| `kernel-git-closeout`, `kernel-git-initial-closeout`, `kernel-finalization-lifecycle` | 승인 없을 때 거부, 초기 HEAD/첫 push, 기존 사용자 index 보존, Partial 최종 처리에서 동일 커밋 재시도, 증명 실패 시 Git 반영 금지 | **14/14 PASS** |

**합계: 53/53 PASS.** 모두 임시 Git 저장소·로컬 Test Remote·격리 HOME/Runtime/TMPDIR을 사용했다. 실제 GitHub 원격의 승인된 제품 커밋이나 운영 namespace를 임의로 생성·수정하지 않았다. Git 테스트에서 확인한 성공은 독립된 **테스트용 approvalReceipt**의 경로이며, 운영 승인 자체를 대신하지 않는다.

## C09~C11 판정과 미검증

- **C09:** 완료 승인 이후 commit 재사용, push 실패 재시도, 지연된 결과 저장 및 실제 Git drift 거부가 격리 테스트로 재현됐다. **already_fixed / keep-baseline**.
- **C10:** 필수 Knowledge는 미완료 시 전체 최종 완료가 아니며, 선택적 Knowledge 실패와 Projection 실패는 승인 코드를 지우지 않는 동작이 검증됐다. **already_fixed / keep-baseline**.
- **C11:** 승인 후 Identity 사용 지점에서 alias 충돌·임의 namespace 병합 방지 검증이 통과했다. 그러나 운영 계정의 실제 repair/adopt 승인 상태와 native Host 별 Project Identity 원천 데이터는 **W8 소유**로 미검증. W3-B 결과로 운영 데이터를 합치거나 삭제하지 않는다.

## 결론과 이관

이 범위에서 잘못된 승인 후 Git 중복 전달, 불완전한 Receipt 성공 표시, Identity drift 허용은 재현되지 않았다. 기존 제품 코드·SQLite 스키마·Host별 fallback·추가 승인 Gate를 바꿀 근거가 없다. 따라서 **W3-B PASS / keep-baseline**으로 판정한다. 다만 운영 계정의 필수 승인 대기 및 운영 대상 데이터 정리 여부는 별도 Wave(특히 W5-B/W8)의 범위·책임에 따라 `PARTIAL` 또는 외부 소유로 판정해야 한다. 이 문서의 격리 테스트 PASS로 전체 W0~W10 `COMPLETE`를 선언하지 않는다.
