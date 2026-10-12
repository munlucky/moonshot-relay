# Moonremote Chat 모드용 분할 개발 계획

작성일: 2026-10-12 (Asia/Seoul)
상태: 계획 작성 완료. 개발 작업은 시작하지 않았다.

## 핵심 전략

작은 Kernel과 Host별 최적화를 유지한다. 권한은 Work, Trust, Knowledge에 남긴다. Prompt 최적화는 Host가 맡는다. W1 평가를 통과한 기준선을 고정한 뒤 Futures와 Knowledge 개선을 진행한다.

첨부 계획의 W0~W10을 **필수 카드 31개 + 조건부 카드 2개**로 나눴다. 한 Chat 요청에는 카드 하나만 지정한다. 큰 eval은 그 카드 안에서도 최대 8회 호출의 배치로 나눈다. 전체 문서를 한 번에 읽히거나 전체 구현을 한 요청에 맡기지 않는다.

## 바로 사용할 파일

1. [START_HERE.md](START_HERE.md): 첫 Chat에 붙여 넣을 요청과 재개 요청.
2. [RUNBOOK.md](RUNBOOK.md): Moonremote 실제 API에 맞춘 실행·복구 절차.
3. [cards/C00.md](cards/C00.md): 첫 작업. 원격 경로와 선행 작업만 확인한다.
4. [STATUS.md](STATUS.md): 전체 의존 관계와 진행표.
5. [CONTRACTS.md](CONTRACTS.md): 네 계약과 평가 기준.
6. [SOURCE_MAP.md](SOURCE_MAP.md): 현재 코드, 확인한 구현, 확인하지 못한 배포 상태.

새 Chat의 최소 입력은 START_HERE의 요청, 해당 카드, 직전 결과의 증거 참조다. RUNBOOK은 필요한 실행·복구 부분만 읽는다. SOURCE_MAP 전체와 다른 카드 전체를 매번 읽지 않는다.

## 적정 작업 크기

- 구현 카드 하나는 관찰 가능한 동작 하나를 완성한다.
- 기본 변경량은 제품 원본 2~5개, 관련 테스트 1~3개다. 생성 출력은 개수에서 제외하되 freshness는 확인한다.
- 약 20~45분의 작업을 설계 목표로 삼는다. Chat 실행 한도나 완료 시간 보장은 아니다.
- owner 두 개 이상을 동시에 크게 바꾸거나 schema migration이 별도 검토를 요구하면 구현 전에 a/b 카드로 나눈다.
- 테스트 수나 tool call 수를 줄이기 위해 AC를 버리지 않는다.
- 같은 workspace에는 활성 작업 하나만 둔다. 카드별 병렬 Chat은 기본값이 아니다.
- 완료한 카드를 다시 구현하지 않는다. 현재 diff와 증거가 유효하면 VERIFIED_EXISTING으로 닫을 수 있다.
- 문서 카드, 구현 카드, live 평가 카드를 구분한다. fixture 통과는 live 평가 완료가 아니다.

## 실행 순서

| 원래 Wave | 카드 | 결과 |
| --- | --- | --- |
| W0 | C00~C01 | 선행 종료·원격 환경·평가 기준선 |
| W1 | C02~C11 | 의미 계약·provider 표현·delta·cache·부채 정리·A/B gate |
| W2 | C12~C14 | Futures evidence·assessment·fresh review 연결 |
| W3 | C15~C16 | bounded restore·architecture escalation |
| W4 | C17~C18 | 기존 type 검토·procedure와 점진적 조회 |
| W5 | C19~C20 | root-cause 분류·candidate 연결 |
| W6 | C21~C22 | correction/replay pair·승격 gate |
| W7 | C23~C24 | run 간 반복 근거·durable 승격 |
| W8 | C25~C26 | retrieval baseline·단일 개선 |
| W9 | C27~C29 | hidden follow-up·세 전략 비교 |
| W10 | C30~C31 | 실제 가치가 있을 때만 projection |
| 마감 | C32 | 계약 추적·통합 검증 |

첫 전달 묶음은 C00~C01이다. 다음 묶음은 C02~C08이다. 각 묶음도 한 번에 실행하지 않는다. C09~C11이 통과해야 C12를 시작한다. 뒤의 카드는 현재 source map에 맞춘 범위 후보이며, 진입 시 선행 결과로 정확한 경로를 고정한다.

## 원안에서 수정한 점

- 기존 Prompt Envelope와 capability policy를 먼저 재사용한다. 두 번째 compiler나 eval framework를 만들지 않는다.
- stable/project/run/volatile은 의미 계층이다. 이미 있는 6개 segment를 4개로 강제 교체하지 않는다.
- model별 파일명이 존재한다는 사실만으로 전체 prompt fork라고 판정하지 않는다. 실제 중복과 drift를 본다.
- 캐시 효과는 실제 provider usage로 판단한다. 안정된 prefix만으로 cache hit를 보장하지 않는다.
- Typed Authority 구현 존재와 공식 종료는 분리한다. C00이 실제 종료 증거를 확인한다.
- Green/Yellow/Red는 새 workflow stage가 아니다. 기존 Work/Trust 결정에 들어가는 평가 결과다.
- 최소 구현 원칙은 외부 입력 검증, 권한 검사, migration을 제거하는 근거가 아니다.
- 모델별 최신 성향, API 지원, 최소 cache 길이는 실행 때 재확인한다. 첨부의 깨진 인용 표시는 근거로 쓰지 않는다.

공식 자료는 지침 누적 재검토를 권한다. 다만 삭제 효과는 이 프로젝트의 비교 평가로 확인한다. [OpenAI Prompt 재검토 지침](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)

## 이번 산출물의 경계

Moonshot와 Moonremote의 제품 코드를 수정하지 않았다. Kernel을 활성화하지 않았다. 구현, live 모델 평가, 원격 플러그인 배포 확인을 실행했다고 주장하지 않는다. 실행 환경에 실제 노출된 도구 schema가 로컬 source와 다르면 C00에서 그 차이를 먼저 해결한다.
