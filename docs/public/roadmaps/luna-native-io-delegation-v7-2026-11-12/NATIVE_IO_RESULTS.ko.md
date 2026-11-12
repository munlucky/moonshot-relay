# 일반 Codex Native Luna I/O 검증

사용자가 정정한 실제 대체, 중복 작업 감소, 작업 품질, 합산 비용의 네 조건을 적용한다. 이전 v7의 저장 보호 등가성, 읽기 전용 턴 전환, 구형 코드 전면 삭제, 3/3 및 15%·25% 수치는 이번 일반 세션 수용 조건에서 제외됐다.

## 구현과 설치

일반 Codex의 `$io-reader`와 `$io-writer`는 Native `spawn_agent`를 사용한다. I/O 자식만 Luna/medium으로 지정하고 `fork_turns=none`을 전달한다. Main은 사용자 설정과 대화를 유지한다. 질문 또는 명세, 참조 경로, 작업 범위를 전달하고, 필요한 답이나 변경 경로와 짧은 결과를 받는다. Main은 필요한 검토·수정·프로젝트 검증으로 원래 과제를 완료한다.

Reader의 후속 구현에는 최소 호출 예제와 정확한 인자·fixture 형태를 요청한다. Writer는 수용 조건 확인 결과와 실제 수행한 검증, 남은 질문을 전달한다. 두 지침은 긴 작업에서 짧은 대기를 반복하지 않도록 안내한다. 요약의 특정 형식이나 인용 검사를 강제하거나 응답 전체를 폐기하는 제품 처리는 없다.

계정의 기본 모델 Sol/medium과 `danger-full-access`, 승인 `never`를 그대로 사용했다. 읽기 전용 전환과 시험용 모델 프로필을 사용하지 않았다. 각 실사용 실행은 실제 계정 Skill을 선택한 새 일반 Codex App Server 세션이다. 설치본 Native 도구가 실제 파일을 읽거나 신규 테스트 파일을 작성했다. 이 경로는 Kernel Run이나 기존 Host I/O 실행기를 호출하지 않는다. 개발 작업 자체는 사용자가 선택한 Kernel Skill로 관리했다.

기존 설치기의 관리 파일 목록과 소유권 트랜잭션을 사용했다. 관리 Skill 파일이 일반 복사에서 먼저 덮어써지지 않도록 기존 복사 함수에서 제외했다. 별도 설치 서비스나 제품 엔진은 추가하지 않았다. 설치기의 Dry Run 후 실제 계정에 적용했고 소스·설치 Manifest·설치본 SHA가 일치한다. 모델 사용 중 Codex가 관리하는 `.system` Skill 갱신은 별도로 기록한다. 사용자 `config.toml`, AGENTS와 대상 밖 사용자 Skill·Hook은 보존됐다.

두 Skill은 명시적으로 선택한다. 일반 Worker 모델 정책은 변경하지 않았다. 범위 지침은 기존 Codex 권한·승인·파일 도구 아래에서 적용된다.

## 과제와 측정

첫 Reader 과제는 실제 `resolveBoundInvocation`의 완료 Run 복구 조건을 분석한 뒤 회귀 테스트를 생성하는 작업이다. 정상 검사와 의도, 승인 identity, 변경 workspace, 명시 Run, finalization의 결함 반례 다섯 건을 모두 검사했다.

첫 Writer 과제는 실제 `resolveCodexCapabilityDelta`의 회귀 테스트 신규 생성이다. 정상 검사와 strict capability 두 건, evaluation, suitability, freeze의 결함 반례 다섯 건을 검사했다. 작은 과제에서 비용이 증가한 결과도 보존했다.

Writer의 추가 과제는 같은 실제 Host 정책 모듈의 공개 경계를 다루는 신규 회귀 테스트 파일 생성이다. 실행 등급, 사용자 override, reasoning 우선순위, 프로필, 위임 승인, fast mode, plan, programmatic tool과 pro mode를 포함한다. 두 arm 실행 전에 수용 명세를 고정했다. 작은 과제의 비용 증가를 이 결과로 덮어쓰지 않는다.

각 직접·위임 실행은 같은 Main 설정, 권한, 원본과 프로젝트 검증을 사용했다. 모든 자식과 Main의 누적 입력·출력, 캐시 입력, 검토·수정 호출을 합산한다. 캐시 입력은 입력의 부분집합이며 reasoning output도 output에 포함된다. 같은 실행 안의 추가 질문과 재작업도 포함한다.

환산 단가는 Standard 단기 컨텍스트 100만 토큰당 Sol 입력/캐시/출력 `2/0.1/10` USD, Luna `0.1/0.01/0.5` USD다. 이 실행은 cache-write 토큰이 0이다. Plus 구독 계정의 실제 차감액은 미측정이다. [OpenAI API 가격](https://developers.openai.com/api/docs/pricing)

원시 실행·등록·사용량·정상/결함 검사와 계산은 `C:/Users/moon/AppData/Local/Temp/moon-luna-io-simple-20261112`에 있다. 계정 설치 감사는 `account-before.json`, `account-after.json`, 비용 계산은 `audit.json`과 `audit.mjs`에 있다. 실험 중 수정 전·후 실행을 각각 보존했다. 수정 전 실패를 제품의 실행 중 재시도로 숨기지 않는다.

## 첫 비교에서 확인한 경계

Reader 첫 위임은 Main이 원문을 재조회하지 않고 품질을 통과했으나 직접 처리 `0.08043280` USD 대비 `0.09311632` USD로 비용이 15.77% 증가했다. Main은 10초 대기를 다섯 번 호출하고 추가 구현 정보를 요청했다. 최소 호출 예제를 처음 요청에 포함하고 긴 대기를 사용하도록 지침을 보완했다. 수정 확인에서는 60초 대기 한 번을 사용했다. 직접 기준을 다시 실행하지 않고 같은 원본·과제·수용 기준의 수정 후보를 확인했다.

작은 Writer 첫 위임은 필요한 보완을 포함해 `0.07145838` USD로 직접 `0.05951440` USD보다 20.07% 비쌌다. 긴 대기와 수용 조건 확인을 안내한 다음 실행도 Main의 원문·생성물 검토 비용을 포함해 `0.09193284` USD로 54.47% 증가했다. 품질은 통과했다. 생성물을 한 번 검토했다는 이유만으로 중복 작업 실패를 선언하지 않았다. 작은 과제의 효율 판정은 FAIL이다. 추가 Writer 과제는 생성할 코드와 수용 범위가 다른 별도 과제다.

## 제거 및 유지

일반 Codex payload에서 `hooks.json`의 구형 Reader 등록과 `hooks/moonshot-reader.mjs`를 제거했다. 계정 업그레이드는 Manifest가 소유한 정확한 등록·파일만 제거한다. 구형 Writer Skill의 Standalone CLI 호출 지침은 Native 위임 지침으로 교체했다. 이 경로의 Skill·Hook 설치 기대와 소유권·실패 복구 테스트도 함께 수정했다.

`local-worker-control.ts`의 Kernel Host Reader/Writer 호출자와 기존 후보·Owner·Mutation 보호는 유지한다. 명시적 Standalone `moonshot-io` CLI는 지원 중인 별도 호출 경로로 유지한다. Native Skill은 이를 호출하지 않는다. 구형 Hook 경로 이름은 기존 설치의 안전한 제거와 이전 payload 처리에 필요한 설치기 소유권 목록에서 유지한다.

공통 `moonshot-io-hook` 진입점과 `io-read-hook` 구현은 이전 payload를 설치하는 호환 경로가 사용하므로 유지한다. 설치기의 기존 URL 치환이 이 진입점을 연결한다. 현재 Native payload와 실제 계정에는 이를 호출하는 Reader 등록·wrapper가 없다. 이전 payload 처리와 사용자 소유 Hook의 충돌 검사는 계속 필요하다. 이름에 Reader가 있다는 이유로 Kernel 또는 지원 중인 호출자를 삭제하지 않았다.

## 수용 결과

Reader는 수정 후보의 완료 Run 복구 과제에서, Writer는 큰 공개 정책 회귀 테스트 과제에서 네 조건을 통과했다. 이 판정은 각 검증 과제에 한정한다. 작은 Writer의 비용 실패를 보존하며, 모든 모델·작업에 대한 절감이나 기본 자동 채택을 주장하지 않는다. 두 Skill은 실제 계정에 설치돼 있으며 명시적 선택으로 사용한다.

| 조건 | Reader 수정 후보 | Writer 큰 과제 |
| --- | --- | --- |
| ① 실제 대체 | Luna가 참조를 읽고 조건·fixture를 전달. Main Sol/medium, 기존 권한과 같은 대화를 유지. 자식 Luna/medium, `fork_turns=none` | Luna가 참조를 읽고 지정한 신규 파일을 작성. 동일한 Main 설정과 독립 자식 컨텍스트 확인 |
| ② 중복 작업 감소 | 위임 전 Skill·SPEC·package만 확인. Main 원문 전체 읽기와 선행 구현 없음. Luna 분석을 사용해 Main이 원래 회귀 테스트를 작성 | 위임 전 Skill·SPEC만 확인. Luna 작성 후 Main의 전체 파일·참조 검토와 집중된 검사 보완 두 건은 비용에 포함. 전체 파일 재생성 없음 |
| ③ 작업 품질 | 직접·위임 정상 검사 PASS, 등록한 결함 5/5 탐지. 원래 요구의 승인·명시/환경 Run·finalization·기존 Run 불변 조건 확인 | 직접·위임 정상 검사 PASS, 등록한 결함 10/10 탐지. 고정한 공개 정책 수용 조건을 생성 파일과 대조 |
| ④ 합산 비용 | 직접 `0.08043280` → 위임 `0.05884716` USD, 26.84% 감소 | 직접 `0.15688360` → 위임 `0.10443458` USD, 33.43% 감소 |

두 경로의 실제 parent rollout에서 `spawn_agent` 앞뒤의 명령 순서를 확인했다. Reader는 위임 후 원문을 다시 읽지 않았다. Writer는 먼저 Luna의 완성 파일을 받은 뒤 검토했으며, 누락된 programmatic 조합과 reasoning 결과 검사를 기존 파일의 해당 부분에 추가했다. 이 검토·수정은 사용자 허용 범위이며 비용에서 빼지 않았다. 생성 파일을 검토한 사실만으로 중복 수행 FAIL을 선언하지 않았다.

직접·위임 양쪽의 `package.json`, `reference.ts`, `SPEC.md`가 고정 입력과 일치한다. 정상 검사와 결함 검사는 실제 프로젝트의 빌드된 모듈을 import한다. 원본 모듈은 변경되지 않았고 요청 밖 파일은 관측되지 않았다. 최종 Main Turn과 App Server 종료가 모두 정상 완료됐다. Main과 모든 자식의 사용량이 존재하며 모델·effort·권한 변경도 없다. `closeout-audit.json`과 `account-summary.json`의 `verified`는 모두 true다.

| 비교 과제·경로 | 전체 input | 그중 cached input | 전체 output | input + output | 시간 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Reader 직접 | 184,569 | 161,408 | 1,797 | 186,366 | 61.384초 |
| Reader 수정 후보 위임 | 324,441 | 292,864 | 3,401 | 327,842 | 95.997초 |
| 작은 Writer 직접 | 132,260 | 116,224 | 1,582 | 133,842 | 48.192초 |
| 작은 Writer 수정 후보 위임 | 332,856 | 265,856 | 3,007 | 335,863 | 85.131초 |
| 큰 Writer 직접 | 221,507 | 175,616 | 4,754 | 226,261 | 119.089초 |
| 큰 Writer 위임 | 649,194 | 593,536 | 8,093 | 657,287 | 184.378초 |

Reader 수정 후보의 총토큰은 75.91%, 시간은 56.39% 증가했다. 큰 Writer의 총토큰은 190.50%, 시간은 54.82% 증가했다. 두 결과는 **API 환산 비용 절감**이며 **토큰 절감 또는 시간 단축이 아니다**. 작은 Writer 수정 후보는 비용 54.47%, 총토큰 150.94%, 시간 76.65% 증가로 효율 FAIL이다.

### 측정 한계

- 각 최종 과제는 직접·위임 한 쌍의 관측이다. Reader의 수정 후보는 최초 직접 결과를 재사용했다. 실행 순서·캐시·생성 변동을 통제한 반복 연구나 전체 작업 분포의 수익성을 입증하지 않는다.
- 수정 전 Reader와 두 작은 Writer 결과는 별도 개발 후보의 실패 기록으로 남는다. 최종 경로의 실행 중 재시도로 합치거나 성공한 것으로 바꾸지 않았다. 각 실행 내부의 추가 질문·검토·수정은 원래 실행에 전부 귀속했다.
- Plus의 실제 차감액은 미측정이다. 표의 비용은 기록한 API 단가의 환산치다. 이 Desktop 구현·실험 준비·외부 판정 작성 비용은 과제별 실행 비용 밖이며 전체 연구 비용 절감은 주장하지 않는다.
- 실제 사용량은 로컬 결과 캐시를 구현했다는 뜻이 아니다. 로컬 캐시·검증 결과 재사용은 사용자 요청에 따라 제외했다.
- Native 범위 지침은 보안 격리가 아니다. 기존 권한과 승인 계약을 그대로 사용한다. 일반 I/O 사용에는 Kernel Run·Proof를 요구하지 않는다. 원격 MCP 배포와 Kernel 제품 Owner 수용은 이 일반 Native 과제의 완료 조건이 아니다.

### 개발 검증과 전달 상태

`build:tests`, 기존 I/O 설치 회귀 3건, Codex payload 집중 검사, 기존 Standalone 실행·보호 회귀를 통과했다. 설치·Standalone 묶음은 11/11이다. 이 검사는 실사용 비용·품질 비교를 대신하지 않는다.

첫 bound `test:package`는 카탈로그의 프로필 Skill 분류와 I/O 테스트 등록 누락을 발견했다. 카탈로그 검사에서 공용 `skills/`와 런타임 전용 template의 출처를 구분하도록 수정했다. 특정 I/O 이름을 예외 처리하지 않았고, template Skill은 허용하면서 미등록 공용 Skill은 거부하는 회귀를 추가했다. 기존 `test:package`에 I/O 설치·Standalone 테스트를 등록했다.

테스트 등록을 고친 뒤 저장소 전체 크기 예산 초과도 드러났다. 깨끗한 `C:/dev/moonshot-relay`의 같은 기준 HEAD에서도 파일 2,395개 대 허용 2,252개, 17,142,146바이트 대 허용 15,360,918바이트로 실패했다. `baseline-surface-budget.json`에 원본을 보존했다. 해당 전역 예산을 늘리거나 검사에서 제외하지 않았다. 따라서 전체 `test:package`는 PASS로 보고하지 않는다. 이 일반 I/O 범위에서는 관련 catalog·payload·설치 회귀와 기존 `test:source-runtime`의 bound 검증을 사용한다.

최종 개발 bound 소스·설치 검증과 continuation은 증거 루트의 `kernel-report-result.json`과 `kernel-report.log`가 권위다. 최초 scope 보고에는 Run 시작 전에 이미 존재한 Reader 정책 파일을 포함해 거부됐으며, 반환된 실제 변경 목록으로 정정했다. 초기 scope 거부와 package 실패 receipt는 각각 별도 파일로 보존했다.

개발 작업의 Run은 `run-932d318c-f953-460e-bf22-831eaba0da2f`다. 일반 Native Skill은 이 Run이나 Kernel API를 호출하지 않는다. 소스 변경은 `C:/dev/moonshot-relay-luna-native-v7`에 있으며, 이 정정 범위에서 커밋·푸시·main 병합은 수행하지 않았다.
