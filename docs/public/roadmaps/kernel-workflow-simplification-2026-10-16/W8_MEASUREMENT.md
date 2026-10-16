# W8 전후 측정 및 Closeout 근거

작성일: 2026-10-16

기준 구현 HEAD: `df3aec6987ecfc3259fa0229846fb78047a308fe`

## 1. 측정 원칙

이 문서는 개선 전 Codex 세션 기록과 W0~W7 이후 현재 코드/지침의 구조적 상태를 대조한다.

중요한 제한:

- 개선 후 일반 앱 실사용 세션은 아직 수집되지 않았다.
- 따라서 아래 baseline 수치를 "개선 후 0회"처럼 해석하지 않는다.
- 실제 감소율은 다음 실사용 세션 export가 있어야 측정할 수 있다.
- 이번 W8에서 확인하는 것은 **개선 전 마찰의 크기**와 **현재 정상 경로에서 해당 절차가 더 이상 필수인지 여부**다.
- `firstMutationAt`는 실제 editor mutation 시각이 아니라 Kernel이 처음 관측한 시각일 수 있다.
- `timeToFirstMutationMs`는 사용자 요청 시점이 아니라 `runStartedAt`부터의 값이다.
- `contractRepairCount`는 오류 수리만이 아니라 현재 구현에서 정상 contract revision도 포함할 수 있다.

## 2. 데이터 범위

원본:

`/shared/Codex-세션내역_2026-10-12_2026-10-16`

타임스탬프 범위:

`2026-10-11T15:00:00Z ~ 2026-10-16T03:36:23.472659Z`

분류:

- 일반 앱: 프로젝트 경로가 `/Users/dev/moonshot-relay`가 아닌 세션.
- Harness 유지보수: 프로젝트 경로가 `/Users/dev/moonshot-relay`인 세션.

전체 기록:

| 항목 | 전체 | 일반 앱 | Harness 유지보수 |
| --- | ---: | ---: | ---: |
| 세션 파일 | 17 | 13 | 4 |
| records | 18,321 | 16,724 | 1,597 |
| custom_tool_call | 1,776 | 1,590 | 186 |
| CommandExecution | 2,257 | 2,073 | 184 |
| failed CommandExecution | 202 | 177 | 25 |
| compacted | 11 | 10 | 1 |

## 3. 일반 앱 baseline friction

실제 `CommandExecution.command`에서 installed Kernel CLI invocation을 분리해 집계했다. 단순 source 문자열 검색 결과를 실행 횟수로 사용하지 않았다.

| 관측 항목 | 개선 전 일반 앱 |
| --- | ---: |
| 실제 Kernel `next` 호출 | 150 |
| 실제 Kernel `report` 호출 | 81 |
| 인접 `report → next` 왕복 | 62 |
| `--contract-json` 사용 | 63 |
| 수동 Contract JSON 편집 관측 | 22 |
| `--previous-recovery-json` 사용 | 8 |
| recovery `--diagnose` | 32 |
| report changedPaths 수동 조립 관측 | 93 |
| Kernel 내부 source read/search 관측 | 91 |

이 수치는 원인별 마찰의 baseline이며 Harness 자체 유지보수 세션은 제외했다.

## 4. W0~W7 이후 정상 경로의 구조적 변화

### changedPaths

개선 전 일반 앱에서 report changedPaths 수동 조립이 93회 관측됐다.

현재:

- authoritative Git owner-direct report는 changedPaths를 기본 입력으로 요구하지 않는다.
- 실제 Git workspace observation이 Authority다.
- 명시적으로 잘못된 claim을 보내면 기존처럼 fail-closed 한다.
- non-Git은 authoritative Git observation이 없으므로 explicit changedPaths를 계속 요구한다.
- isolated worker/parallel receipt의 changedPaths provenance는 유지한다.

따라서 baseline의 93회를 모두 제거했다고 주장할 수는 없지만, **Git owner-direct 정상 경로의 수동 changedPaths 의무는 제거됐다.**

### report → next 왕복

개선 전 인접 `report → next`가 62회 관측됐다.

현재:

- report continuation은 canonical `prepareNext` 경로를 사용한다.
- `kernel_report`는 준비된 canonical `next`를 같은 응답에 반환한다.
- Skill/MCP/ADE-Qwen 지침은 정상 report 직후 별도 `kernel_next`를 요구하지 않는다.
- `kernel_next`는 start, re-entry, explicit refresh, diagnostic 경로로 유지한다.

즉 **정상 report 후 단순 advance를 위한 추가 model-visible 왕복 의무는 제거됐다.**

### Contract wiring

개선 전 `--contract-json` 63회, 수동 Contract JSON 편집 22회가 일반 앱 세션에서 관측됐다.

현재:

- MCP는 기존 object schema의 `contractJson`을 semantic 입력으로 사용한다.
- 모델은 objective, acceptance statements, constraints, nonGoals, 알려진 bounded scope를 제공한다.
- acceptance ID, obligation wiring, digest, revision은 Kernel이 소유한다.
- declared semantic steps는 `AC-*`나 obligation ID를 직접 만들지 않아도 된다.
- unknown scope를 `allowedPaths: []`로 자동 확대하지 않는다.
- CLI `--contract-json`은 stateless/manual CLI 호환 표면으로 유지한다.

따라서 **MCP 정상 경로의 내부 ID/JSON wiring 의무는 제거됐지만 CLI 표면 자체는 보존됐다.**

### Recovery continuity

개선 전 `--previous-recovery-json` 사용이 8회 관측됐다.

현재:

- Host가 process-local continuity로 이전 recovery capsule을 자동 연결한다.
- 기존 Kernel fingerprint, unchangedAttempts, 3회 escalation 규칙을 그대로 사용한다.
- 정상 next/report 이후 continuity를 clear한다.
- owner/lease/scope/safety/proof/completion Authority는 Kernel에 남는다.
- stateless/manual CLI는 명시적 `--previous-recovery-json`을 유지한다.

따라서 **Host 경로의 recovery bookkeeping 의무는 제거됐지만 stateless CLI escape hatch는 유지한다.**

### Kernel 내부 source 탐색

개선 전 일반 앱에서 Kernel 내부 source read/search가 91회 관측됐다.

W1~W7은 changedPaths, continuation, Contract, recovery semantics를 public Skill/MCP 경로에 노출하도록 정리했다. 다만 이 항목의 실제 감소 여부는 post-change 실사용 세션이 있어야 측정 가능하다.

## 5. 제거하지 않은 경로

잔여 검색 결과를 검토했으며 다음은 실제 consumer 또는 안전 의미가 있어 유지한다.

- `buildUnboundNextPayload`: binding이 이미 닫힌 blocked 상태의 original failure projection.
- `acceptanceIdMap`: active model wiring이 아니라 successor contract canonical ID rebasing/strict merge 내부.
- `--previous-recovery-json`: Host가 없는 stateless/manual CLI의 명시적 continuity handoff.
- Host capability 복구 후 explicit `kernel next`: 정상 report advance가 아니라 re-entry/refresh.

이들을 제거하기 위해 새 fallback이나 호환 계층을 추가하지 않는다.

## 6. Broad regression

생성된 `tests/kernel-*.test.mjs`는 277개 파일이다. W8에서는 정렬된 전체 파일을 6개 batch로 나눠 검증했다.

| 파일 범위 | 결과 |
| --- | --- |
| 0~46 | 271 pass / 0 fail |
| 47~92 | 215 pass / 0 fail |
| 93~138 | 177 pass / 0 fail |
| 139~184 | 231 pass / 0 fail / 4 skip |
| 185~230 | 276 pass / 0 fail / 8 skip |
| 231~276 | 267 pass / 0 fail |

전체 Kernel broad set은 **1,437 pass / 0 fail / 12 skip**이다.

추가 closeout 검증:

- `test:kernel-lifecycle`: 65/65 통과.
- `test:kernel-reliability`: 251/251 통과.
- `build:tests`: 284 tests, 8 helpers 생성.
- `build:tests:check`: 284 tests, 8 helpers, removed 0.
- `check:boundaries`: 9 modules, 301 files, 815 edges.
- `typecheck`, `build`, `build:check`, `git diff --check`: 통과.

Broad regression은 세 종류의 정합성 문제와 한 건의 실제 실행 경계 회귀를 드러냈다.

1. non-Git test fixture 두 곳이 changedPaths omission을 사용하고 있었다. 이 fixture들은 실제 Git owner-direct가 아니라 non-Git "변경 없음" 시나리오이므로 `changedPaths: []`를 명시하도록 보정했다. 이는 W1의 Git owner-direct omission과 충돌하지 않고 non-Git explicit-report 계약을 고정한다.
2. W7 Skill 변경 뒤 `package/kernel/skills.lock.json`이 stale했다. 수동 hash 하드코딩 대신 기존 `buildSkillsLock({ scope: 'kernel' })` 경로로 재생성했고 package materialization 검증을 통과했다.
3. W7 Skill 변경 뒤 prompt audit의 byte/line inventory가 stale했다. inventory에 등록된 모든 surface를 실제 파일 기준으로 재계산해 갱신했고 prompt audit 13/13을 통과했다.
4. W4에서 report continuation을 canonical `prepareNext()`로 통합한 뒤, 내부 parallel worker settlement까지 sibling receipt 사이에서 `prepareNext()`를 실행하면서 restart recovery가 정상 in-process Delivery를 미완료/crashed Delivery로 오인했다. provenance 검사를 약화시키지 않고 경계를 수정했다. 개별 parallel settlement는 `next: null`을 반환하고, 모든 sibling receipt가 정산된 batch boundary에서 Host가 canonical `prepareNext()`를 정확히 한 번 실행한다. parallel dispatch/recovery focused suite 16/16이 통과했다.

## 7. 최종 구조 판정

W0~W7 이후 새로 추가된 항목을 검토했다.

- provider/project/model-specific production hardcoding: 없음.
- error-code별 ad-hoc fallback 증가: 없음.
- 새 persistent recovery/contract/session state: 없음.
- 새 workflow engine/session registry/recovery engine: 없음.
- Host/Kernel에 동일 Authority를 중복 저장: 없음.
- model-visible 필수 절차 상태: 감소.
- 기존 owner/lease/scope/baseline/proof/completion fail-closed 경계: 유지.

현재 잔여 복잡도는 실제 consumer 또는 safety/compatibility 의미가 확인돼 있어 추가 삭제 대상이 아니다.

## 8. 후속 측정

다음 일반 앱 Codex 세션 export가 확보되면 동일 분류로 다시 계산한다.

특히 비교할 항목:

1. 인접 `report → next` 왕복.
2. 수동 Contract JSON 편집.
3. `--previous-recovery-json` handoff.
4. Git owner-direct report의 changedPaths 수동 조립.
5. Kernel 내부 source read/search.
6. user request → first observed repository edit.
7. reusable evidence가 존재하는데 동일 proof가 다시 실행된 사례.

6번은 실제 editor mutation 시각을 알 수 없으면 반드시 "first observed edit"로 표기한다. 7번은 obligation, contract revision, exact evidence identity, reusable success evidence, explicit fresh/flaky 조건을 모두 고려해 판정한다.
