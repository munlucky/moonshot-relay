# Workspace mutation fencing의 선택적 TLC 검사

판정은 **제한적 ADOPT**다. 한 경계의 유한 모델과 실행 명령을 유지한다. 기본 작업과 전체 테스트에는 자동으로 추가하지 않는다. 외부 스킬, 새 Receipt, DB, 완료 Authority는 추가하지 않는다.

## 실행

Java를 PATH에 준비한다. [TLA+ v1.7.4 공식 배포](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4)의 `tla2tools.jar`를 `.moonshot-relay/formal/tla2tools.jar`에 둔다. 저장소에는 JAR를 넣지 않는다. 실행기는 `tools/formal/fencing-cases.json`의 SHA-256과 실제 바이트를 비교한다. 이 해시는 PoC에서 측정한 값이다. 공식 서명 검증을 뜻하지 않는다. 다른 경로는 `TLA2TOOLS_JAR`로 지정할 수 있다. Java 실행 경로는 `JAVA`로 지정할 수 있다.

```sh
npm run verify:formal:fencing
npm run test:formal:fencing
npm run test:formal:fencing:experiment
node tools/formal/fencing.mjs --property Safety4A
```

- `verify:formal:fencing`: 두 기본 설정에서 보호 조건을 검사한다. 모든 설정이 탐색을 완료해야 성공한다.
- `test:formal:fencing`: 입력 식별, 소스 대응 변경 거부, 결과 분류, 도구 누락을 검사한다. Java는 필요 없다.
- `test:formal:fencing:experiment`: 실행기 테스트와 속성별 검사, 변이, 도달성 등 23개 사례를 실행한다. **알려진 반례를 확인하는 실험**이다.
- `--property`: 지정한 성질의 PASS를 요구한다. `Safety4A`와 `Recovery1Mark`는 현재 반례가 있으므로 종료 코드 1을 반환한다.

`PASS`는 해당 설정의 탐색 완료를 뜻한다. `VIOLATION`은 지정한 불변식의 반례다. 시간초과, 도구 누락, 구문 오류와 알 수 없는 출력은 `INCOMPLETE`다. 실험의 `EXPECTATIONS_MET`는 예상한 결과가 관측됐다는 뜻이다. 모든 성질의 PASS를 뜻하지 않는다. 도달성 사례는 부정 불변식의 위반으로 도달을 확인하며, 안전성 실패와 구분한다.

각 TLC 실행의 제한은 5분, JVM heap 4 GiB, worker 1개다. 출력은 `.moonshot-relay/formal/runs/`의 새 디렉터리에 쓴다. `FORMAL_FENCING_OUT`으로 출력 부모를 지정할 수 있다. 로그, 설정, 입력 fingerprint와 상태 수를 `report.json`에 남긴다.

## 검사 범위와 알려진 한계

모델은 `tools/formal/Fencing.tla`다. 아래 결과는 검토한 Snapshot에만 대응한다.

| 성질 | 유한 모델 결과 | 의미 |
|---|---|---|
| Safety1 | PASS | 유효한 경쟁 owner의 lock을 빼앗지 않는다. 같은 Run/session의 재발급은 별도 설정에서 검사한다. |
| Safety2 | PASS | 동일 Run의 동일 기준 revision/identity 제출을 두 번 반영하지 않는다. |
| Safety3 | PASS | 정상 반환에는 유효 자격으로 관측한 최종 검사가 있다. 검사 후 반환까지 연속 유효함을 보장하지 않는다. |
| Safety4A | VIOLATION | timeout 계산 뒤 호출자가 멈추면, 만료 뒤 시작한 git이 파일을 바꿀 수 있다. |
| Safety4BApproval | PASS | 오래된 자격의 파일 효과를 정상 mutation Receipt로 승인하지 않는다. |
| Safety4BSettlement | PASS | 실패한 materialization 또는 guard가 관측한 identity/provenance 불일치로 settlement하지 않는다. |
| Recovery1Mark | VIOLATION | 복구 상태 저장 자체가 실패하면 영속 표식을 보장할 수 없다. |
| Recovery1Block | PASS | 처리한 오류 경로가 정상 settlement로 이어지지 않는다. |

대표 실행자 두 명 중 A만 materialization한다. B는 경쟁 획득 또는 같은 Run/session 재발급을 수행한다. A 획득 1회, B 획득 1회, A 갱신 1회, 파일 적용 1회, 동일 기준 요청 2회, 외부 drift 1회, 재시작 1회로 제한한다. 시간은 초 단위 경계 집합 `{0,1,59,60,61,119,120,121,122,179,180,181,239,240,241,242}`다. TTL은 120초, 상대 subprocess 제한은 최대 60초, 여유는 1초다. 모든 정수 시각과 모든 다중 worker 실행의 증명이 아니다.

Acquire/renew와 revision+provenance transaction은 각각 원자적이다. pre 검사, timeout 계산, process 시작, 파일 효과, post 검사, revision commit, 최종 검사와 반환은 분리한다. timeout 요청을 실제 종료와 같게 취급하지 않는다. release는 만료만으로 실패하지 않으며, 다른 session/token으로 바뀌면 실패할 수 있다.

project/worktree/HEAD, patch digest와 paths, Step/attempt의 구조적 적합성은 유효한 routed Delivery로 고정한다. settlement는 코드가 읽은 live identity와 provenance의 대응을 추상화한다. marker가 있는 crash의 재시작 검사를 포함한다. marker 없는 일반 변경, 복구 저장의 부분 성공, rollback, 실제 process kill 동작, 무한 재시도와 liveness는 검증하지 않는다. timeout 요청 뒤 효과의 가능성은 Windows에서 실증하지 않았다.

Safety4A는 고정 Snapshot의 실제 Control Plane API와 git apply로 재현했다. timeout 계산과 spawn 사이에 제어된 정지를 넣었다. fixture TTL은 지원되는 `ttlMs=3000`이며 여유는 그대로 1000 ms다. 운영 dispatcher 내부의 OS 선점을 직접 재현한 실험은 아니다. 파일은 변했지만 사후 검사가 Receipt를 거부했고 revision은 0을 유지했다. 복구 저장이 성공하면 Run은 blocked가 된다. Recovery1Mark는 오류를 보존하고 다시 던지는 코드 경로와 대응하며, 실제 디스크 고장은 주입하지 않았다.

## 코드 대응과 변경

| 모델 경계 | 검토한 소스 |
|---|---|
| lock 획득·갱신·해제와 epoch | `src/kernel/state-store.ts`: acquireWorkspaceMutationLockV2, renewWorkspaceMutationLockV2, releaseWorkspaceMutationLockV2 |
| pre/post/post-commit fence·CAS | `src/kernel/run/mutation-guard.ts`: assertWorkspaceMutationFence, assertOwnerWorkspaceMutationCAS |
| owner mutation과 복구·settlement | `src/kernel/control-plane.ts`: acquireOwnerWorkspaceMutationFence, recordOwnerWorkspaceMutation, blockDeliveryMaterialization, recoverPendingDeliveryMaterialization, settleParallelResult |
| revision/identity 조건부 UPDATE | `src/kernel/persistence/work-lifecycle-store.ts`: compareAndSetRunWorkspaceIdentity |
| renew → pre → timeout → apply → post와 catch/finally | `src/host/kernel/parallel-dispatcher.ts` |
| live identity와 외부 git | `src/host/kernel/workspace/workspace-identity.ts`, `src/shared/git-safe.ts` |

`fencing-source.json`은 검토한 소스 7개의 해시와 Snapshot digest를 고정한다. 소스가 다르면 명령은 `SOURCE_CORRESPONDENCE_STALE`로 중단한다. 모델 대응과 기존 fencing/recovery/dispatch 테스트를 다시 검토한 뒤 해시를 갱신한다. 해시 일치가 모델 대응의 기계적 증명은 아니다. 다른 요구사항을 추가하면 모델과 검사 범위를 먼저 바꾼다.

배포 파일의 소스 해시는 `sourceCommit`에 기록한 커밋의 바이트를 기준으로 한다. 최초 PoC는 기존 미커밋 변경을 포함한 Snapshot에서 수행했다. 커밋 준비 시 그 변경을 비교했다. 차이는 report provenance 보완과 과거 Run 진단에 있었으며, 모델이 검사하는 lock·CAS·materialization·재시작·settlement 경계는 같았다. 기존 변경을 커밋에 포함하지 않고 committed source에서 전체 실험을 다시 실행했다. 이전 Snapshot digest는 실험 출처로 유지한다.

변이 `cas`는 상위 guard와 DB의 중복 revision/identity 검사를 함께 제거한다. SQL revision 비교 하나만 제거한 실험이 아니다. `token`은 같은 Run/session 재발급으로 다른 소유자 검사가 결함을 가리지 않게 한다. `overlap`, `cas`, `token`, `settlement`는 위반을 검출한다. pre 또는 post 하나만 제거하면 남은 최종 guard가 승인을 막는다. 이 둘을 결함 검출 성공으로 집계하지 않는다.

## Kernel 증거와 유효 기간

선택적 탐색은 결과와 한계를 보고한다. 계약에 필수 성질을 넣으면 그 성질의 PASS 명령을 연결한다. 반례·미실행·INCOMPLETE는 그 의무를 충족하지 못한다. 알려진 성질 위반을 실험의 예상 결과라는 이유로 필수 안전성 PASS로 바꾸지 않는다.

명령은 이전 결과를 읽지 않고 매번 TLC를 실행한다. fingerprint에는 미커밋 소스 7개, 모델, 속성·설정 manifest, 소스 대응 manifest, 실행기, package manifest/lock, JAR 실제 바이트, 검사 선택·제한, Java 실행 파일의 바이트와 버전, Node 버전, OS/arch와 JVM 옵션을 넣는다. 실행 전후 관측이 다르면 실패한다. OS/JDK 전체 설치 이미지나 모든 외부 의존성을 식별하는 값은 아니다.

기존 Kernel Proof executor는 종료 코드, 출력 digest와 로그를 Receipt에 기록한다. 실행기의 JSON은 그 출력에 연결한 보조 자료다. **기존 Kernel evidence identity를 TLC 전용 필드로 확장하지 않았다.** Kernel 보고에서는 `forceFresh: true`를 사용해 기존 Proof의 자동 재사용을 끈다. `TLA2TOOLS_JAR` 등 임의 환경변수는 Proof executor가 전달하지 않으므로, Kernel 실행은 기본 도구 경로와 PATH의 Java를 사용한다.

```json
{"obligationId":"<next가 반환한 ID>","commandRef":"test:formal:fencing:experiment","forceFresh":true,"acceptanceCoverage":["<해당 AC>"]}
```

이 예시는 PoC 검증 의무용이다. 강한 Safety4A 요구에는 `--property Safety4A`를 실행하는 프로젝트 명령을 선언하고 연결해야 한다. 완료는 현재 Kernel continuation의 `action.type = "done"`으로만 판정한다.
