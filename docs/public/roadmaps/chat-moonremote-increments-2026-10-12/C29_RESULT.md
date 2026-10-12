# C29 Follow-up 비용 비교와 Adaptive 판정

판정: **Adaptive 미채택. 현재 정책 유지.**

이 판정은 C28의 고정된 단일 case `FOLLOW-UP-001` 실제 실행 결과만 사용한다. 평가 수치로 Kernel authority나 runtime policy를 변경하지 않는다. C28의 raw local evidence root는 Git에 포함되지 않았으므로, 이 문서는 Git에 병합된 `C28_LOCAL_RESULT.md`와 그 문서가 기록한 collector 검증 결과를 입력으로 재집계한다.

## 선행 품질 게이트

세 전략은 동일 F1 시작 상태, Codex CLI 0.162.1, `gpt-5.6-luna`, effort `max`, 동일 common/provider prompt 및 tool 조건으로 실행됐다. C28 collector는 snapshot binding, 순차 reveal, isolation, model/effort, task/source identity를 대조했고 issues가 없다고 기록했다.

성공한 F1~F3 stage는 세 전략 모두 correctness=true, scope violation=0, critical authority violation=0이다. Adaptive는 F1 첫 attempt가 provider 사용량 제한으로 `turn.failed`였고 두 번째 attempt에서 성공했다. 계약에 따라 첫 실패의 시간·token·변경·검증 비용을 총비용에서 제외하지 않는다.

따라서 세 전략 모두 최종 task correctness/scope gate는 통과하지만, Adaptive에는 실패 attempt 1건이 존재한다.

## 재현 집계

아래 값은 `C28_LOCAL_RESULT.md`의 10개 표 행을 strategy와 stage로 다시 합산한 결과다. Token 차원은 서로 합쳐 하나의 점수로 만들지 않는다.

### F1 투자 비용

| 전략 | Attempt / 실패 | Actor ms | Input | Output | Reasoning | Cached | 파일/LOC | 검증 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Verify-only | 1 / 0 | 43,066 | 93,963 | 3,230 | 2,501 | 84,224 | 1 / 1 | 1,744 |
| Always | 1 / 0 | 86,275 | 126,224 | 3,471 | 2,494 | 115,456 | 1 / 1 | 1,593 |
| Adaptive | 2 / 1 | 106,316 | 221,067 | 6,944 | 5,203 | 182,272 | 2 / 2 | 3,404 |

Adaptive F1 값은 실패 attempt와 성공 attempt를 모두 포함한다.

### F2+F3 Follow-up 비용

| 전략 | Attempt / 실패 | Actor ms | Input | Output | Reasoning | Cached | 파일/LOC | 검증 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Verify-only | 2 / 0 | 95,790 | 172,343 | 4,028 | 2,128 | 150,272 | 4 / 16 | 3,480 |
| Always | 2 / 0 | 66,517 | 131,830 | 4,814 | 3,165 | 116,224 | 4 / 20 | 3,113 |
| Adaptive | 2 / 0 | 68,153 | 184,669 | 4,267 | 2,465 | 166,400 | 4 / 16 | 3,445 |

Follow-up actor 시간만 보면 Always가 가장 낮고, Adaptive도 Verify-only보다 낮다. Verify-only 대비 F2+F3 actor 시간은 Always가 약 30.6%, Adaptive가 약 28.9% 낮다.

### 전체 비용

| 전략 | Attempt / 실패 | Actor ms | Input | Output | Reasoning | Cached | 파일/LOC | 검증 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Verify-only | 3 / 0 | 138,856 | 266,306 | 7,258 | 4,629 | 234,496 | 5 / 17 | 5,224 |
| Always | 3 / 0 | 152,792 | 258,054 | 8,285 | 5,659 | 231,680 | 5 / 21 | 4,706 |
| Adaptive | 4 / 1 | 174,469 | 405,736 | 11,211 | 7,668 | 348,672 | 6 / 18 | 6,849 |

Verify-only 대비 총 actor 시간은 Always가 약 10.0%, Adaptive가 약 25.6% 높다. Adaptive는 총 input/output/reasoning/cached token과 검증 시간도 세 전략 중 가장 크다.

## 변동 범위와 누락 데이터

평가 case는 하나뿐이므로 case 간 분산이나 신뢰구간을 계산할 수 없다. 관찰된 전략 범위는 다음과 같다.

- F1 actor time: 43,066~106,316 ms
- F2+F3 actor time: 66,517~95,790 ms
- 총 actor time: 138,856~174,469 ms
- 총 input token: 258,054~405,736
- 총 output token: 7,258~11,211
- 총 reasoning token: 4,629~7,668
- 총 cached token: 231,680~348,672
- 총 changed LOC: 17~21
- 실패 attempt: 0~1

C28은 실제 provider token 차원의 누락이 없다고 기록한다. 원격 환경에는 raw local receipt/isolation evidence가 없으므로, C29에서 원본 receipt를 독립 재검증하지는 못했다. Git에 병합된 C28 결과 문서의 집계와 collector 판정을 재현했다.

## 판정

Adaptive는 **채택하지 않는다**.

근거:

1. correctness와 scope는 최종적으로 통과했지만 Adaptive에 실제 실패 attempt 1건이 있었다.
2. Adaptive의 F2+F3 actor 시간은 Verify-only보다 낮았지만 Always보다 높았다.
3. 실패 비용을 포함한 Adaptive 총 actor 시간은 세 전략 중 가장 높았다.
4. Adaptive 총 input/output/reasoning/cached token과 verification time도 세 전략 중 가장 높았다.
5. 평가 case가 하나뿐이므로 follow-up 단계에서 관찰된 이득을 일반적인 이득으로 확장할 근거가 없다.
6. Follow-up Evaluation Contract는 Adaptive 이득이 없거나 불확실하면 기존 정책을 유지하도록 요구한다.

Always도 이 카드에서 채택하지 않는다. Always는 F2+F3 시간과 일부 token 차원에서 이점이 있지만, 총 actor 시간은 Verify-only보다 높고 단일 case만으로 정책을 교체할 근거가 부족하다.

따라서 **현재 정책을 변경하지 않는다.** 새 Adaptive policy, execution class, workflow stage, always-on agent, prompt fork 또는 Kernel authority를 추가하지 않는다.

## 후속

C29 완료 후 W10 C30에서 projection interoperability의 실제 consumer와 가치가 있는지 별도로 판정한다. 이 C29 결과는 projection 구현을 정당화하지 않는다.
