# Windows App Server 및 Luna I/O v4 실행 결과

기준은 `main` / `417469c0`이다. 승인 범위는 [사용자 계획 원문](EXECUTION_PLAN.ko.md)의 S0~S4, A01~A08이다. A09 경제성 재평가는 이번 범위에서 제외한다.

Windows 실행 결함 수정, 계정 설치, 일반 Codex 개발 과제에서 Reader·Writer 기능을 검증했다. 기본 Reader Hook은 비활성을 유지한다. Writer는 명시적 위임·평가용 정책을 유지한다. 이 결과는 토큰 절감이나 품질 동등성의 경제성 채택 판정이 아니다.

원시 증거는 `C:\Users\moon\AppData\Local\Temp\moon-app-server-v4-20261112`에 보관한다. 아래 파일명은 이 디렉터리를 기준으로 한다. 로그·세션·PID·설치 Manifest는 저장소 소스로 추가하지 않는다. Kernel 최종 수용과 Git 결과는 `kernel-report-result.json`, `git-closeout.json`의 실제 receipt로 판정한다.

| ID | 판정 | 실행 증거 | 미완료 사유 |
| --- | --- | --- | --- |
| A01 | PASS | `source-native-probe.json`, `installed-native-probe.json`, 집중 회귀 | 없음 |
| A02 | PASS | 실제 PID 소멸, exit/close/stdout·stderr end, 반복 close, drain 실패 회귀 | 없음 |
| A03 | PASS | `s0-orphan-red.log`, `s0-no-tools-baseline-red.log`, `s2-transport-focused.log` | 없음 |
| A04 | PASS | `s2-code-closeout.log`: 186 PASS / POSIX 전용 2 SKIP; `s2-standalone.log`: 11 PASS | Linux/macOS 현지 실행은 NOT_RUN |
| A05 | PASS | Dry Run, `install-refresh-audit.json`, 최종 `install-final-audit.json` | 없음 |
| A06 | PASS | `reader-targeted/events.jsonl`, `terminal.json`, `acceptance.json`, `trace-audit.json` | 앞선 실패·부분 응답은 성공에 포함하지 않음 |
| A07 | PASS | `writer-bounded/events.jsonl`, 생성 파일, `acceptance.json`, `trace-audit.json` | 앞선 전체 재읽기는 I/O 대체 성공에 포함하지 않음 |
| A08 | PASS | `s4-trace-audit.json`, 실제 rollout, 도구 입출력과 SHA | 올바른 명시적 사용 사례에 한정; 자동 절감 보장 아님 |
| A09 | NOT_RUN | 기존 경제성 보류 유지 | 이번 필수 조건에서 제외 |

## S0~S2: 실행 경계와 실패 반례

- Windows 기본 명령은 전달된 환경의 PATH/PATHEXT와 작업 디렉터리에서 결정한다. 선택한 `.cmd`의 대상 패키지와 동일 설치본의 플랫폼 메타데이터를 확인하고 네이티브 파일을 `shell:false`로 실행한다. 홈·버전·vendor 하위 경로를 고정하지 않았다.
- 명시적 실행 파일 지정은 유지한다. 활성 설치본이 없거나 손상되면 명시적 오류를 반환한다. 다른 설치본이나 셸로 자동 전환하지 않는다.
- 실제 패키지 루트·패키지 관리자 환경을 설정한다. 다른 인증·모델·effort·Sandbox 설정은 유지한다.
- 서버 exit와 출력 drain을 구분한다. 기존 shutdown과 close를 재사용한다. 초기화 실패와 반복 close도 같은 정리 결과를 사용한다. drain 미확인은 `codex_app_server_drain_unconfirmed` 오류다.
- no-tools 및 늦은 실행 이벤트 거부를 유지한다. `writerExitVerified:false`도 유지한다. 임의 프로세스 트리를 종료하지 않는다.
- CLI 모의 서버는 해석된 네이티브 실행 파일을 가로채도록 수정했다. 제품에는 모의 서버 분기를 추가하지 않았다.

기존 `.cmd` 경로는 셸만 종료한 뒤 `appServerExited:true`를 반환했으며 실제 모의 서버 PID는 살아 있었다. 시험 서버에는 10초 유한 수명을 두었다. 기준 커밋의 transport를 외부 임시 파일에만 컴파일한 no-tools 반례도 drain 오류로 실패했다. 현재 제품 파일을 되돌려 시험하지 않았다.

| 시험 | 확인 범위 |
| --- | --- |
| T01 | 다른 cwd와 전달된 PATH에서 선택, 손상된 활성 패키지의 fallback 금지 |
| T02 | 실제 spawn의 네이티브 경로와 `shell:false` |
| T03 | 패키지 루트, NPM 변수, 호출자 시험 환경값 보존 |
| T04 | no-tools 정상 응답·finalMessage·종료·drain |
| T05 | 실제 소유 PID 소멸 |
| T06 | 초기화·Turn timeout, 실행 실패에서 거짓 성공 없음 |
| T07 | 동시·반복 close 결과 일관성, drain 미확인 반복 거부 |
| T08 | 초기·종료 뒤 실행 이벤트 거부 |
| T09 | 명령 누락, 네이티브 파일 누락, 명시적 실행 실패 |
| T10 | Reader·Writer standalone, 설치, 로컬·MCP, 영향 Kernel 회귀 |

Windows 집중 검사는 7개, standalone·설치 회귀는 11개가 통과했다. `npm run test:host-worker-code-closeout`의 타입·빌드·의존 경계 검사와 186개 테스트가 통과했다. POSIX 전용 2개는 Windows에서 제외했다. Linux/macOS 현지 실행을 PASS로 표시하지 않는다.

최종 Kernel bound proof의 첫 시도는 기본 300초 제한에서 `ETIMEDOUT`으로 끝났다. 앞선 동일 명령은 테스트만 261초였으며 타입·빌드 시간이 추가된다. 이 실패를 테스트 PASS로 바꾸지 않았다. 기존 검증 요청의 `timeoutMs`를 600,000으로 지정해 재실행하며, 첫 실패는 `kernel-report-first-timeout.json`에 보존한다. 최종 수용은 재실행 receipt로 판정한다.

실제 활성 설치본은 npm의 `codex-cli 0.162.1`이었다. 기본 resolver가 선택한 해당 설치본에서 `initialize → config/read → 종료`를 실행했다. 이 probe의 모델 Turn은 0회다. PID 소멸과 exit/close/stdout·stderr end를 확인했다. Desktop의 별도 설치본으로 전환하지 않았다.

초기 CLI 회귀의 test double은 명령명 `codex`만 가로챘다. 네이티브 전환 뒤 3개 시험이 실제 설치본에 연결되어 Turn timeout으로 실패했다. 해당 provider 사용량은 미확인이며 0으로 간주하지 않는다. test double을 격리된 실행 파일의 spawn을 가로채도록 고친 후 11개 회귀가 통과했다. 초기 실패는 실사용 성공이나 경제성 근거에 포함하지 않는다.

## S3: 계정 설치와 보존

기존 설치기의 `--runtime codex --codex-io-only --dry-run --json` 후 같은 경로로 설치했다. 설치 transport와 현재 생성 산출물의 해시가 같다. Manifest 파일 해시 1,957개가 일치했으며 Hook 정의는 설치기가 별도로 검사했다. 설치 경로의 무모델 실행·종료도 통과했다.

처음 오래된 스냅숏과 비교할 때 Codex `.system` Skill 파일 8개가 달랐다. I/O 설치 범위는 이 파일을 쓰지 않는다. 초기 차이를 PASS로 덮거나 사용자 파일을 복원하지 않았다. 설치 직전 새 스냅숏으로 재설치한 검사에서 보호 파일 차이 0개, Manifest 불일치 0개를 확인했다. 초기 `install-audit.json`과 새 검사는 모두 남겼다.

Reader는 별도 `moon-io-v4-reader-scope.config.toml` 시험 프로필에서 기존 Hook 신뢰 해시를 유지해 활성화했다. 신뢰 우회 옵션은 사용하지 않았다. 시험 후 프로필 파일을 제거했다. 계정 `config.toml`의 Hook 비활성 값, AGENTS, Writer Skill과 기존 Hook 정의는 변경하지 않았다.

## S4: 일반 Codex 개발 과제

Main은 실제 계정의 `codex exec`이며 rollout의 `turn_context`에서 모두 `gpt-6.1-sol` / `medium`, CLI `0.162.1`을 확인했다. 실제 Helper 응답의 요청·해결 모델은 모두 `gpt-6-luna` / `medium`이다. `observedModel`은 제공되지 않았으며 별도 provider identity 증거가 있다고 주장하지 않는다.

과제와 수용 조건은 모델 실행 전에 `s4-registration.json` 및 각 `SPEC.md`에 고정했다. 격리된 일반 개발 디렉터리에서 실제 프로젝트 소스를 참고하고 실제 생성 모듈을 import하는 회귀 테스트를 작성했다. 시험용 제품 분기나 구현 로직 복제는 없다. 경제성 A/B 비교도 수행하지 않았다.

### Reader

원본은 `src/kernel/run/invocation-resolver.ts`, 450줄·16,784바이트다. 원래 과제는 완료된 Run의 recovery 조건, 오래되거나 없는 acknowledgement, new-task 부재, 동일 workspace, explicit/env Run ID와 미완료 finalization을 검사하는 새 회귀 테스트 작성이다.

1. `reader`: 점이 포함된 Hook 상태 키의 CLI override가 무시됐다. 원문 전체가 Main에 전달됐다. 테스트 9개와 결함 주입 5개는 통과했지만 Reader 호출이 없어 A06/A08 성공으로 집계하지 않았다.
2. `reader-profile`: Hook이 전체 읽기를 차단하고 Luna가 4,287바이트 일반 요약을 반환했다. fresh-baseline 설명에 explicit/env Run ID 제외 조건이 빠졌다. Main은 범위 읽기 후 테스트 13개와 결함 주입 5개를 통과했지만 Reader 내용 PASS로 집계하지 않았다.
3. `reader-targeted`: 같은 원본·원래 수용 조건을 유지하고 기존 Hook 지침대로 질문을 실제 recovery 조건으로 좁혔다. 2,451바이트 답변은 필수 조건과 finalization 우선 처리를 포함했다. Main은 필요한 원문 범위와 관련 코드를 교차 확인해 테스트 39개를 작성·통과했다. intent·정확한 acknowledgement·변경 workspace·요청 ID·finalization 검사를 제거한 결함 5개도 검출했다. 원본 전체는 Main 도구 출력으로 반환되지 않았다.

단독 Reader 선행 호출은 응답·identity·사용량을 확인하는 데만 사용했다. 일반 세션 완료 증거를 대체하지 않았다. 추가 읽기와 코드 생성은 실제 사용량에 포함했다. 원본 전체를 읽지 않았다는 사실이 전체 입력 토큰 감소를 뜻하지는 않는다.

### Writer

참조는 `src/host/kernel/codex-model-policy.ts`와 사전 고정 SPEC다. 과제는 실제 `resolveCodexCapabilityDelta`의 엄격한 boolean, programmatic gate, 이유 값, 동결 객체와 입력 보존을 검사하는 새 파일 작성이다. 두 시도 모두 설치된 Writer Skill과 한 번의 stdin `io-write - --apply`를 사용했다.

1. `writer`: 4,025바이트 파일을 저장했다. 응답은 `code`가 없는 766바이트 메타데이터였다. 테스트 5개와 결함 주입 5개가 통과했다. 그러나 이후 Main의 넓은 `rg -A/-B` 검토가 비어 있지 않은 116줄 전체를 반환했다. 전체 I/O 대체 성공으로 집계하지 않았다.
2. `writer-bounded`: 같은 과제에서 테스트를 먼저 실행하고 필요한 범위를 검토했다. 4,292바이트 파일을 저장했고 응답은 778바이트 메타데이터였다. 테스트 6개와 결함 주입 5개가 통과했다. Main은 코드를 다시 생성·수정하지 않았다. 저장 결과 SHA와 최종 SHA가 같다. 생성 코드 전체를 반환한 도구 응답은 없다.

두 번째 시도도 검토는 작지 않았다. 번호가 붙은 읽기·검색으로 확인한 비어 있지 않은 줄은 합계 95/112줄이다. 이를 숨기거나 메타데이터 778바이트만 전체 비용으로 계산하지 않는다. 필요한 검토도 상당한 입력 비용을 만들 수 있다. 자동 절감 보장이 아니다.

### 실제 사용량과 추가 작업

아래 값은 실제 `turn.completed`와 Helper 응답이다. cached input은 input의 부분집합이며 따로 더하지 않는다. reasoning output도 output에 포함한다. cache-write input은 모두 0이다. 로컬 캐시나 결과 재사용은 구현하지 않았다.

| 시도 | Main input / cached / output | Luna input / cached / output | 벽시계 시간 | 보수적 판정 |
| --- | --- | --- | --- | --- |
| Reader Hook 설정 실패 | 118,922 / 100,992 / 1,775 | 호출 없음 | 53.156초 | FAIL |
| Reader 일반 요약 | 163,204 / 145,792 / 2,114 | 21,836 / 0 / 872 | 76.559초 | PARTIAL |
| Reader 정확한 질문 | 316,676 / 276,480 / 3,337 | 20,764 / 0 / 503 | 115.086초 | PASS |
| Writer 전체 후속 재읽기 | 223,039 / 206,336 / 899 | 20,907 / 0 / 1,242 | 60.100초 | I/O 대체 FAIL |
| Writer 범위 검토 | 270,083 / 234,880 / 1,166 | 19,763 / 14,336 / 1,391 | 69.725초 | PASS |

직접 Reader 선행 호출은 별도로 Luna input 21,850, cached 0, output 261이다. 일반 세션 5개 Main 합계는 input 1,091,924, cached 964,480, output 9,291이다. 일반 세션 Helper 4회 합계는 input 83,270, cached 14,336, output 4,008이다. 실패·부분 시도도 합계에 남긴다.

모든 일반 세션은 종료됐다. `s4-trace-audit.json`에 실제 rollout 위치, 파일 SHA, 원문 전달과 생성 파일 재전달을 기록했다. 도구 stdout 합계는 Reader 성공 시도 32,651바이트, Writer 성공 시도 11,871바이트다. SPEC·Skill·추가 소스·테스트 로그가 섞인 수치다. 특정 파일만의 입력이나 토큰 수로 바꾸지 않는다.

외부 수용 검사·이 응답 세션의 검토·초기 timeout 호출의 미확인 사용량·구독 실제 차감액은 표에 포함되지 않는다. 전체 비용 절감의 증거가 아니다. 성공한 시도만 골라 품질 동등성이나 3/3 채택 조건을 충족했다고 주장하지 않는다. 기존 경제성 보류를 유지한다.

## 범위와 남는 한계

- 기존 transport·Reader·Writer·설치기·일반 도구를 사용했다. Router·DB·Queue·Scheduler·별도 프로세스 관리·캐시·Reviewer·검증 전용 제품 API를 추가하지 않았다.
- Reader sources는 원본 SHA이며 사실 검증 증명이 아니다. 실제로 불완전한 요약이 관측됐다. 기본 자동 채택은 켜지 않았다.
- Writer의 짧은 저장 응답은 후속 Main의 광범위한 재읽기를 막지 않는다. 성공한 범위 검토와 실패한 전체 재읽기를 모두 기록했다.
- 기존 파일 보호·신규 생성 정책을 유지한다. 다파일 트랜잭션·로컬 재사용·Worker의 추가 위임은 도입하지 않았다.
- App Server 종료는 알 수 없는 도구 자손 종료나 Windows/Linux 신규 Kernel 제품 Proof·Owner 적용 권한을 주지 않는다. 기존 보호 규칙을 유지한다.
- Kernel `done`과 커밋·푸시 receipt는 별도로 확인한다. 이 문서의 기능 PASS가 그 권한을 대신하지 않는다.
