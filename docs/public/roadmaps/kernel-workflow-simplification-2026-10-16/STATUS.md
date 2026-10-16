# Kernel Relay 실사용 워크플로우 단순화 진행표

계획 검토 기준 HEAD: `09f452bfc8ef241040233078903555c73a7be62f`

W0 시작 기준: planning commit/push 이후 실제 current HEAD를 `baseHead`로 기록한다.

계획 상태: READY_FOR_IMPLEMENTATION

이 파일은 작업 인덱스다. Moonremote checkpoint, Kernel completion authority, Git remote parity를 대체하지 않는다.

허용 상태:

- `NOT_STARTED`
- `IN_PROGRESS`
- `BLOCKED`
- `COMPLETE`
- `VERIFIED_EXISTING`

## Wave 상태

| Wave | 목표 | 선행 | 상태 | Commit | Remote parity |
| --- | --- | --- | --- | --- | --- |
| W0 | 안전 기준선과 characterization | 없음 | NOT_STARTED | - | - |
| W1 | Git owner-direct changedPaths 정합화 | W0 | NOT_STARTED | - | - |
| W2 | Session source-selection/binding 경계 | W1 | NOT_STARTED | - | - |
| W3 | Verification/report 사용 경로 | W2 | NOT_STARTED | - | - |
| W4 | canonical next preparation 통합 | W3 | NOT_STARTED | - | - |
| W5 | model-visible next 왕복 제거 | W4 equivalence 통과 | NOT_STARTED | - | - |
| W6 | semantic Contract 입력 | W5 | NOT_STARTED | - | - |
| W7 | Recovery continuity mechanics | W6 + 필요성 확인 | NOT_STARTED | - | - |
| W8 | 전후 측정·통합 검증·잔여 단순화 | W7 또는 VERIFIED_EXISTING | NOT_STARTED | - | - |

## Wave 결과 기록 템플릿

각 Wave 종료 시 아래 블록을 복사해 채운다.

```text
wave: Wn
status: COMPLETE / BLOCKED / VERIFIED_EXISTING
workspace:
baseHead:
resultHead:
taskId:
kernelRunId: 있으면 기록, 없으면 없음
scope:
acceptance:
checks:
structuralReview:
  hardcoding:
  fallback:
  duplicatedAuthority:
  newAbstraction:
commit:
push:
  remote:
  branch:
  remoteHead:
  parity:
remaining:
nextWave:
```

## 구조 리뷰 판정 규칙

다음 중 하나가 새로 생겼는데 제거 근거가 없으면 Wave를 COMPLETE로 표시하지 않는다.

- provider/project/model-specific hardcoding.
- error-code별 ad-hoc fallback.
- 구/신 경로 병렬 compatibility layer.
- Host/Kernel policy duplication.
- 새 persistent state 또는 registry.
- model-visible field 증가.
- 기존 Authority와 동일한 두 번째 Authority.
- 테스트를 통과시키기 위한 production special case.

## Push 완료 조건

Wave 완료는 로컬 commit 생성만으로 끝나지 않는다.

다음을 확인한다.

1. commit hash 생성.
2. push 성공.
3. `git ls-remote` 또는 동등한 방식으로 remote branch hash 확인.
4. remote hash == local HEAD.
5. working tree에 예상하지 않은 변경 없음.
6. checkpoint에 commit/push evidence 기록.

push가 불명확하면 다음 Wave로 넘어가지 않는다.
