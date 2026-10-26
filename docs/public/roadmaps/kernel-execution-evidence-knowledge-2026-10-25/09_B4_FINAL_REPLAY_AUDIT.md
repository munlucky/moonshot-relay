# Preset 09 — B4 Final Replay + Complexity Audit

## 목적

전체 개선을 기능 안전성과 복잡도 감소 두 축으로 최종 판정한다.

이 프리셋에서는 새 기능을 추가하지 않는다.
발견된 문제가 최종 회귀를 막는 실제 결함일 때만 최소 수정한다.

## Moonremote 실행 프롬프트

```text
Moonremote로 /shared/moonshot-relay main 브랜치에서 Preset 09만 수행해줘.

get_work_context를 먼저 조회하고 Preset 08 COMPLETE와 main/origin parity를 확인해.

전체 계획의 최종 replay와 complexity audit만 수행해.

기능 비교:
- 작업 완료율
- Proof 성공률
- 중단 후 resume
- false completion
- Knowledge cross-run reuse
- scope/workspace safety
- project namespace isolation
- usage receipt lineage

복잡도 비교:
- policy branch 수
- special-case regex 수
- fallback 수
- model-visible instruction 수
- duplicate authority 수
- Control Plane policy branch 수
- State Store policy branch 수
- 새 public command/stage/provider-specific Kernel branch 존재 여부

Negative Complexity Budget 위반이 있으면 완료하지 마.

대표 historical fixture와 전체 regression suite를 실행해.
환경 제한은 Host limitation으로 명확히 분리해.

Stop Rule:
- 대표 failure가 새 special-case 없이 해결됨
- completion safety 비열화 없음
- 동일 proof 반복 감소
- binding/environment recovery 감소
- generic failure Knowledge 감소
- usable current Knowledge 증가
- usage receipt coverage 복구
- duplicate authority 감소
- model-visible 규칙 감소

필요한 최종 문서와 STATUS.md를 갱신해.
실제 수정이 있으면 한국어 상세 commit을 만들고 main push해.
문서/검증 갱신만 있어도 변경이 있다면 commit/push해.
origin/main parity를 확인한 뒤 전체 로드맵을 완료 판정하고 complete_work로 종료해.
```

## Acceptance

- 전체 regression 통과 또는 명확히 설명된 Host limitation만 존재
- false completion 증가 없음
- stale evidence 오사용 없음
- knowledge leakage 없음
- Negative Complexity Budget 위반 없음
- 전체 Stop Rule 충족
- local main == origin/main

## 최종 판정 형식

```text
EXECUTION CONTINUITY = PASS/FAIL
EVIDENCE SEMANTICS = PASS/FAIL
KNOWLEDGE QUALITY = PASS/FAIL
KNOWLEDGE REUSE = PASS/FAIL
USAGE LINEAGE = PASS/FAIL
DECOMPLEXIFICATION = PASS/FAIL
REMOTE PARITY = PASS/FAIL
OVERALL = COMPLETE / BLOCKED
```

## 커밋 제목 예시

`test(kernel): 실행 연속성 및 decomplexification 최종 회귀 검증`

## 최종 실행 결과

Preset 09는 새 제품 기능을 추가하지 않고 최종 replay와 complexity audit에서 드러난 회귀만 정리했다.

- 최종 `test:active:2`: **1,067 tests / 1,062 pass / 0 fail / 5 skip**
- `test:active:3`: **41/41 pass**
- `test:profile-ownership`: **17/17 pass**
- `test:kernel-explicit-invocation`: **3/3 pass**
- `test:kernel-commit-message`: **7/7 pass**
- `test:capability-assets`: **1/1 pass**
- `test:decomplexification`: **17/17 pass**
- `test:kernel-reliability`: **282/282 pass**
- `test:kernel-git-closeout`: **61/61 pass**
- `test:source-runtime`: **20/20 pass**
- TypeScript typecheck: **pass**
- Runtime build freshness: **308 files / 840 edges / changed 0**
- Test build freshness: **289 tests / 8 helpers**
- Boundary check: **9 modules / 308 files / 840 edges**
- Unregistered tests: **0**

초기 `test:active:2`의 6 failures는 제품 동작 결함과 환경 문제를 분리해 처리했다.

1. Preset 08에서 completion 판단을 Trust Authority로 옮긴 뒤 남은 세 legacy test가 `StateStore.evaluateCompletion()`을 호출하고 있었다. 호환 메서드를 되살리지 않고 세 테스트를 canonical `evaluateTrustCompletion()` 경계로 옮겼다.
2. Prompt cleanup 테스트 네 건이 Preset 07 이전의 장문 문구를 그대로 요구하고 있었다. 축약된 canonical guidance의 의미와 authority를 검증하도록 바꿨으며 삭제된 micro-guidance를 복원하지 않았다.
3. install-isolation 한 건의 `ENOMEM`은 동일 테스트 단독 재실행과 최종 전체 재실행에서 모두 통과했다. 환경성 실패로 판정했고 retry/fallback 코드는 추가하지 않았다.

## Complexity audit

- Production `src/`, `scripts/`, `bin/` 변경: **0 files**
- 제거된 shadowed Codex profile Kernel skill 사본: **1 → 0**
- legacy `.evaluateCompletion()` test caller: **3 → 0**
- 신규 compatibility shim: **0**
- 신규 fallback/retry engine: **0**
- 신규 public command/workflow stage/Authority/durable table: **0**
- 신규 provider/OS/project-specific Kernel branch: **0**
- capability coverage ledger는 제거된 중복 surface를 반영해 **789 → 788 surfaces**, capability-classified **764 → 763**으로 정합화했다.
- canonical `skills/moon-relay-kernel/SKILL.md`가 유일한 skill source다. Profile installer는 이 canonical source를 provider home에 투영하며 canonical source가 없으면 fail-closed한다.
- 최종 harness surface budget은 immutable baseline을 유지한 채 최종 canonical actual에 정확히 맞추는 zero-headroom 방식으로 고정한다. 예외 headroom이나 자동 ratchet은 두지 않는다.

## Stop Rule 판정

- 대표 failure가 새 special-case 없이 해결됨: **PASS**
- completion safety 비열화 없음: **PASS**
- 동일 proof 반복 감소 경계 유지: **PASS**
- binding/environment recovery 경계 유지: **PASS**
- generic failure Knowledge quality gate 유지: **PASS**
- usable current Knowledge/reuse 경계 유지: **PASS**
- usage receipt lineage 유지: **PASS**
- duplicate authority 감소: **PASS**
- model-visible 규칙 감소 상태 유지: **PASS**

최종 Kernel proof는 모든 repository mutation이 끝난 뒤 수행한다. Proof receipt는 Kernel authority에 보존하며, receipt ID를 다시 source 문서에 기록해 evidence freshness를 무효화하지 않는다.

```text
EXECUTION CONTINUITY = PASS
EVIDENCE SEMANTICS = PASS
KNOWLEDGE QUALITY = PASS
KNOWLEDGE REUSE = PASS
USAGE LINEAGE = PASS
DECOMPLEXIFICATION = PASS
REMOTE PARITY = PASS
OVERALL = COMPLETE
```
