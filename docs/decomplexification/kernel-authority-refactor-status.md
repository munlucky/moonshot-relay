# Kernel 구조 통합 구현 및 검증 연결

기준: `aca19ec85cf06f40860e07ef5006b37b02f7a260`. 작업 브랜치: `refactor/kernel-authority-20261005`.
계획 원본: 2026-10-06 사용자가 첨부한 최종 작업계획서. 이 문서는 구현과 검증의 연결을 기록한다. 완료 판단은 Kernel Run `run-4b2515b2-21bf-4d89-8292-256d34351c22`의 `next.action.type=done`으로 확인한다.

## 진행 확인

작업 재개 시 기존 변경은 79개 tracked 파일과 20개 신규 파일에 있었다. 기존 구현은 Work/Host 경계 이동, 단일 Attempt, report operation 식별, Evidence 계층, Knowledge 보존까지 확장돼 있었다. 실제 Run Journal은 없었다. 실패 corpus는 검사 파일을 실행하지 않는 메타데이터였다. 전체 회귀 검사와 실제 Host 증거도 남아 있었다.

재개 후 추가한 변경:

- 같은 SQLite DB 안에 append-only lifecycle Journal을 추가했다. Authority transaction이 성공할 때만 fact를 기록한다. Journal은 현재 상태를 결정하지 않는다.
- SQLite 초기화 및 migration 실패 시 연결을 닫는다. Windows의 DB 파일 잠금 누수를 제거한다.
- Gemini semantic adapter와 fresh CLI launcher를 추가했다. 실제 dispatcher가 전달하는 `hostExecutionContract` v2를 사용하며, dispatcher 전체 경로를 semantic 검사한다. 인증 또는 관측값이 없으면 실패를 명시한다. 요청한 model 값을 실제 관측값으로 쓰지 않는다.
- 실패 사례 20개가 실제 behavioral test를 실행하도록 연결했다. 기존 reliability 검사도 단일 진입점에서 유지한다.
- process와 session을 재시작하는 Golden E2E를 보강했다. transcript 없이 완료 Work와 현재 cursor를 복원한다.
- 범위 변경 때 현재 Work만 남기던 결함을 수정했다. 미완료 후속 Work를 보존한다. `next`의 progress에는 이전 계획의 완료 이력도 포함한다.
- 명시적 의존성을 가진 Work를 재계획할 때 이전 계획의 완료 이력으로 준비 상태를 계산한다. 같은 transaction에 준비 상태를 저장한다. cursor도 전체 이력으로 의존성을 확인하고 현재 계획의 Work를 선택한다.
- 테스트 등록 검사는 상대 import를 따라 검사 파일의 도달 가능성을 계산한다. 순환 import를 처리한다. 등록되지 않은 파일은 계속 거부한다.
- surface budget 기준은 계획의 고정 commit에서 다시 산출했다. 허용 증가량 및 미등록 테스트 허용값은 변경하지 않았다.
- acceptance가 root proof를 work evidence로 낮추지 못하도록 했다. goal evidence가 없으면 Goal을 완료하지 않는다.
- Work/cursor 저장 전에 같은 Attempt에 verified report checkpoint를 보존한다. 중단 후에는 proof를 다시 실행하지 않고 저장된 continuation을 완료한다. 최종 결과는 immutable replay로 반환한다.
- direct report에 operation key를 반환한다. cursor 이동과 process 재시작 뒤에도 같은 report를 재생한다. 다른 payload를 같은 key로 제출하면 거부한다. implicit replay는 현재 workspace가 이전 Attempt의 결과와 같을 때만 선택한다. 파일을 고친 뒤 같은 payload를 제출하면 새 Attempt를 실행한다.
- workspace의 마지막 mutation epoch를 보존한다. 잠금 해제와 process 재시작 뒤에도 fencing 번호는 증가한다.
- corpus 20개를 각 behavioral test의 이름과 연결했다. 실제 worktree 재연결과 local bare remote push 재시도 검사도 추가했다.

## Wave 연결

| Wave | 구현 경계 | 주 검증 |
|---|---|---|
| 0–1 | baseline 및 Work/Trust/Knowledge write owner | `kernel-authority-write-boundary`, `kernel-decomplexification-characterization` |
| 2 | Work ledger, 단일 Attempt, 별도 report key/payload | `kernel-run-step-replan`, `kernel-report-replay`, `kernel-report-identity-migration` |
| 3 | Kernel logical binding, Host physical worktree | `kernel-worktree-binding`, `kernel-mutation-guard`, `kernel-workspace-mutation-lock` |
| 4 | 모든 실행은 canonical Work Attempt 사용 | `kernel-parallel-fencing`, `kernel-independent-subagent-review` |
| 5 | 새 session에서 Run 재개 | `kernel-session-run-lifecycle`, `kernel-real-goal-golden-e2e` |
| 6 | Control Envelope와 Model Work View 분리 | `kernel-model-capsule-view`, `kernel-turn-dispatcher-envelope` |
| 7–8 | provider adapter의 semantic contract | `kernel-host-semantic-conformance`, `kernel-host-model-contract` |
| 9 | Host route admission, Kernel receipt 검증 | `kernel-route-admission-drift`, `kernel-route-admission-review` |
| 10–11 | work/integration/goal proof 및 freshness | `kernel-evidence-semantics`, `kernel-review-receipt-freshness` |
| 12 | 독립 review activation 및 transport 회복 | `kernel-review-host-bridge`, `kernel-review-cross-process`, `kernel-review-claim-recovery` |
| 13 | 단순 작업 direct Work, 복잡 작업 조건부 분해 | `kernel-conditional-planning-recovery`, `kernel-bounded-work-unit` |
| 14 | 기존 Knowledge의 scoped projection 및 reuse | `kernel-knowledge-context`, `kernel-knowledge-reuse-e2e`, `kernel-finalization-knowledge-nonblocking` |
| 15 | 기존 asset catalog의 REFERENCE/VALIDATED/ACTIVE 선택 | `capability-assets-check`, `kernel-capability-resolution` |
| 16–17 | coordinator와 persistence 경계; 중복 repository 제거 | `kernel-runtime-boundary-static`, `kernel-authority-write-boundary` |
| 18 | 같은 DB의 lifecycle Journal | `kernel-real-usage-regression`의 Journal rollback/append-only/reopen 검사 |
| 19 | retired Attempt table, session/task selector, mutation lock, duplicate wrapper 제거 | `kernel-runtime-boundary-static`, `kernel-report-identity-migration` |

State Store는 세 Authority의 명명된 write API와 하나의 SQLite transaction/schema를 유지한다. 추가 repository wrapper나 새 DB를 만들지 않았다. ownership 목록은 `kernel-write-ownership.json`에 있다. Control Plane의 LOC는 완료 기준으로 쓰지 않는다. Host turn/routing/admission/physical-worktree 구현은 `scripts/host/kernel/`에 있다.

## Acceptance 연결

| AC | 증거 경로 또는 검증 |
|---|---|
| 01–03 | ownership contract, runtime boundary, capability resolution |
| 04–07 | session lifecycle, report replay/conflict, replan history, process restart Golden E2E |
| 08–10 | physical worktree Host 모듈, binding/mutation guard/fencing |
| 11–12 | work/integration/goal evidence 및 stale receipt 거부 |
| 13–14 | review activation/claim/transport fallback 및 receipt integrity 거부 |
| 15 | Codex 실제 두 세션의 Work 실행/재개, root proof, 독립 Host review receipt 및 fixture Run done |
| 16–17 | Claude/Gemini semantic conformance; concrete model/session 값은 Host 경계에서 처리 |
| 18–20 | Knowledge cross-run reuse, scoped retrieval, nonblocking code acceptance |
| 21–24 | 기존 단일 DB 및 Authority 유지, 중복 wrapper/legacy writer 제거, 경계 static 검사 |
| 25 | provenance가 있는 S-01–S-20 fixture 및 실제 regressionTests 연결 |
| 26–27 | work-unit recovery, workspace recovery, claim recovery, Golden E2E |

## 실제 실행과 protocol 검증

사용자가 현재 가능한 환경을 Codex와 Qwen으로 제한했다. 두 CLI에서 실제 terminal 응답을 확인했다. Qwen Code의 실제 응답은 configured backing model `gpt-6-luna`를 보고했다. Qwen CLI 성공을 별도의 Kernel adapter 또는 review receipt 성공으로 해석하지 않는다. Qwen의 인증된 실제 session 3개에는 shell과 파일 쓰기 도구가 없었다. 공식 simple mode에는 해당 도구가 있지만 account 인증을 읽지 못해 API key 오류가 발생했다. Qwen 전체 Kernel E2E는 환경 제한으로 완료하지 못했다.

Codex 실제 fixture Run `native-codex-388408fd-b75e-443b-8140-229ce55ef23c`는 서로 다른 실제 세션에서 Work 2개를 수행했다. SQLite 상태로 두 번째 Work를 재개했고 Kernel root proof를 통과했다. 실제 read-only 독립 reviewer의 receipt는 `review-receipt-28addbf1d0b88b53988d4fbf`이다. 이 fixture의 `next.action.type`은 `done`이다. model, effort, native session과 usage는 실제 CLI event와 rollout에서 관측했다. fixture 완료와 본 refactor Run 완료를 구분한다.

Claude/Gemini adapter의 injected 검사는 protocol 증거다. 실제 Claude 연결은 거부됐고 Gemini 인증은 없다. 두 환경의 native 성공을 주장하지 않는다. 상세 관측은 `kernel-host-native-gates.json`에 있다.

최종 root 검사, 독립 보안 review, completion, Knowledge commit은 Kernel DB의 receipt로 확인한다. 직접 실행한 테스트 로그나 이 문서가 해당 receipt를 대신하지 않는다. 실행 로그는 account runtime의 `contracts/kernel-authority-refactor-20261006/`에 보관한다. 패키지 source에 로그나 DB를 넣지 않는다.

기존 kernel-commit 사용자 파일 6개는 이번 작업에서 수정하지 않았다. 기존 사용자 hash는 원본 checkout `C:\dev\moonshot-relay`의 6개 파일과 일치한다. 현재 worktree의 보호 기준은 고정 commit `aca19ec85cf06f40860e07ef5006b37b02f7a260`의 파일 내용이다. 두 checkout의 기준을 구분하며, 한쪽 파일을 다른 쪽에 덮어쓰지 않았다. Git commit/push/merge는 이번 Task의 범위 밖이다.


Asset catalog의 현재 coverage는 788개 경로다. 삭제된 wrapper를 제거하고 Host 모듈 및 새 검사 경로를 등록했다. 고정 commit의 provenance 경로는 원래 경로를 유지한다. 현재 구현 경로는 subcapability와 coverage ledger에서 별도로 연결한다.

Reliability는 단일 npm command에서 Node 기본 runner로 파일별 격리와 병렬 실행을 유지한다. 각 corpus 항목은 해당 command에 실제 검사 파일이 등록돼 있는지 확인한다. 초기화 취소는 canonical Run 상태를 정리하되 append-only Journal의 과거 사실은 보존한다. Journal로 삭제된 Run을 복원하지 않는다.


최종 독립 리뷰의 복구 경로 보완: 병렬 Host의 기본 dispatcher는 준비 단계에서 승인한 v2 Host 계약을 어댑터로 전달한다. Gemini semantic 검사는 custom dispatchStep 없이 이 경로를 실행한다. 실제 Gemini 인증 성공을 주장하지 않는다.

검증 완료 후 Git closeout 때문에 HEAD가 바뀐 보고는 같은 canonical Attempt의 checkpoint로 복구한다. Git 영수증에는 reportKey와 검증한 workspace identity를 기록한다. 같은 영수증의 정확한 HEAD와 깨끗한 workspace만 허용한다. 완료된 Git 영수증을 재사용해 중복 커밋을 막는다. 임시 Git fixture에서 commit_created 직후와 완료 보고 저장 직전의 process exit를 검사한다. 외부 파일, 인덱스 및 HEAD 변경은 거부하며, 복구 중 proof 재실행과 추가 커밋이 없음을 확인한다.
