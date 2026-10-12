# C28 로컬 실제 평가 결과

평가 데이터 수집: COMPLETE. 성공 stage 9개, 전체 attempt 10개, 실패 1개, incomplete 0개. C29는 시작하지 않았다. 이 문서는 데이터 수집 결과이며 Kernel 완료 authority를 대체하지 않는다.

## 범위와 실행 조건

- 기준 source: 92ff7fc7d57890e82d9bedaf2c2934e8564a3d74
- Protocol: kernel-follow-up-eval.v1. Case: FOLLOW-UP-001 (평가 전에 고정한 1개 case).
- 전략: verify-only, always, adaptive. 각 전략은 동일 F1 파일과 조건에서 시작했다.
- 실제 surface: Codex CLI 0.162.1, model gpt-5.6-luna, effort max. C11 incumbent common/provider prompt 사용.
- Docker image: moonshot-c28-codex:0.162.1. 각 stage는 새 CLI session이며 같은 전략의 workspace를 이어 사용했다.
- native tools 사용. inherited config/rules, web, MCP와 multi-agent 기능은 비활성화했다. 실제 model/effort는 provider session의 turn_context와 대조했다.
- 제품 소스, 테스트와 protocol은 변경하지 않았다.

## 격리와 공개 순서

Docker Linux의 mount/PID namespace로 actor를 격리했다. non-root user, read-only root filesystem, cap-drop ALL, no-new-privileges를 적용했다. Mount는 해당 actor workspace, actor home, read-only 인증 파일, read-only 공개 검증기 4개뿐이다. evaluator root와 Docker socket은 mount하지 않았다. 실제 읽기 거부 probe와 container inspect를 보존했다. Provider 호출용 network는 허용했으며 검증 container의 network는 차단했다.

hidden corpus와 조건은 모든 actor 실행 전에 evaluator-only root에서 고정했다. F1 prompt/package/파일/log에는 이후 단계 원문·경로·digest가 없음을 검사했다. 각 stage의 post snapshot을 freeze한 뒤 다음 입력만 공개했다. 모든 전략에서 이전 post와 다음 pre가 일치하며 reveal 시각과 freeze binding이 유효하다. corpus commitment도 최초 값과 일치한다.

## 실제 측정값

Token 값은 provider가 기록한 실제 값이다. reasoning/cached는 별도 관측 차원이며 output/input에 다시 더하지 않는다. wall time과 evaluator verification time도 구분한다. 실패 비용을 제외하지 않는다.

| 전략 | Stage | Attempt | 상태 | Actor ms | Input | Output | Reasoning | Cached | 파일/변경 LOC | 검증 ms |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| adaptive | F1 | 1 | failed | 55213 | 108508 | 3061 | 2297 | 87040 | 1/1 | 1848 |
| verify-only | F1 | 1 | completed | 43066 | 93963 | 3230 | 2501 | 84224 | 1/1 | 1744 |
| verify-only | F2 | 1 | completed | 64940 | 93524 | 2022 | 956 | 82176 | 2/4 | 1815 |
| verify-only | F3 | 1 | completed | 30850 | 78819 | 2006 | 1172 | 68096 | 2/12 | 1665 |
| always | F1 | 1 | completed | 86275 | 126224 | 3471 | 2494 | 115456 | 1/1 | 1593 |
| always | F2 | 1 | completed | 29193 | 66114 | 2187 | 1450 | 60160 | 2/5 | 1592 |
| always | F3 | 1 | completed | 37324 | 65716 | 2627 | 1715 | 56064 | 2/15 | 1521 |
| adaptive | F1 | 2 | completed | 51103 | 112559 | 3883 | 2906 | 95232 | 1/1 | 1556 |
| adaptive | F2 | 1 | completed | 35205 | 92771 | 2278 | 1390 | 84224 | 2/4 | 1707 |
| adaptive | F3 | 1 | completed | 32948 | 91898 | 1989 | 1075 | 82176 | 2/12 | 1738 |

모든 attempt에서 correctness=true, scope violation=0, critical authority violation=0이었다. 그러나 adaptive F1 attempt 1은 provider 사용량 제한으로 turn.failed가 발생했으므로 성공으로 인정하지 않았다. 실패 당시 provider session의 실제 token_count를 보존했다. turn.completed가 없는 사실도 보존했다.

사용자가 재개를 요청한 뒤 계정 실행 가능 상태를 확인했다. 첫 실패의 모든 파일을 attempt-1에 보존하고 F1 원래 snapshot으로 두 번째 시도를 수행했다. 모델·설정·corpus·판정 기준은 변경하지 않았다. 두 번째 시도가 완료된 후에만 F2를 공개했다. stage별 최대 2회 제한을 지켰다. 성공 stage는 재실행하지 않았다.

reworkCount는 actor의 service-focused-test 실패 횟수다. humanInterventionCount는 actor stage 진행 중 직접 개입 횟수다. stage 사이 재개 지시와 evaluator 복구는 위 문단에 별도로 기록했다. 이 실행에서는 모든 stage의 두 값이 0이다. actor 자체 테스트 시간은 actor wall time에 포함되며 별도 합산값은 제공하지 않는다. 실제 token 차원의 누락은 없다. 토큰 추정값과 종합 점수는 만들지 않았다.

## 검증 및 환경 문제

동일 revision의 LF checkout에서 build:check, build:tests:check, typecheck, check:boundaries와 필수 Codex contract/C27 테스트 56개가 통과했다. Windows 기본 checkout은 core.autocrlf=true 때문에 generated contract digest 검사가 실패했다. LF validation clone에서는 통과했다. 이는 checkout 줄바꿈 문제이며 제품 로직 실패로 집계하지 않았다. 소스를 수정해서 검사를 우회하지 않았다.

최종 collector는 9개 성공 receipt, 1개 실패 archive, 동일 seed/조건, 실제 model/effort, task/source binding, snapshot digest, 순차 reveal, mount 경계와 corpus commitment를 대조했다. issues는 비어 있다.

## 증거와 제한

로컬 evidence root: `C:/Users/moon/.moon-relay-kernel/evidence/c28-local-20261012`.

- actual-validation.json: 최종 stage 목록과 실패 attempt. SHA-256: 4f509195764a99a27458568ec0eaab28e83d3c99657826ac11a5212cbcbe127c
- isolation.json, isolation-probe.json, isolation-container-inspect.json: 실제 격리 증거.
- conditions.json, preflight.json: 실행 조건과 사전 검사 결과.
- receipts/<strategy>/F1-actual.json, F2-actual.json, F3-actual.json: 사용량을 포함한 실제 receipt.
- receipts/adaptive/attempt-1/: 첫 실패 원본. 내부 같은-stage 참조는 해당 archive root 기준으로 해석한다.
- receipts/<strategy>/*-pre.json, *-post.json, *-diff.patch, *-verification.json, *-freeze.json, *-reveal.json, *-model-proof.json, cursor.json: 단계별 증거와 재개 정보.
- evaluator.mjs, collect.mjs: 이 로컬 실행에 사용한 evaluator 도구. 제품 코드에 포함하지 않는다.

인증 파일, provider home/session, hidden corpus와 runtime receipt 원본은 Git에 넣지 않았다. 이 로컬 root가 없는 환경에서는 원본 증거를 별도로 전달받아야 한다. 평가 case가 1개이므로 일반적인 전략 우열을 주장하지 않는다. F1/F2+F3 비용 비교와 Adaptive 채택 여부는 C29의 별도 작업이다.
