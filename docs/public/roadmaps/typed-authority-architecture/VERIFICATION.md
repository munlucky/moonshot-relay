# 검증 계획과 완료 증거

이 문서는 실행할 검증을 정의한다. 아래 V 항목은 아직 구현 결과가 아니다. 기존 채팅의 테스트 수치는 과거 기준선이다.

## 판정 신호

| Signal | 검증 대상 | 통과 기준 |
| --- | --- | --- |
| V01 | 기능·원본·writer·외부 입력·payload inventory | 미분류 활성 항목 0, 모든 현재 source와 실행 참조에 owner·task 존재 |
| V02 | 계약 생성·TS·빌드 | 타입 오류·schema 오류·경계 위반 시 실패, stale artifact 사용 거부, source 없는 실제 pilot 실행 |
| V03 | Work | next/report/resume/replan·lease·CAS·binding·idempotency의 기존 결과 유지 |
| V04 | Trust | evidence·review·completion·closeout 일관성, stale/위조/타 run 근거 거부 |
| V05 | Knowledge | SQLite 단일 권위, 승인된 commit·supersession·revision·namespace·복구 보존 |
| V06 | Host | provider/session/process/workspace/Git/prompt/cache 회귀, 경계 검증과 native 결과 구분 |
| V07 | 조정·persistence | 직접 I/O/SQL/provider 분기 제거, same-transaction 원자성·crash recovery 보존 |
| V08 | CLI·설치 | 공개 명령 호환, archive/direct install, no-source runtime, payload hash parity |
| V09 | TS 전환·개발 경험 | 활성 원본/test/tool TS 검사, 내부 shim·허용 예외 정리, 네 가지 변경 시험 |
| V10 | 최종 artifact | clean checkout·supported matrix·전체 필수 회귀·임시 계정 native smoke와 인계 자료 |

## 현재 사용 가능한 명령

현재 package.json에 있는 명령이다. 구현 중 경로가 바뀌면 명령의 검증 의도를 유지한다.

```sh
npm ci
npm run typecheck
npm run check:boundaries
npm run build
npm run build:check
npm run lint:kernel
npm run test:source-runtime
npm test
npm run test:package
npm run test:kernel
npm run test:kernel-reliability
npm run test:eval
```

최종 단계에서는 중복되는 suite를 확인해 같은 코드를 이유 없이 반복 실행하지 않는다. 공식 실행 계약이 서로 다른 proof를 요구하면 그 요구를 따른다. 새 contract-generation/architecture check와 slice test의 command ID는 TASK-002에서 등록한다. 현재 존재하지 않는 명령을 실행 완료로 기록하지 않는다.

## 의미 있는 음성 검증

- 잘못된 Run union 조합은 compiler가 거부한다. 부정 타입 fixture의 `@ts-expect-error`는 예상 오류 검사용으로만 허용한다.
- SQLite/provider/MCP의 malformed 입력은 write/spawn 전에 실패한다. 구조는 맞지만 다른 run/revision의 입력도 Authority가 거부한다.
- Kernel에서 provider의 type-only import, Host에서 Kernel internal import, shared에서 catalog import를 각각 삽입하면 architecture check가 실패한다.
- schema 변경 후 생성 타입을 갱신하지 않으면 drift 검사가 실패한다. 생성 타입만 손으로 바꿔도 실패한다.
- source 삭제·output 변조·missing artifact·orphan output·symlink·path traversal은 build/install의 기존 보호를 유지한다.
- 동일 report 반복, 중간 crash, lease 만료, 두 writer 경합에서 side effect와 canonical completion이 중복 기록되지 않는다.
- transaction의 중간 SQL 오류를 주입했을 때 cursor만 전진하거나 completion만 저장되지 않는다.
- projection 손상·삭제를 주입해도 SQLite authority를 변경하지 않는다.
- 잘못된 provenance revision은 closeout을 거부한다. 정상 최신 provenance는 completion과 closeout이 모두 수락한다.

## 동작 보존 표본

TASK-001에서 기존 테스트와 아래 시나리오의 coverage를 매핑한다. 기존 의미 있는 테스트를 재사용한다. 구현 내용을 문자열로 복제한 테스트를 추가하지 않는다.

| 기능 | 정상 | 실패·복구 |
| --- | --- | --- |
| next/report | 동일 공개 JSON·action·exit 의미 | unknown run, project identity 미확정, stale report |
| resume/replan | cursor·완료 step history 보존 | restart, holder 교체, successor lineage |
| mutation | 승인 scope 안의 변경 | outside path, worktree mismatch, stale CAS |
| proof/review | bound command와 독립 reviewer | timeout/cancel, stale hash, invalid enforcement |
| completion | required AC/evidence 충족 | 부족한 review, 변경 후 stale proof |
| Knowledge | 승인·revision commit, supersede | 동시 commit, 다른 project, projection 손상 |
| Host | model/session/worktree/prompt 처리 | provider 미설치·응답 오류·process cleanup |
| Git closeout | 정확한 범위·근거·message | pre-staged unrelated changes, provenance mismatch |
| 설치 | initial/install/update/doctor | interrupted update, missing payload, rollback |

## 깨끗한 설치 검증

1. 고정 커밋을 새 임시 checkout으로 가져온다. 기존 `dist`, generated runtime, developer dependencies를 복사하지 않는다.
2. 고정 lock으로 bootstrap한다. 타입·생성 계약·import 경계 검사를 통과한다.
3. runtime artifact를 빌드하고 출처·hash·file manifest를 보존한다.
4. source/contract/unit/integration 회귀와 기존 release gate를 실행한다.
5. npm archive를 실제 생성한다. 전용 임시 home에 설치하고 source/compiler 부재를 확인한다.
6. 직접 installer도 다른 임시 home에 실행한다. artifact managed 파일의 목록·hash를 비교한다.
7. 실제 계정 환경변수, credentials, state를 참조하지 않는지 검사한다. 필요한 runtime dependencies만 설치한다.
8. 공개 CLI, standalone, profile 명령, SQLite, 자산 로딩을 실행한다. synthetic project에서 next/report/resume의 정상·거부 경로를 확인한다.
9. supported Node/OS에서 native module과 shell/process 동작을 확인한다. 설치된 provider에는 version/native smoke를 수행하고, 인증·사용 권한이 있는 surface에는 작은 실제 실행을 수행한다.
10. 이전 runtime에서 준비한 비밀 없는 상태 fixture를 새 runtime으로 resume한다. 업데이트 실패와 이전 artifact rollback을 검사한다.

현재 CI는 Node 20/22 × Ubuntu/Windows/macOS이며 package engine은 `>=20`이다. 이 불일치는 지원 계약 확정 항목이다. TASK-001에서 실제 설치 runtime의 Node 버전도 확인해 CI coverage를 추가하거나 지원 문구를 정확히 좁힌다. TypeScript 전환을 이유로 지원 버전을 조용히 올리지 않는다.

## 증거 저장과 제한

각 결과에는 commit/source digest, toolchain, OS/Node, task/REQ, command, exit code, artifact digest, runtime path와 SKIP 사유를 연결한다. 로그·DB·receipt·verdict는 account runtime 또는 임시 evidence 디렉터리에 저장한다. source package에는 정책과 요약만 둔다.

필수 항목은 PASS가 필요하다. 환경 미설치·인증 불가의 SKIP은 별도 표시한다. 해당 surface의 완전 지원을 완료 조건에 포함했다면 그 항목이 해결되기 전에는 전체 완료로 표시하지 않는다. local synthetic integration, native binary 존재 확인, 실제 provider 실행은 서로 다른 증거다.

실계정 적용이 요청되면 전환한 artifact와 installed payload hash, 실행 generation, profile 결과를 비교한다. source commit 성공이나 임시 설치 성공만으로 실계정 반영을 주장하지 않는다.

## 계획 문서 검증

```sh
node scripts/architecture-artifact-validate.mjs --mode brownfield_codebase --path docs/public/roadmaps/typed-authority-architecture --repo-root . --json
```

추가로 로컬 링크, 197개 baseline inventory, 요구사항→task→V 연결, advisory seed digest를 검사한다. 이 검사 통과는 계획 형식과 참조의 일관성이다. 구현이나 Kernel completion의 증거가 아니다.
