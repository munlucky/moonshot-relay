# Prompt Diet 최종 판정과 실패 사례 분석

판정일: 2026-10-19. 최종 결정: **keep-baseline**.

## 적용 결정

- Production은 `buildModelVisiblePromptMessage()`를 계속 사용한다.
- Compact candidate는 evaluator-only 자산으로 유지한다. 이번 후속 작업에서 수정하지 않았다.
- Guidance ablation은 실행하지 않는다. 추가 A/B, case별 문구, 모델별 분기, conditional prompt rule도 추가하지 않는다.
- Fixture 개선 커밋 `c924388b35b084693b4cc09a49314f741bf7a043`을 main에 fast-forward로 반영했다. Candidate 채택과 분리한 변경이다.

## 평가 근거

Fixture 개선 후 같은 커밋에서 6개 case를 arm별 2회 실행했다. 순서는 case별 baseline, candidate, candidate, baseline이다. 공식 실행은 총 24회다. 모델 설정은 `gpt-6-luna / medium`이다.

| 지표 | Baseline | Candidate |
|---|---:|---:|
| Task success | 12/12 | 11/12 |
| Acceptance 만족 | 12/12 | 11/12 |
| Scope violation | 0 | 1 |
| Rework | 0 | 3 |
| Unsupported verification | 0 | 0 |

기존 evaluator의 결과는 `rejected-quality / keep-baseline`이다. Quality gate가 실패했으므로 rework gate와 efficiency gate는 `not-evaluated`다. Token 또는 latency 수치는 채택 근거로 사용하지 않는다.

공식 실험 이전에 중단한 실행 8개는 별도 보존했다. 이 실행들은 공식 24회에 포함하지 않았다. 공식 실험에서 실패 실행을 제외하거나 재시도하지 않았다.

## 실패한 실행

대상은 `PROMPT-EVAL-002`, candidate 반복 1, attempt 1이다. 작업은 `DEFAULT_LIMIT`을 `REQUEST_LIMIT`으로 바꾸는 것이다. 허용 경로는 `src/config.ts`와 `src/consumer.ts`다.

관측한 실행 순서는 다음과 같다.

1. 모델이 PowerShell에서 `Set-Content -NoNewline $p 'export const REQUEST_LIMIT = 20;'` 형태의 위치 인자를 사용했다. 실제 결과에서는 경로와 내용이 뒤바뀌었다. Root에 `export const REQUEST_LIMIT = 20;`라는 파일이 생겼고, 내용은 `src/config.ts`였다. Consumer를 쓰는 같은 방식의 명령도 경로 오류로 실패했다.
2. 첫 `npm run test:config`가 assertion 오류로 실패했다. Fixture 또는 dependency 누락 오류는 없었다.
3. 모델이 native patch로 consumer만 수정했다. 두 번째 검사도 아직 바뀌지 않은 config 때문에 실패했다. 함께 실행한 `git diff`는 seed workspace에 Git 저장소가 없어서 실패했다.
4. 모델이 config를 읽고 native patch로 수정했다. 세 번째 검사는 통과했다.
5. 최종 응답에는 source 두 파일의 수정과 검증 성공만 보고했다. 추가 파일은 발견하거나 제거하지 않았다.

최종 delta는 허용된 두 source 파일과 추가 root 파일 하나다. `src/unrelated.ts`, fixture 검사 파일, package.json은 그대로다. Source 동작 검사는 통과했지만 전체 변경 범위 검사는 실패했다. 따라서 scope violation 1건은 유효하다.

직접 확인한 실패 메커니즘은 **잘못된 shell 파일 쓰기와 불완전한 최종 scope 확인**이다. 일반화할 수 있는 지식은 기능 검사 성공만으로 변경 범위 준수를 증명할 수 없다는 점이다. 이 관측을 근거로 candidate에 특수 지침을 추가하지 않는다.

## Compact 의미 보존과 인과 해석의 한계

실패 case의 baseline과 candidate `message.txt`를 직접 비교했다. `MODEL VISIBLE CONTEXT` 뒤의 JSON을 파싱한 결과, 다음 6개 field가 모두 같았다.

- `objective`
- `acceptance`
- `constraints`
- `currentWork`
- `relevantProjectKnowledge`
- `requiredEvidence`

두 arm 모두 허용 경로 두 개, `docs/**`와 `src/unrelated.ts` 금지 경로, acceptance, `npm run test:config` 명령을 보존했다. 이 case의 guidance는 두 arm 모두 빈 문자열이었다. Ablation 결과가 아니다.

Prefix의 범위 지침은 baseline의 “Inspect the current workspace only within the declared work context.”에서 candidate의 “Stay within the declared work context.”로 바뀌었다. Kernel 호출 금지, 위임 금지, 완료 권한 금지, evidence 식별자 준수, JSON 출력 지침도 두 arm에 있다. Candidate는 표현을 줄이고 JSON 들여쓰기를 제거한다.

명시적인 scope 정보가 사라졌다는 증거는 없다. 다만 payload 동일성만으로 행동에 미치는 영향까지 같다고 증명할 수는 없다. Case별 arm당 2회 결과로는 축약이 shell 선택이나 사후 확인을 바꿨는지, 모델 변동으로 오류가 발생했는지 구분할 수 없다. 따라서 “필수 의미 누락” 또는 “단순 변동성” 중 어느 쪽도 확정하지 않는다. 이 한계는 현재 평가 계약의 탈락 판정을 바꾸지 않는다.

## Fixture 변경의 독립 가치

`c924388b`는 `tests/fixtures/kernel-eval/corpus.json`과 `tests/kernel-eval-corpus-contract.test.ts`만 바꾼다. 새 dependency는 없다. 001/002/004/005는 fresh temp workspace에서 원본 assertion 실패와 최소 정상 수정 후 성공을 검사한다. 003/006 seed는 hash로 보존한다.

Fixture 작업의 기존 검증은 focused 51/51, typecheck, build:check, build:tests:check, check:boundaries 및 Kernel `test:active:2` 통과다. A/B 재검증 작업은 Kernel `test:routing`을 통과했다. 이 문서의 후속 작업은 candidate 성능 실험을 다시 수행하지 않는다.

## 근거 식별자

공식 A/B run은 `run-b6290dbe-873f-4af1-944a-0e612cfc453b`다. Fixture run은 `run-0075c9b5-807a-4edf-a0d4-c7d3a99f46ab`다. 두 작업의 canonical continuation은 `action.type=done`이다. 이는 평가 및 fixture 작업의 완료를 뜻한다. Candidate 채택을 뜻하지 않는다.

원본 실행 로그와 workspace는 로컬 실험 디렉터리의 `final-ab/`에 보존했다. 생성 로그, receipt, session은 source package에 넣지 않는다. 다음 SHA-256으로 사용한 근거를 구분한다.

| 파일 | SHA-256 |
|---|---|
| `comparison.json` | `804f545c3ed9a739ec0240be98209c780849cad69496947687164b1688b90d1e` |
| `raw-runs.json` | `bc43c79f1e962cbfe0cfeb778f3f813b3ce24d7355a9de55c0bfa4cf119a1a3c` |
| `scored-runs.json` | `aa643e9afe9f80eabe072170d86ec959f89613fc30d56ab96718c7a65abd0b5e` |
| `audit.json` | `68cd790f95cc8bb217d35b60c9b6e0739a9fda3efb9433c0e5785c9c5341647d` |
| `kernel-report-result.json` | `6b08a25e6d7423dfe07f70f1af1b63133641662036719db9994ce5e87737e6c3` |

`raw-runs.json`은 수집 당시 값을 보존한다. 감사 후 최종 점수는 `scored-runs.json`과 run별 `scored-receipt.json`에 있다. 관측 model/effort는 로컬 CLI session 설정이다. 서버 측 model attestation으로 해석하지 않는다.

외부 task checkpoint revision 14는 사용자 제공 상태다. 이번 로컬 후속 작업에서 외부 checkpoint를 수정하거나 재검증하지 않았다.
