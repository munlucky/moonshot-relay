# W3-A 결과 — 승인 전 파일 반영·복구 안전 경계

- 기준 커밋: `861b36ab422b8902df7f6588b5d5eaa19a5aaad3` (`main`, W2 완료 상태)
- 판정: **PASS / keep-baseline (격리 대표 반례 범위)**. 생산 코드 결함 재현되지 않음. W3-B 승인 후 Git 전달과 독립된 판정이다.
- 대상: W0에서 보존한 실제 Git 적용·owner fence·영속 CAS/SQLite 장애를 현행 HEAD에서 다시 실행한다. 운영 저장소·계정 SQLite·기존 영속 Run은 쓰지 않는다.

## 현재 HEAD의 재실행 결과

| 구분 | 격리 시험과 관측 | 판정 |
|---|---|---|
| C06 패치 전 lease 만료 | `c06`: 실제 패치 바이트 0, Git clean, mutation revision 0, 활성 상태 유지 | PASS |
| C07 외부 파일 혼입 | `c07_external`: 패치 적용 뒤 외부 파일 추가 → `blocked` 및 revision 0; 외부·잔여 파일 보존 | PASS |
| C07 부분 적용 결과 | `c07_partial`: 적용된 두 파일 중 하나 제거 → `blocked`, revision 0; 남은 파일 보존 | PASS |
| C08 owner CAS 및 차단 기록 실패 | `c08`: 두 영속 기록 예외 주입 → 실패 직후 active/revision 0, 재시작 후 `delivery_materialization_recovery_required`로 blocked | PASS |
| C08 실제 SQLite EXCLUSIVE 잠금 | `c08_busy`: 두 기록 경계 모두 실제 `ERR_SQLITE_ERROR`; 잠금 해제 후 재시작 blocked/revision 0 | PASS |
| C07 실제 자식 종료 | `real-git-apply-crash-probe.mjs`: 3,000개 중 43개 쓰인 동안 실제 자식 `SIGKILL`, 재시작 복구 blocked/revision 0, 43개 바이트 보존 | PASS |
| C06 실행 중 deadline | `git-apply-deadline-probe.mjs`: 12,000개 파일 패치에 실제 249ms budget 적용. 4,384개 쓰인 뒤 `ETIMEDOUT`/`SIGTERM`, 종료 이후 파일 목록 불변 | PASS |
| 병렬 복구 회귀 | `kernel-parallel-fencing` + `kernel-parallel-recovery` 집중 회귀 **14/14** | PASS |

재실행 로그는 `/tmp/moonshot-w3a-*/`의 로컬 임시 증거다. 재현 코드는 `fixtures/`에 보존한다.

## 시간 의존 fixture의 1차 실패 및 조정

기존 3,000개 파일 패치는 이번 Linux 환경에서 250ms 안에 **정상 종료**하여 timeout이 발생하지 않았다(3,000/3,000, exit 0). 이것은 Git이나 Kernel 안전 실패가 아니라 **검증 대상 이벤트가 발생하지 않은 경우**다. 실행 시간을 인위적으로 늘리는 제품 코드 분기는 추가하지 않았다. 격리 fixture의 파일 수만 12,000개로 늘려 실제 중간 종료·지연 writer 검사를 다시 통과시켰다. 이 테스트는 CPU/디스크 속도에 종속적이므로 다른 호스트에서 정상 완료하면 timeout 안전성 통과로 잘못 보고하지 않는다.

## 경계와 미검증 사항

- 실제 Git 바이트, DB 차단·재시작, 임의 원복 부재, revision 불변 조건에서 안전 위반은 재현되지 않았다.
- C06의 **외부 owner가 lease를 동시에 교체하는 실제 Kernel dispatcher 전체 경합**, C08의 디스크 가득 참/영구 I/O 오류, 실제 Provider 연결과 이중 dispatch는 이 범위에서 완전 검증하지 않았다. 해당 미검증을 PASS로 승격하지 않는다.
- 대표 반례에서 현행 P0 제품 결함이 확인되지 않았으므로 새로운 DB 상태 필드·Lock·호스트별 timeout fallback·승인 절차는 구현하지 않았다. 실제 안전성 위반 증거가 나타나면 그 반례에 한해 W3-A를 다시 연다.
- W3-B는 **승인 후** Git closeout, finalization 영속 Receipt, Identity 사용 지점에서만 수정한다. W3-A의 대표 PASS가 W3-B의 대체 증거는 아니다.

결론: **W3-A 격리 대표 안전 반례 PASS / 생산 코드 keep-baseline. 통합 W0~W10 완료는 아님.**
