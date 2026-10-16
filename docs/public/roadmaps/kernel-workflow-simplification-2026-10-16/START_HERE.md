# Moonremote 실행 요청

계획 폴더:

`docs/public/roadmaps/kernel-workflow-simplification-2026-10-16`

## W0 시작 요청

```text
/moonremote C:\dev\moonshot-relay 에서 Kernel Relay 실사용 워크플로우 단순화 W0 작업을 진행해줘.

계획 문서:
docs/public/roadmaps/kernel-workflow-simplification-2026-10-16/README.md
진행표:
docs/public/roadmaps/kernel-workflow-simplification-2026-10-16/STATUS.md

먼저 정확한 MCP workspace에서 get_work_context를 호출하고 현재 HEAD, branch, working tree, upstream 상태를 확인해.
활성 continuity task가 있으면 같은 taskId를 사용하고, 없을 때만 W0 목표로 checkpoint를 만들어.

이번 요청 범위는 README의 W0뿐이야.
W1 이후 구현은 시작하지 마.

W0는 제품 동작 변경이 아니라 안전 기준선과 characterization을 고정하는 작업이야.
현재 동작 중 보존해야 하는 session source-selection, changedPaths authority, canonical next 준비, verification reuse, telemetry 의미를 테스트로 고정해.

특히 다음을 지켜:
- explicit --session-id가 있을 때 CODEX_THREAD_ID를 resolver 후보에서 제외하는 현재 정책을 보존.
- non-Git의 나쁜 omission 동작이 있다면 영구 계약으로 굳히지 말고 W1 수정 대상으로만 characterization.
- 새 fallback, provider/project hardcoding, 새 Authority, 새 registry를 만들지 마.
- 생성 JS를 직접 수정하지 말고 TypeScript 원본과 테스트를 수정한 뒤 build로 생성해.
- 관련 focused tests와 필요한 build check만 실행하고, 매 단계마다 전체 test suite를 반복하지 마.

완료하면 STATUS.md를 갱신하고 실제 diff에 맞는 상세 한국어 commit message를 작성해.
W0 변경만 commit하고 origin에 push한 뒤 remote parity를 확인해.
push/parity까지 성공해야 W0 COMPLETE야.
다음 Wave는 자동 시작하지 마.
```

## 다음 Wave 요청

```text
/moonremote C:\dev\moonshot-relay 에서 같은 계획의 WN 작업만 진행해줘.
WN은 내가 지정한 실제 Wave 번호로 해석해.

먼저 get_work_context, STATUS.md, 현재 Git 상태를 확인해.
이전 Wave의 commit/push/remote parity와 선행 조건이 모두 만족됐는지 확인해.
완료한 변경과 검증을 반복하지 말고 현재 Wave의 미완료 단계부터 진행해.

README의 해당 Wave 범위만 구현해.
구조적 해결을 우선하고 다음 방식은 사용하지 마:
- 특정 프로젝트/provider/model 하드코딩
- 오류별 ad-hoc fallback
- 구/신 경로 병렬 compatibility layer
- Host와 Kernel의 동일 policy 중복
- 기존 기능을 재사용할 수 있는데 새 subsystem 추가

관련 focused tests로 Wave를 검증하고, 필요할 때만 build/typecheck/boundary check를 추가해.
Wave 종료 시 STATUS.md를 갱신하고 상세 한국어 commit message로 Wave 변경 하나만 commit해.
origin에 push하고 remote parity를 확인한 뒤 checkpoint를 갱신해.
push/parity가 불명확하면 다음 Wave로 넘어가지 마.
다음 Wave는 자동 시작하지 마.
```

## 모든 Wave 순차 진행 요청

사용자가 명시적으로 연속 진행을 원할 때만 사용한다.

```text
/moonremote 같은 계획의 남은 Wave를 선행 조건 순서대로 진행해줘.

각 Wave를 독립 작업 단위로 취급해.
Wave마다 반드시:
현재 상태 확인
→ 구현
→ focused 검증
→ 구조 복잡도 리뷰
→ STATUS 갱신
→ 한국어 상세 commit
→ push
→ remote parity 확인
순서로 닫은 뒤 다음 Wave로 넘어가.

한 Wave가 BLOCKED면 임시 fallback이나 하드코딩으로 우회하지 말고 거기서 중단해.
W4 semantic equivalence가 통과하지 않으면 W5를 시작하지 마.
W6/W7은 README의 진입 조건이 실제로 충족될 때만 구현해.
최종 W8 전까지 전체 broad suite를 매 Wave 반복하지 마.
```

## 끊긴 작업 재개 요청

```text
/moonremote 기존 Kernel workflow simplification 작업을 이어가줘.

먼저 get_work_context로 현재 taskId, revision, running/prepared/unknown execution을 확인해.
prepared/running/unknown 실행을 새 operationId로 반복하지 마.
기존 sessionId와 nextSeq로 결과를 조회하고, 파일 편집은 현재 diff를 확인한 뒤 필요한 변경만 해.

STATUS.md와 현재 Git HEAD/remote parity를 대조해 마지막으로 완료된 Wave와 현재 미완료 Wave를 판정해.
완료한 Wave의 코드·검증·commit을 반복하지 말고 미완료 단계부터 이어가.
```
