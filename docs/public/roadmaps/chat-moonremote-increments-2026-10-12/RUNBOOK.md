# Moonremote Chat 실행과 복구

근거: 사용자가 지정한 C:/dev/chatgpt-remote-mcp의 실제 TypeScript 구현. 확인한 commit은 SOURCE_MAP에 기록했다. 아래 수치는 source schema이며 운영 배포의 설정값 보장은 아니다.

## 1. 경로와 활성 작업

get_work_context의 cwd와 파일 도구의 cwd는 MCP 실행 환경의 경로다. exec_command는 workdir를 쓴다. Windows의 C:/dev/moonshot-relay를 Linux container 경로로 추측하지 않는다. 도구 설명/default cwd와 directory 조회로 후보를 찾고 Git root/HEAD를 확인한다.

작업 시작/재개 때 정확한 cwd 또는 기존 taskId로 get_work_context를 호출한다. 기본 summary에서 상태를 확인한다. 복구·완료 판단에는 format=full과 실제 파일/증거를 함께 확인한다. full도 bounded snapshot이므로 partial/unknown 여부를 검사한다.

활성 작업이 없을 때만 checkpoint_work(mode=create)를 사용한다. 목표는 카드 하나다. 이미 전체 계획을 목표로 한 task가 있으면 그것을 재사용한다. 이때 카드 하나를 끝냈다는 이유로 전체 task를 complete_work하지 않는다. 같은 workspace의 기존 별도 작업이 진행 중이면 목표를 덮어쓰지 않는다.

## 2. 최소 읽기

- read_files: 최대 16개, 내부 동시 읽기 최대 4개. 파일당 기본 4096 bytes, 상한은 min(16 KiB, 설정의 maxFileChunkBytes).
- 계획상 기본 묶음: 카드·관련 source·테스트를 합쳐 3~6개. maxBytesPerFile=4096.
- 큰 파일은 read_file에서 nextOffset으로 이어 읽는다. byte offset을 줄 번호로 해석하지 않는다.
- 각 파일의 error/eof/nextOffset을 확인한다. read_files의 count는 모든 파일을 완전히 읽었다는 뜻이 아니다.
- 경로 검색은 제한된 디렉터리에서 rg를 사용한다. 코드 전체와 로그 전체를 한 번에 출력하지 않는다.

## 3. 수정

작은 교체는 replace_in_file의 기본 expectedOccurrences=1을 사용한다. 복수 파일 diff는 apply_patch를 쓴다. Moonremote apply_patch는 git apply용 **standard unified diff**를 받는다. Codex의 Begin Patch 형식을 보내지 않는다. checkOnly=true로 확인한 뒤 같은 기준 파일에 적용한다.

file write/append/patch/stdin은 taskId+operationId로 중복 방지되지 않는다. 응답을 잃으면 재전송 전에 read_file 또는 diff로 적용 상태를 확인한다. append를 무조건 반복하지 않는다. threeWay를 일반 복구 수단으로 켜지 않는다.

제품 코드는 src/*.ts와 canonical schema에서 수정한다. Kernel 테스트는 tests/*.ts를 수정한다. scripts/ 및 dist/의 생성 출력을 직접 고치지 않는다.

## 4. 실행

exec_command/run_script에는 실제 UUID taskId와 operationId를 함께 보낸다. 동일 실행 재시도에만 같은 operationId와 동일 실행 입력을 사용한다. 새 단계는 새 operationId다. ID는 계획서의 C00 같은 카드 ID와 다르다.

권장 요청 설정:
- workdir: 확인한 원격 Git root.
- yieldTimeMs: 750. source 기본값도 750ms다. 0~30000 범위.
- maxOutputBytes: 16384. source가 허용하는 최소값이다. 기본 설정 128 KiB보다 작은 출력으로 시작한다.
- timeoutMs: 단계별 예상시간에 맞춰 명시한다. 기본 0은 무제한이다. 일반 짧은 검증은 120000~300000ms를 시작값으로 삼고 큰 suite는 별도 배치로 나눈다.
- shell: 실제 MCP shell을 따른다. 로컬 PowerShell 문법을 Linux shell에 보내지 않는다.

한 명령은 한 가지 검증 단위로 실행한다. 거대한 설치→빌드→평가→배포 command에 합치지 않는다. 전체 로그가 필요하면 기존 테스트 runner의 report 파일을 사용하고 Chat에는 요약과 파일 참조를 전달한다.

## 5. 결과 조회

status=accepted는 실행 중이라는 뜻이다. nextCall과 sessionId를 사용한다. read_process(afterSeq=이전 nextSeq, maxOutputBytes=16384)로 새 출력만 읽는다. nextCall이 안내한 조회를 우선한다. running이고 새 출력이 없으면 waitMs를 1000~10000으로 늘릴 수 있다. 빽빽한 polling을 피한다.

프로세스가 종료돼도 hasMore=true이면 출력이 남아 있다. 출력 소진과 terminal receipt를 확인한다. nextSeq를 잃으면 afterSeq=0으로 남은 출력을 읽는다. availableThroughSeq는 읽은 cursor가 아니다.

maxOutputBytes는 조회 크기다. 전체 로그 보존 보장이 아니다. droppedOutputBytes/eviction/restart에 따른 유실이 있으면 durable report artifact로 보완한다. exitCode=0은 해당 실행의 사실이며 현재 diff의 모든 AC를 증명하지 않는다.

## 6. 체크포인트

checkpoint_work update는 병합이 아니라 최신 checkpoint 교체다. get_work_context에서 읽은 expectedRevision을 보내고 완료·현재·남은 항목을 함께 보존한다. 같은 update의 전송 재시도만 같은 requestId를 쓴다. 새 내용은 새 UUID requestId다. CAS 충돌은 최신 상태를 다시 읽고 조정한다.

checkpoint에는 다음만 짧게 기록한다.
- phase: 카드 ID와 현재 단계.
- completed/current/remaining: 카드 내 검증된 진행.
- changedPaths: 상대 경로.
- evidenceRefs: receipt operationId 또는 artifact path/sha256, 필요 시 workspaceFingerprint.
- blockers: 미해결 조건.
- executionReconciliations: unknown 실행을 현재 증거로 대조한 결과.

전체 prompt·코드·비밀값·긴 로그는 저장하지 않는다. 단계 완료, 긴 검증 시작 전, 중단/이관 시에 기록한다. 파일 읽기마다 checkpoint하지 않는다.

## 7. 불확실한 실행

| 상태 | 다음 행동 |
| --- | --- |
| prepared/running | 기존 session/receipt 조회. 새 operationId로 반복 실행 금지 |
| unknown | full context와 현재 파일/외부 효과를 대조한 후 reconciliation |
| persistence degraded | 저장 상태를 확인. 성공한 process만으로 완료 처리 금지 |
| stale checkpoint revision | 최신 context를 읽고 현재 intent와 diff를 대조 |
| Chat stream 단절 | process 중단으로 간주하지 않음. 연결 복구 후 기존 execution 조회 |
| 출력 유실 | exit receipt와 별도 report artifact 확인. 증거 없으면 해당 AC 미확인 |

unknown reconciliation의 실제 enum은 verified_no_retry, external_effect_unknown, superseded다. 작업자 판단 기록이며 관측된 execution outcome을 성공으로 바꾸지 않는다. 외부 효과가 불명확한 상태에서 억지로 completed를 선택하지 않는다.

## 8. 완료와 검증 크기

일반 TypeScript 변경: npm run build로 새 source를 검사/생성하고 해당 tests/*.mjs 진입점을 실행한다. 필요에 따라 typecheck/check:boundaries/build:check/build:tests:check를 사용한다. schema 변경은 build:contracts를 먼저 수행한다. 실제 package scripts와 build 문서를 확인하고 중복 실행을 줄인다.

카드 하나에서는 해당 동작의 positive/negative 검사로 닫는다. W1/W2 등 통합 경계와 C32에서 관련 suite를 실행한다. Kernel이 활성화됐다면 그 action이 요구한 proof 범위가 우선한다.

완료 전 파일 상태, 마지막 검증 시점, evidence digest를 대조한다. task 목표가 전부 끝나고 unresolved execution이 없을 때 complete_work(outcome=completed)를 호출한다. 이 도구는 OS process를 자동 종료하지 않는다. 다음 카드로 자동 진행하지 않는다.

STATUS.md는 사람이 보는 인덱스다. 서버 execution receipt와 프로젝트 authority를 대체하지 않는다. Kernel run의 완료는 해당 run의 authoritative done 증거로만 보고한다.

## 9. 모델-backed 검증 경계

현재 실제 운영 provider surface는 Codex다. Moonremote/CI 환경은 provider credential이나 Codex CLI를 필수 전제로 삼지 않는다. 원격 작업에서는 deterministic contract, serialization, routing, scope, hardcoding, authority, boundary, regression을 검증한다.

모델-backed 품질 검증은 로컬 Codex에서 수행한다. C01의 고정 corpus를 사용하고, prompt 비교는 case당 old/new 각 2회로 실행한다. task success, scope 위반, hardcoding/regression, tool/subagent 호출, token/latency를 기록하며 provider가 usage를 주지 않는 metric은 unavailable로 남긴다. mock 또는 정적 결과를 live 결과로 기록하지 않는다.

Claude/OpenAI standalone surface는 현재 운영 필수 gate가 아니다. 향후 실제 운영 surface로 채택될 때만 provider-specific live 평가 카드를 다시 연다. 이 정책은 구현 진행을 위해 live 평가를 거짓 통과시키는 것이 아니라, 실제 배포 surface와 검증 위치를 분리하는 것이다.

## 10. 다시 나누는 조건

제품 원본 5개 초과, 테스트 3개 초과, 새로운 저장 migration, 두 owner의 독립 변경, live eval 8회 초과가 보이면 분할을 검토한다. 숫자는 작업 크기 경보다. 원자적 변경을 인위적으로 쪼개 깨진 중간 상태를 남기지 않는다.

C09/C10은 a/b/c 평가 배치로 나눈다. C28은 strategy-case별 배치로 나눈다. 각 배치마다 terminal receipt와 다음 cursor를 저장한다. Chat가 종료되면 자동으로 깨어날 것이라 가정하지 않는다.
