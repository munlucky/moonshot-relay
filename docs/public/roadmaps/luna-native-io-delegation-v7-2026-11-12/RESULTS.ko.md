# Luna I/O Native Subagent 리팩토링 v7 검증 기록

이 문서는 이전 v7 수용 계약의 기록이다. 사용자가 정정한 네 조건에 따른 후속 결과는 `NATIVE_IO_RESULTS.ko.md`에서 확인한다.

- 기준 커밋 `a1131a397470b4a56b4076f0e4e4a6f835ecf062`
- 계획 원본 `moonshot-relay-luna-io-delegation-final-v7.md`, SHA-256 `b4dc5d4984188893f199041cc6f73ff798bc38bb83acebb4a2fe23cd493f5bcb`
- Windows Codex CLI `0.162.1`, 격리 작업 트리 `C:/dev/moonshot-relay-luna-native-v7`
- Kernel Run `run-9caa13c1-76de-42b6-88b4-03c32e7bdf5c`
- 원시 실행 기록 `C:/Users/moon/AppData/Local/Temp/moon-luna-native-v7-20261112`

## 실행 계약과 권한

- 기본 Codex `spawn_agent` 호출에서 `model=gpt-6-luna`, `reasoning_effort=medium`, `fork_turns=none`이 수용됐다. 부모 Sol/medium과 자식 Luna/medium의 설정은 각각 rollout에 기록됐다. 부모만 받은 표식은 부모 rollout에 존재하고 자식 rollout에 없다. App Server에 부모 전용 동적 도구를 등록한 별도 시험에서는 부모 호출 한 건이 기록됐고 자식은 도구를 사용할 수 없다고 응답했다.
- 첫 신규 파일 생성은 `elevated` Sandbox의 `helper_unknown_error: setup refresh had errors`로 실패했다. 현재 실행 중인 `node_repl.exe`의 ACL 검증에서 Windows 공유 위반 32가 발생했다. 모델 인증 및 Luna 실행은 정상이다. 같은 Codex의 격리 시험에 `unelevated`를 명시하자 검색, 범위 읽기, 신규 파일 생성이 성공했다. 사용자 계정의 Sandbox 설정은 시험 전후 동일하다.
- Hook 시험은 동일한 파일, 질문, 모델, Sandbox로 실행했다. H1은 기존 `PreToolUse`가 Luna의 `Get-Content`를 막았다. H2는 같은 설정에서 해당 Hook만 비활성화해 답을 얻었다. `-c` 경로 해석 오류와 줄바꿈 때문에 Hook이 켜진 채 실행된 초기 H2 시도도 보존했다.
- 읽기 전용 Main에서 Luna가 표식을 읽었고 파일 쓰기는 운영체제가 거부했다. 쓰기 가능한 Main에서 Luna는 기존 파일을 덮어쓰고, 지정 밖 파일을 만들고, 오류가 발생한 뒤 부분 파일을 남겼다. 이 시험의 참조 파일, 외부 경로, 정션 대상은 변경되지 않았다. 이 세 건의 거부만으로 Writer의 권한을 증명할 수 없다. 기존 Writer의 `wx`, SHA와 경로 검사가 계속 필요하다.

Codex는 자식에 부모 턴의 Sandbox와 승인 설정을 상속한다. 사용자 정의 Agent 설정의 `sandbox_mode`로 별도 자식 권한을 설정할 수 없다. [OpenAI Codex 서브에이전트 권한 계약](https://learn.chatgpt.com/docs/agent-configuration/subagents)

## 실제 개발 과제와 재읽기

- Reader는 실제 `resolveBoundInvocation`에 회귀 테스트를 추가했다. Sol/medium의 명시적 요청과 Astra/low의 격리 자동 정책에서 Luna/medium이 읽기 전용 분석을 수행했다. 같은 Main 세션의 후속 쓰기 턴에서 테스트를 생성했다. 두 결과 모두 정상 테스트와 결함 반례 다섯 건을 통과했다. 간단한 값 조회는 자식 호출 없이 완료됐다.
- Writer는 Sol과 Astra 세션에서 Luna가 `resolveCodexCapabilityDelta` 테스트 파일을 직접 생성했다. 두 결과 모두 정상 테스트와 결함 반례 다섯 건을 통과했다. 일반 요청의 자동 Writer 시험도 파일과 테스트 결과를 만들었으나 Main이 위임 전에 참조 전체를 읽고 생성 코드 대부분을 다시 읽었다.
- 초기 Reader의 Main에는 원문 고유 비어 있지 않은 줄 279개 중 Sol 271개, Astra 260개, 설치본 시험 264개가 재전달됐다. 생성 결과만 확인해 C06을 통과 처리하지 않았다. 세션 로그에서 `spawn_agent` 전후를 나누고 명령 출력의 원문 줄과 대조했다. 결과는 `c06-coverage.json`에 있다.
- 격리 Windows 셸의 기본 Node 테스트 프로세스가 `spawn EPERM`으로 시작하지 못했다. Codex 세션에서는 같은 파일을 `node --test --test-isolation=none`으로 실행했다. 별도의 일반 로컬 검증에서 정상 모듈과 결함 주입 모듈로 테스트를 다시 실행했다.

## 기존 경로 유지

`createHostIoReader`와 `createHostIoWriter`는 `local-worker-control.ts`를 통해 Kernel MCP와 로컬 Worker Host에서 사용된다. `moonshot-io` CLI는 같은 실행기를 별도 Standalone 계약에서 사용한다. Reader CLI는 원본 SHA와 변경 상태를 반환하고, Writer는 지정된 신규 파일을 보호한다. 기존 Hook은 쓰기 가능한 Main 세션에서도 독립된 도구 없는 Reader를 안내한다. 새 읽기 전용 Skill이 이 호출자와 계약을 대체한 증거가 없다. 구형 코드와 사용자 설정을 유지한다.

초기 Kernel Run은 이전 완료 이후 Git 상태가 바뀐 `main`에서 `successor_workspace_continuity_mismatch`로 거부됐다. 같은 기준 커밋의 분리 worktree에 새 Kernel Run을 바인딩했다. `/shared/moonshot-relay`에는 별도 작업 체크포인트가 있어 그대로 유지했다.

## 수정 후 Reader 검증

Skill에는 누락된 조건을 같은 자식에게 질문하고, 직접 확인할 때는 근거 범위만 읽도록 명시했다. 명시적 사용 정책은 `allow_implicit_invocation: false`다. 계정의 기본 자동 위임은 비활성이다.

- `reader-refined-sol`은 Skill을 읽는 명령과 원문 전체 읽기를 함께 실행했다. 위임 전에 원문 고유 줄 279개가 Main에 들어갔다. 이 실행은 개선 성공 증거가 아니다.
- `reader-refined-auto-astra`는 원래 과제와 결함 반례 다섯 건을 통과했다. 전체 두 턴을 합치면 원문 고유 줄 279개 중 145개가 Main에 들어갔다. 읽기 전용 분석 단계만 보고 개선을 인정하지 않았다.
- `reader-structured-sol`은 기존 App Server의 `skill` 입력으로 Skill을 먼저 선택했다. 그래도 Main은 Luna의 답변 뒤에 `1–65`, `130–205`, `215–270`, `285–435` 범위를 읽었다. 원문 고유 줄 279개 중 223개가 재전달됐다. 원문 재전달 문제는 명시적 Skill 선택으로 해결되지 않았다.
- 마지막 시험은 시험 스크립트의 180초 제한이 App Server를 종료했다. 파일 생성과 외부 정상·결함 검사는 통과했지만 Main의 마지막 테스트 턴은 완료되지 않았다. 같은 스레드 재개는 `already has an active writer`로 거부됐다. 관련 시험 App Server 프로세스는 현재 없다. 이 결과의 원래 세션 완료는 미검증이다. 종료한 시험 스크립트와 Windows 프로세스 상태를 증거로 남겼다.

줄 수 검사는 빈 줄을 빼고 공백과 줄 번호를 정규화한 고유 줄을 비교한다. 공통 문법 줄도 일치할 수 있다. 판정에는 실제 명령과 출력도 함께 확인했다. 원문 출력의 고정 허용 비율을 제품 정책으로 추가하지 않았다.

## R5 경제성 결과

모델·effort·작업 유형별로 직접 처리와 Native 위임을 세 쌍씩 비교했다. Reader는 CLI 조건, 완료 Run 복구 조건, Standalone 적용 조건을 질의했다. Writer는 실제 capability-delta 모듈의 회귀 테스트 생성을 세 번 반복하고, 정상 검사 및 결함 반례 다섯 건을 적용했다. Main과 자식의 최종 누적 사용량을 합산했다. 캐시 입력은 전체 입력의 부분집합이며 추론 출력은 전체 출력에 포함된다.

| Main / effort / 유형 | 동일 품질 | 직접 환산 USD | 위임 환산 USD | 비용 절감 | 시간 증가 | 판정 |
| --- | --- | --- | --- | --- | --- | --- |
| Sol / medium / Reader | 2/3 | 0.145462 | 0.125639 | 13.63% | 73.73% | FAIL |
| Astra / low / Reader | 3/3 | 0.768272 | 0.661561 | 13.89% | 87.91% | FAIL |
| Luna / medium / Reader | 3/3 | 0.010833 | 0.020714 | -91.22% | 81.61% | FAIL |
| Sol / medium / Writer | 3/3 | 0.233005 | 0.216787 | 6.96% | 33.90% | FAIL |
| Astra / low / Writer | 3/3 | 1.175976 | 1.157159 | 1.60% | 53.10% | FAIL |
| Luna / medium / Writer | 2/3 | 0.019340 | 0.024344 | -25.87% | 18.54% | FAIL |

Sol Reader의 실패 응답은 실제 소문자 오류 이름을 대문자로 바꿨다. Luna Writer의 한 직접 처리 결과는 정상 검사만 통과하고 요구된 결함 검출을 충족하지 못했다. 품질 실패를 제외한 표본만 골라 절감률을 다시 계산하지 않았다.

환산 단가는 입력·캐시 입력·출력 100만 토큰당 Sol `2/0.1/10`, Astra `10/1/50`, Luna `0.1/0.01/0.5` USD를 사용했다. 실제 Plus 계정 차감액은 미측정이다. API 환산 결과를 구독 계정 청구액으로 표현하지 않는다. 원본 사용량과 계산은 `trace-audit.json`, `trace-audit.mjs`에 있다. [OpenAI API 가격](https://developers.openai.com/api/docs/pricing)

표의 품질은 각 평가 과제의 판정이다. Writer의 별도 R2 보호 실패도 계속 유효하다. 어떤 조합도 C11의 품질 3/3, 비용 15% 절감, 시간 증가 25% 이내 조건을 모두 만족하지 못했다.

## R6 설치 시험과 복구

기존 설치기의 소유권 검사와 트랜잭션에 Reader Skill 두 파일을 연결했다. 일반 복사 경로가 이 파일을 먼저 덮어쓰지 않도록 기존 복사 함수에서 관리 파일을 제외했다. 기존 설치 테스트의 병합, 사용자 설정 보존, 이전 payload 적용, 실패 시 복구 범위에 Reader 두 파일을 포함했다.

최초 후보를 실제 계정에 설치했고 저장소·Manifest·설치본 해시가 일치했다. 설치본을 사용하는 새 세션이 원래 과제와 정상·결함 검사를 통과했다. 이 세션에서도 원문의 264/279줄이 Main에 재전달돼 C06은 실패했다. 수정 후보는 계정에 영구 채택하지 않았다.

기존 기준선 payload를 materialize하고, Reader 소유권을 인식하는 작업 트리 설치기로 Dry Run 후 복구했다. 실제 제거 대상은 시험으로 추가한 `skills/io-reader/SKILL.md`, `skills/io-reader/agents/openai.yaml` 두 파일이다. 기존 Writer Skill과 Reader Hook은 사용자를 위해 유지되는 기존 기능이다. R4에서 확정 제거한 기능은 없다.

복구 뒤 `config.toml`, 계정 AGENTS, Hook, Skill의 전체 파일 해시가 최초 스냅숏과 일치했다. 복구 직전 대비 변경은 Reader 파일 두 개의 제거뿐이다. `rollback-audit.json`의 `verified`와 `initialUserFilesPreserved`가 모두 true다. 시험 전용 Hook 프로필 두 파일도 사본 해시를 확인한 뒤 제거했다. 최초 설치 당시 별도 Codex 실행과 겹친 `.system` Skill 차이는 최종 검사에서 해소됐다.

패키지 검증과 I/O 설치·전송·CLI 회귀를 통과했다. 추가 Kernel Host·읽기·쓰기 보호·작업 트리 바인딩 회귀는 82/82 통과했다. 이 회귀는 Native C06/C08 실패를 대체하는 증거가 아니다.

## 수용 기준과 남은 작업

| 판정 | 실행 증거 위치 | 미완료 사유 | 결정 |
| --- | --- | --- | --- |
| C01 PASS | `trace-audit.json`의 R0/R3 Main modelHistory | 해당 없음 | Sol/medium, Astra/low 및 Luna/medium 평가의 실제 설정 확인 |
| C02 PASS | R0/R3 자식 rollout과 spawn 기록 | 해당 없음 | Luna/medium 독립 실행 확인 |
| C03 PASS | R0 부모 표식과 자식 초기 입력, `fork_turns=none` | 해당 없음 | 최소 입력 계약 확인 |
| C04 PASS | R0/R3 자식 명령과 실제 생성 파일 | 해당 없음 | 기존 Codex 읽기·쓰기 능력 확인 |
| C05 부분 PASS | 격리 `reader-auto-astra`, `writer-auto-sol`, `reader-small` | 자동 위임 후 전체 과제의 C06/C08은 실패 | 자동 선택 능력만 확인, 기본 채택 보류 |
| C06 FAIL | `c06-coverage.json`, 각 부모 rollout의 실제 명령 | Reader의 반복 대량 재읽기, 자동 Writer의 선행 전체 읽기와 생성물 재읽기 | 위임·과제 검사 성공과 별도로 실패 유지 |
| C07 부분 PASS | R3 각 `acceptance.json`, 정상·결함 검사 로그 | `reader-structured-sol`의 마지막 Main 턴 중단 | 완료한 과제 결과만 인정, 중단된 세션 완료는 미검증 |
| C08 Writer FAIL, Reader 제한적 PASS | `r2-reader-events.jsonl`, `r2-writer-events.jsonl`, Kernel 회귀 82건 | Native Writer의 기존 파일·지정 밖 쓰기와 부분 파일 허용. Reader 보호는 read-only Main 턴에서 확인 | Host Writer 보호 유지. 일반 writable Main에서 Reader 보호를 추정하지 않음 |
| C09 NOT_RUN | 기존 호출자 조사와 Git diff | 기능별 R2·R3 및 C06 대체 조건 미충족 | 기존 Kernel·Standalone·Hook 호출 경로 유지. 전체 리팩토링 미완료 |
| C10 미완료 | `r6-install.json`, `r6-account-audit.json`, 설치본 과제, `rollback-audit.json` | 초기 설치본의 C06 실패. 수정 후보 설치 채택 보류 | 시험 설치·원복은 검증. 최종 기능 설치 완료로 판정하지 않음 |
| C11 FAIL | `trace-audit.json`의 6개 metrics | 각 조합이 품질·비용·시간 기준 중 하나 이상 미달 | 모든 평가 단위의 기본 자동 채택 보류 |

원시 기록의 기준 디렉터리는 문서 첫 부분에 기재했다. 위 표의 부분 PASS와 미완료는 해당 수용 항목 전체의 PASS를 뜻하지 않는다. 전체 C01~C10 완료 조건은 충족되지 않았다.

현재 구현 후보는 분리 작업 트리에 남겼다. 제품에 새 I/O 엔진, 라우터, 저장소, 재시도 경로를 추가하지 않았다. 기존 Native 자식의 상속 권한은 신규 파일 하나만 허용하는 보호를 제공하지 않는다. 계획이 금지한 별도 격리·작성 엔진을 도입하지 않는 범위에서는 Writer의 동등 보호를 확보할 수 없다. Reader의 C06도 실제 반례가 남아 있다. 전체 완료 및 기본 경제성 채택을 주장할 수 없다. 커밋·푸시는 수행하지 않았다.
