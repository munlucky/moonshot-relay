# 얇은 I/O 리팩토링 구현·검증 결과

- 기준일: 2026-11-12 KST.
- 작업 기준: `codex/spotify-io`, 기존 HEAD `d3603f8c` 이후의 작업 변경.
- 명세: [THIN_IO_REFACTOR_PLAN.ko.md](./THIN_IO_REFACTOR_PLAN.ko.md).
- 상태: T0–T3 구현·회귀·계정 실행 확인. T4의 36건 실행·내용 검토·비용 집계 완료. 기능은 동작하며 기본 채택은 보류한다. 최종 설치 대조와 Kernel 판정은 아래 원본 증거 경로에서 별도로 확인한다.
- 커밋·푸시·기본 Hook 활성화는 수행하지 않았다.

## 구현 계약

Reader는 강제 `facts`·인용 유일성·인용 내부 심벌 검사를 제거하고 짧은 텍스트를 반환한다. Host의 `sources`는 전달한 원문의 경로·SHA이며 주장별 검증 표시가 아니다. 인용이 없거나 반복돼도 답변을 반환한다. 빈 응답은 실패, 크기 초과는 `truncated`, 응답 후 원본 변경은 답변을 보존한 `stale`이다. 권한 변경·금지 도구 이벤트는 정상 답변으로 노출하지 않는다.

Writer는 일반 Codex에서 stdin JSON을 받아 `io-write - --apply` 한 번으로 신규 파일을 생성·저장한다. 기존 후보 생성과 SHA·경로·`wx` 적용 함수를 연결했다. 정상 결과는 파일명·해시·크기·사용량이며 코드 전체를 stdout에 반복하지 않는다. 생성 성공 후 적용 실패 시 후보·관측한 대상 상태·사용량을 보존한다. 성공 후보는 해당 호출이 할당한 임시 디렉터리인지 확인한 뒤 정리한다. 자동 재생성·수정·재시도는 없다.

Kernel Writer는 후보만 반환하며 기존 Run·Step·Worktree·Owner 권위를 유지한다. 일반 CLI만 Kernel 전용 완료 표시 필드를 제외한다. 일반 I/O를 위해 Kernel Run을 만들지 않는다.

## 요구사항별 증거

| 명세 범위 | 구현·검증 근거 | 판정 |
| --- | --- | --- |
| T0 기존 구현 재사용·범위 고정 | 기존 Host 모델 정책, App Server, standalone 적용 함수, 계정 설치기 재사용. Kernel의 허용 경로에 transport 수정 범위를 추가한 뒤 구현 | 확인 |
| T1 plain Reader | `src/host/kernel/io-reader.ts`; standalone·Kernel local/MCP 테스트에서 `answered`, 인용 없음·반복·함수명 없음, 빈 응답, UTF-8 절단, stale 확인 | 확인 |
| Reader transport | `toolPolicy: none`일 때 기존 transport가 plain final text도 수집하도록 수정. 일반 Worker 도구 처리에는 적용하지 않음 | 확인 |
| T2 stdin·단일 생성/저장 | CLI·standalone 테스트, 실제 설치본 일반 Codex 세션. 별도 metadata 조회·io-apply 없이 신규 파일 저장 | 확인 |
| 기존 대상·참조·후보·부모 링크·동시 생성 | 기존 적용 보호 테스트 유지. 참조/후보 변경·기존 대상·링크 거부, 경쟁 생성은 한 번만 성공 | 확인 |
| 실제 쓰기 실패 | 주입한 부분 쓰기 실패에서 후보와 usage 유지, `partial-or-changed` 상태 확인 | 확인 |
| 선택적 metadata 오류 | 호출 전 존재 검사. 생성 후 EIO에서도 받은 결과·usage와 `metadataFailure`를 stdout에 유지 | 확인 |
| Kernel 권한·도구 금지 | Host/transport/MCP 회귀. unbound/stale 거부, 금지 실행 이벤트 뒤 정상 응답이 와도 거부. Worker 위임 권한 확대 없음 | 확인 |
| T3 Hook·Skill | Hook 감지 범위 유지·새 stdin 안내. Writer Skill은 대상/명세 결정 → 한 번 호출 → 원래 필요한 검토/테스트의 세 단계 | 확인 |
| T3 계정 설치 | 기존 `--codex-io-only` 설치기. 첫 설치 audit에서 manifest 1,955개 일치, 개인 config/AGENTS/기존 다른 580 Skill·Hook 보존 | 확인 |
| T4 실제 조건 비교 | 기존 실패 cohort 보존. native4 36건 종료·내용 검토 완료, usage 누락 없음. 아래 절차 편차 때문에 채택 입증으로 사용하지 않음 | 평가 완료 / 기본 채택 보류 |
| Kernel 완료 권위 | `run-9bfdc12d-e70b-456e-9e9e-a51f160ca117`, `step-2-1`; 지원 report가 실행한 bound proof와 반환 continuation이 권위 | 원본 영수증 참조 |

회귀 명령 `npm run test:host-worker-code-closeout`은 180개 통과, POSIX 전용 2개 제외였다. focused 그룹 22개와 이후 standalone 그룹 8개도 통과했다. 그룹은 겹치므로 고유 테스트 수로 합산하지 않는다. typecheck, build, dependency boundaries, `git diff --check`도 통과했다. 최종 Kernel proof 결과는 별도로 기록한다.

## 실험 경계와 보존 기록

이전 v3의 인용 기반 Reader 9회 실패와 Writer 비용 증가 수치는 [기존 가이드](../../guidelines/host-owned-io-writer.md)에 그대로 남겼다. 새 계약의 결과로 바꾸지 않았다.

첫 리팩토링 cohort는 native `0.167.0-alpha.3.2`에서 36개 시도의 종료 기록을 남겼다. 마지막 10개는 계정 사용량 한도로 중단됐고 Main usage가 없다. Reader의 18개 비교는 완료됐지만 Writer 전체 경제성은 `ECONOMICS_INCONCLUSIVE`이다. usage 누락을 0으로 계산하지 않는다.

- 최초 protocol SHA256: `038b2651110ee081bc9e18581e5f2d00feeeab6f9e5de9be8ef0d3be7fcf8085`.
- 최초 Reader: 직접 내용 통과 9/9, 위임 4/9. 위임 9회 모두 `answered` 반환.
- 최초 Reader 전체 input+output: 직접 1,031,516, 위임 1,404,552.
- 최초 Reader 가정 비용 합계: 직접 371,864.60, 위임 411,233.65. 통과 1건당 41,318.29 대 102,808.41. 기본 채택 보류.
- `W1-1-B`, `W2-1-B`: 주 모델이 `helper.json`을 요청 파일로 만든 뒤 같은 metadata 출력 경로를 지정해 사전 `EEXIST` 거부. raw stdout·동결 CLI 코드로 모델 호출 전 실패임을 확인했다. helper 비용 0은 이 근거에서 파생한 값이며 API가 보고한 usage로 위장하지 않는다. raw receipt의 null은 유지했다.

사용량 회복 후 확인한 로컬 CLI는 `0.167.0-alpha.4.1`이었다. 이전 실행 파일은 제거돼 첫 Writer 후속 시도가 spawn `ENOENT`로 끝났다. 해당 시작 기록과 로그를 보존했고 프로세스·모델 호출은 없었다. 과거 경로를 복구하거나 기록을 덮어쓰지 않았다.

현재 버전에서는 Reader·Writer pilot 2개를 별도로 실행했다. 두 기능의 반환·저장은 동작했고 요청/해결 모델은 Luna였다. Writer pilot은 정상 테스트 16개·결함 검사 12개를 통과했지만 필수 missing-lease 등의 테스트를 빠뜨려 내용 평가는 실패했다. 이 모델 산출물 누락을 제품 I/O 구조 실패와 구분하고 그대로 보존했다.

현재 버전의 본 비교 protocol SHA256은 `93bac2fdd377eda0fe9c3c97c2da617459d0392a79fbde1a4f2855baa96c8bf9`이다. 양쪽 모두 실제 계정 Sol/medium과 기본 규칙을 사용한다. `--ignore-rules`, 신뢰 우회, 인증 복사, Kernel 실행은 없다. Reader 3과제·Writer 3과제 각각 A/B 3회, 순서 교차, 새 작업 디렉터리에서 순차 실행한다. 제품 코드와 설치 Skill은 동결했다. 첫 cohort와 합치거나 실패를 대체하지 않는다.

### 사전 등록 절차와 실제 실행의 편차

계획 10.3의 구조 pilot에서는 반환·단일 호출 저장을 확인했다. 그러나 실험 protocol은 그보다 강하게 pilot **내용 통과 후** 본 비교를 시작하도록 정했다. native4 Writer pilot 내용 실패에도 본 비교를 진행했다. 이 편차를 사후에 지우거나 기준을 고치지 않는다. 따라서 native4 결과는 실패·비용의 **기술 통계와 비채택 근거**이며, 깨끗한 사전 등록 채택 실험의 성공 증거가 아니다.

`W2-3-B`는 첫 정상 테스트 33개가 통과한 뒤 주 모델이 누락된 blocked 조건을 찾아 생성 파일만 수정했다. 최종 38개·변형 결함 24개와 내용 검토는 통과했다. 일반 protocol은 같은 Turn 수정을 허용하지만 과제 프롬프트는 테스트 실패 후로 제한했다. 보수적으로 내용 PASS와 절차 준수 완료를 구분하고, 주 집계의 완료 분모에서는 제외했다. 수정 비용·시간과 원본 receipt는 유지했다. 제품 Skill에서 요구 검토 후 필요한 수정을 허용하는 것과 실험 절차 준수는 별개다.

선택적 `helper.json`은 모델 사용량 수집을 위한 실험 계측이다. 실제 설치 Skill의 stdin 호출에는 metadata 파일명이 필수가 아니다. 이 출력 경로와 요청 파일을 중복 사용한 `W1-3-B`, `W2-2-B`는 생성 전 EEXIST로 끝났다. 두 건은 전체 실패·비용에 포함하며, 제품의 무단 덮어쓰기나 Luna 생성 실패로 분류하지 않는다. native4의 위임 I/O 명령은 18회, 실제 helper 모델 호출은 Reader 9회·Writer 7회였다. 호출된 16회는 requested/resolved Luna를 확인했다. 호출 전 거부 두 건에는 모델 식별을 합성하지 않는다.

## 현재 버전 Reader 결과

Reader 18개 비교는 모두 종료됐고 usage와 전체 답변을 확인했다. 9개 위임 모두 Luna `answered`였으며, 직접 내용 통과 9/9, 위임 8/9였다. 위임 실패 1개는 요청한 worktree ID backfill/rebind API 대신 workspace identity update/CAS API를 설명했다. 도구 성공과 내용 실패를 따로 기록했다.

| Reader 과제 | 내용 통과 A / B | 통과 1건당 가정 비용 A / B | B 비용 변화 | B 시간 변화 | 판정 |
| --- | --- | --- | --- | --- | --- |
| 단일 대형 파일 R1 | 3/3 / 2/3 | 35,230.20 / 47,713.58 | +35.43% | +81.76% | NO_ADOPT |
| 더 큰 단일 파일 R2 | 3/3 / 3/3 | 37,040.00 / 32,749.42 | -11.58% | -1.80% | NO_ADOPT: 15% 절감 미달 |
| 교차 파일 R3 | 3/3 / 3/3 | 46,091.80 / 62,317.02 | +35.20% | +46.52% | NO_ADOPT |

Reader 총 input+output은 A 1,030,386, B 1,411,898이다. 가정 비용 합계는 355,086.00 대 380,626.45, 시간 합계는 292,747 대 370,288ms다. 9개·8개 통과로 나눈 완료당 비용은 39,454.00 대 47,578.31이다. Main output만 비교하거나 실패를 제외해 절감을 주장하지 않는다. 다른 CLI 버전의 최초 cohort와 통과 수를 합치지 않으며, 관측 차이를 리팩토링의 인과 효과로 해석하지 않는다.

## 현재 버전 Writer 결과

Writer 18개 비교도 모두 종료됐으며 최종 모듈 전체와 정상·변형 결함 결과를 검토했다. 직접 9/9, 위임 최종 내용 4/9이다. 절차 편차 `W2-3-B`를 제외한 보수적 완료는 위임 3/9이다. 대상 소스는 모두 불변이며, 검출한 변형 결함의 실패가 assertion 또는 대상 동작 오류에서 발생했음을 확인했다. 문법·모듈 로딩 실패를 결함 검출로 계산하지 않았다.

| Writer 과제 | 내용 통과 A / B | 절차 포함 완료 A / B | 완료 1건당 가정 비용 A / B | 판정 |
| --- | --- | --- | --- | --- |
| 단일 참조 W1 | 3/3 / 0/3 | 3/3 / 0/3 | 50,443.27 / 계산 불가 | NO_ADOPT |
| 복합 참조 W2 | 3/3 / 1/3 | 3/3 / 0/3 | 63,898.40 / 계산 불가 | NO_ADOPT |
| 작은 함수 W3 | 3/3 / 3/3 | 3/3 / 3/3 | 24,469.07 / 26,849.63 | NO_ADOPT: 비용 9.73% 증가 |

W1의 내용 실패 두 건은 blocked null-lease 등 필수 음성 조건을 빠뜨렸다. 나머지 한 건은 호출 전 EEXIST였다. W2는 필수 음성 조건·오류 타입 누락 한 건, 호출 전 EEXIST 한 건, 위 절차 편차 한 건이다. W3는 등록된 정상·변형·내용 조건을 모두 통과했고 시간은 7.51% 줄었지만 비용 기준을 충족하지 못했다. 더 강한 사후 기준을 추가해 기존 결과를 바꾸지 않았다.

Writer 전체 input+output은 A 1,099,260, B 1,741,828이다. 가정 비용 합계는 416,432.20 대 391,024.85지만 통과 분모가 다르다. 보수적 완료당 비용은 46,270.24 대 130,341.62다. 절차 편차 한 건의 최종 내용 PASS까지 포함하는 민감도에서도 위임 완료당 비용은 97,756.21로 더 크다. 시간 합계 734,537 대 514,196ms만으로 같은 품질의 완료가 더 빠르다고 주장하지 않는다.

## 전체 사용량과 왕복

아래 cached는 input의 부분집합이다. 모든 cache-write 보고값은 0이었다. reasoning output도 output에 다시 더하지 않았다.

| 경로, 각 9시도 | Main input | Main cached | Main output | helper input / cached / output | 셸 명령 | Main 도구 출력 bytes |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| Reader A | 1,022,766 | 809,600 | 7,620 | 0 / 0 / 0 | 21 | 1,223,424 |
| Reader B | 987,278 | 860,288 | 7,886 | 413,629 / 22,656 / 3,105 | 21 | 136,881 |
| Writer A | 1,075,205 | 945,792 | 24,055 | 0 / 0 / 0 | 26 | 99,020 |
| Writer B | 1,599,043 | 1,463,936 | 7,172 | 123,377 / 14,080 / 12,236 | 30 | 46,771 |

Main input은 Reader 약 3.47% 감소, Writer 약 48.71% 증가했다. 전체 raw tokens는 Reader 약 37.03%, Writer 약 58.45% 증가했다. 출력 축소가 전체 절감을 보장하지 않았다.

등록한 원문 bytes 합은 Reader 각 arm 1,082,904, Writer 각 arm 57,123이다. 이는 과제별 원문 크기 합이며 Main이 실제 읽은 원문 분량과 같다고 볼 수 없다. Main 도구 출력에는 Skill·원문·생성 파일 일부·메타데이터·테스트 로그가 섞인다. 출력 bytes를 계측했지만 각 원인의 정확한 기여는 분리하지 않았다. 성공한 Writer의 최종 파일 bytes 합은 A 69,606, B 43,104이고 B의 실패 두 건에는 파일이 없다. 최종 파일 크기는 Main에게 전달된 후보 bytes가 아니다. B의 helper 결과 JSON 합 5,130 bytes에는 생성 코드 전체가 없으며, Main이 별도 읽은 부분은 위 도구 출력에 포함된다.

캐시를 모두 일반 input 요율로 간주한 민감도 합계는 Reader A/B 1,083,726 / 1,159,983.25, Writer A/B 1,267,645 / 1,711,735.25다. 이는 캐시 상태를 제어한 재실행이 아니라 동일 관측치의 요율 민감도이다.

## 비용·품질 해석

완료 비용은 모든 시도의 Main·helper·필요한 재읽기·검토·수정·테스트 비용을 포함해 전체 품질 통과 건수로 나눈다. 완료가 없으면 완료당 절감률을 계산하지 않는다. input 안의 cached subset과 reasoning output subset을 중복 합산하지 않는다. 과제별 양쪽 3/3 품질 통과, 가정 비용 15% 이상 감소, 시간 증가 25% 이하를 모두 만족해야 해당 범위 채택 후보이다.

요율은 사전 고정한 자원 환산 가정이다. Sol input/cached/output은 1/0.1/8, Luna는 0.25/0.025/2이다. 실제 구독 차감·청구액은 측정하지 않았다. 외부 내용 검토자는 현재 Codex AI이며 사람이나 독립 에이전트가 아니다. 실험 구성·외부 내용 심사 비용은 과제별 생산 경로 비용 밖이다. 실제 Main이 한 읽기·검토·수정은 포함한다.

## 적용 범위

Reader Hook은 비활성을 유지한다. Writer Skill은 명시적 위임·평가용이다. 저장 완료는 코드 정확성이나 프로젝트 테스트 통과를 뜻하지 않는다. 실패 후보는 진단용으로 남고 부분 대상 파일은 확인해야 한다. 경로·참조 검사와 저장 전체는 원자적 트랜잭션이 아니며 중복 방지는 Host 프로세스 범위이다.

로컬 결과 캐시·검증 결과 재사용, coverage 엔진, 검토 패키지, 별도 Reviewer, 자동 Reader→Writer 연쇄, 새 Router·MCP 서버·DB·Queue는 추가하지 않았다. Windows/Linux Kernel 제품 Proof·Owner 운영 확대는 이번 명세의 제외 범위이다. 일반 계정 I/O 사용과 구분한다.

원본 로그·후보·사용량·실험 JSON은 저장소 밖 `%TEMP%/moon-thin-io-20261111/`에 둔다. native4 자료는 그 아래 `account-native4-20261112/`에 있다. 이 보고서는 검증 요약이며 raw 실행 기록을 대체하지 않는다.

## 최종 수용 구분과 증거 위치

| 구분 | 결과 | 한계·운영 결정 |
| --- | --- | --- |
| 기능 | plain Reader 반환, stdin 단일 호출 Writer 저장 확인 | 답변 정확성·생성 코드 품질의 인증이 아님 |
| 품질 | Reader A9/B8, Writer 내용 A9/B4 | Writer 절차 준수 완료 B3. 누락·실패·수정 보존 |
| 경제성 | 두 기능 기본 채택 보류 | pilot 편차로 채택 입증 불가. 기술 통계도 사전 절감 조건 미달 |
| 설치 | 기존 계정 설치기와 실제 새 세션 사용 | 최종 갱신 직전/직후 비교 및 source/runtime/실험 hash 대조는 `install-final-audit.json` 참조 |
| Kernel | 기존 Run·권한·Report 경계 유지 | 최종 bound proof와 반환 action은 `kernel-report-result.json`, `kernel-report.log` 참조. 이 문서가 done 권위를 대신하지 않음 |

T0의 소비 코드·범위 확인, T1의 반환·보존, T2의 저장·보호, T3의 설치·새 세션, T4의 비교·비채택 판단을 각각 수행했다. 전체 조건은 계획 10.1–10.4와 위 표에 대응한다. Host 회귀 명령과 별도로 standalone 8개, 설치 3개의 계약 시험이 필요하며 Host 180개 통과만으로 설치·실험 수용을 주장하지 않는다.

외부 자료: `account-native4-20261112/w3-analysis.json`은 36개 결과·내용 판정·원시 usage·파생 EEXIST 회계·mutation audit를 포함한다. `w3-method-notes.json`은 두 절차 편차를 보존한다. `pilot-semantic.json`은 기능 PASS/내용 FAIL을 구분한다. 초기 `install-audit.json`은 수정하지 않고, 최종 갱신은 `account-final-before.json`, `account-final-after.json`, `install-final.json`, `install-final-audit.json`으로 별도 보존한다. 모든 경로는 위 TEMP 증거 루트 기준이다.

새 라우팅 정책·특정 과제 하드코딩을 추가해 결과를 통과시키지 않았다. 더 적합한 작업에서 채택을 제안하려면 별도 사전 비교가 필요하다. 이 리팩토링의 완료와 기본 채택 보류는 양립한다.
