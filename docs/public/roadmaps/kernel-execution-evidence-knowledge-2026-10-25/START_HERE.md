# START HERE — Moonremote 실행 규칙

각 프리셋은 **한 번의 bounded Moonremote 작업**으로 수행한다.

## 1. 시작

항상 가장 먼저:

```text
get_work_context
cwd = /shared/moonshot-relay
```

를 실행한다.

### 활성 task가 없는 경우

현재 프리셋 목표로 `checkpoint_work(mode=create)`를 생성한다.

### 현재 프리셋과 동일한 active task가 있는 경우

새 task를 만들지 말고 기존 task를 재사용한다.

### 다른 목적의 active task가 있는 경우

그 task를 현재 프리셋으로 변경하지 않는다. 완료·abandon 여부를 임의로 결정하지 않는다. 같은 main workspace에서 두 tracked task를 섞지 말고 기존 task 상태를 먼저 정리한다.

## 2. main 확인

실행 전에 다음을 확인한다.

```text
branch == main
HEAD
origin/main
git status --short
running/unsettled process
최근 checkpoint
```

사용자 요구상 새 branch/worktree를 만들지 않는다.

unrelated 변경이 있으면 덮어쓰거나 자동 stash하지 않는다.

## 3. source owner 확인

문서에 적힌 과거 경로를 그대로 믿지 않는다.

현재 TypeScript canonical source와 owner를 먼저 찾는다.

- `src/**`가 canonical이면 generated JS를 직접 수정하지 않는다.
- `scripts/**`, `dist/**`가 generated이면 build로 갱신한다.
- 기존 authority owner가 있으면 새 subsystem을 만들지 않는다.

## 4. 실행 추적

명령 실행에는 항상:

```text
taskId
operationId
```

를 같이 사용한다.

동일 실행의 retry는 같은 operationId와 같은 입력을 사용한다.

`prepared`, `running`, `unknown` 실행을 새 operationId로 반복하지 않는다.

프로세스 조회는 반환된 `nextSeq`를 `afterSeq`로 사용한다. 종료 후 `hasMore=true`이면 남은 output을 모두 읽는다.

## 5. 테스트

각 프리셋은 focused test를 우선한다.

전체 suite는 다음에서만 기본 수행한다.

- 프리셋 06: A단계 historical replay 종료
- 프리셋 09: 최종 replay + complexity audit
- 최종 main merge/완료 판정

환경 문제로 전체 suite를 실행할 수 없으면 Kernel correctness failure로 승격하지 않는다. Host environment limitation으로 기록한다.

## 6. 구조 리뷰

커밋 전에 다음을 확인한다.

- 특정 프로젝트명/OS/provider/오류 문자열 하드코딩 추가 없음
- 새 fallback chain 없음
- 같은 판단을 두 authority가 중복 소유하지 않음
- 새 writable state가 불필요하게 추가되지 않음
- model-visible 규칙 증가 없음
- 구/신 경로 장기 compatibility layer 없음

## 7. Git

각 프리셋은 가능한 한 하나의 독립 commit으로 닫는다.

커밋 메시지는 Conventional Commit 형식을 사용하되 제목과 본문을 한국어로 상세히 작성한다.

push 후 반드시 local HEAD와 `origin/main` parity를 확인한다.

## 8. 종료

프리셋 acceptance가 모두 충족된 경우에만 `complete_work(outcome=completed)`를 호출한다.

남은 단계나 blocker가 있으면 complete하지 않고 checkpoint를 갱신한다.
