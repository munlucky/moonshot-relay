# W7 — Ephemeral Work · Persistent Knowledge 통합 수용 결과

- 기준 날짜: 2026-11-01
- 소스 및 비교 대상: W6 직전 `c29a5fc5`, W6 통합 `6931c5a68fdfff2d36ad314cec95784d3375f65e`
- **통합 판정: PARTIAL.** 네 Host의 격리 Kernel 회귀 및 SQLite 무결성은 PASS. 실제 사용자 Codex in-flight 세션의 강제 종료·재시작/원격 인계, 모든 공유 SQLite 경로에 대한 차단, 자동 Cleanup의 운영 전환, 전체 CLI 지연 개선은 수용되지 않았다.
- 이 단계에서 Kernel 제품 코드나 프롬프트 규칙을 변경하지 않았다. 계정 Runtime, 실제 Codex 앱 서버, 사용자 DB를 종료·삭제·이관하지 않았다.

## 1. Host별 최신 소스 수용 증거

각 Host에서 최신 W6 소스 기준으로 격리 Runtime을 사용했다. Mac 기존 체크아웃은 `c53bcd63`으로 유지하고 독립 임시 clone으로 테스트했다. Mac OS 사용자 작업과 설치본을 변경하지 않았다.

| 실행 환경 | SQLite W6-A/B | Kernel CLI/MCP next·report·Owner/Session E2E |
| --- | ---: | ---: |
| Windows 측 Linux MCP | 4/4 PASS | 51/51 PASS |
| Windows Native | 4/4 PASS | 51/51 PASS |
| Mac 측 Linux MCP | 4/4 PASS | 51/51 PASS |
| Mac Native | 4/4 PASS | 51/51 PASS |

51개 회귀는 독립 Reviewer, MCP `next/report`, 후속 실행, Owner 충돌, 세션 바인딩 실패·복구, 기존 Owner Run, CLI 프로세스 간 보고를 포함한다. **이 결과는 실행 중인 사용자의 Codex 앱 서버를 종료했다가 재연결하는 실제 사용자 세션 E2E와 다르다.**

## 2. Cross-OS SQLite 단일 파일 소유권

기본 Runtime은 각 Host-local 경로로 분리되어 있고 사용자 지정 공유 파일 경로 전체를 제약하는 별도 권위는 추가하지 않았다.

Windows Native의 독립 임시 DB에서 `BEGIN IMMEDIATE`를 유지한 상태로 Linux MCP가 /c 공유 마운트의 동일 파일에 쓰기를 시도했을 때:
- Node 오류 `code=ERR_SQLITE_ERROR`, `errcode=4618`, 메시지 `disk I/O error` (`SQLITE_IOERR_SHMLOCK`).
- Windows 트랜잭션 종료 후 `PRAGMA integrity_check=ok`, 기존 커밋 행 정상. Linux 재조회도 정상.
- 이 결과는 해당 공유 WAL 경로가 안전한 cross-host Writer 경로가 **아님을 증명**한다. 데이터 손상이 관측됐다고 주장하지 않는다.

**보존 결정:** 기존 Host-local Runtime을 유지한다. Kafka, 범용 Host Coordinator, Shadow DB, OS별 폴백이나 오류를 Busy로 위장하는 추가 규칙은 만들지 않는다.

## 3. 재시작·증거/지식 경계

- 격리 DB에서 자식 프로세스 `BEGIN IMMEDIATE` 도중 비정상 종료 → 미커밋 행 없음, 기존 Run 유지, 무결성 PASS.
- `SQLITE_BUSY`는 bounded retry 후 명시적으로 반환하고 잠금 해제 후 다시 쓰기 PASS.
- CLI의 별도 Node 프로세스 `next` → 프로세스 종료 → 새 Node 프로세스 `report`를 동일 Run/Owner/격리 Runtime으로 호출해 정상 완료를 확인했다.
- 다른 세션이 같은 Run의 Report를 제출하면 기존 Session/Owner 계약으로 거부하는 통합 회귀는 네 Host에서 통과했다.
- 실제 사용자 Codex 앱 서버·개발 작업을 의도적으로 종료하지 않았으므로 real in-flight resume은 **DEFER**.

## 4. 동일 Host 기준 W6 전/후 CLI 성능

측정 프로토콜: 같은 Linux MCP Host, 동일 Node 환경, `/tmp` 파일 시스템에 Git archive로 만든 각 소스의 별도 빌드. 매 샘플마다 새로운 임시 Git 프로젝트와 독립 Kernel Runtime. 각각 CLI `next --contract-json`으로 Run을 만든 뒤 별도 CLI `report --report-json` 프로세스를 실행한다. 완료·검증을 보고, 두 CLI 호출 벽시계 지연과 **동일한 읽기 연결의** `PRAGMA schema_version`·`data_version` 변화를 측정한다. p95는 적은 표본에서 사실상 최댓값에 가깝다.

| 항목 | W6 직전 `c29a5fc5` | 최신 `6931c5a6` | 판정 |
| --- | ---: | ---: | --- |
| next p50, n=4 | 3.52초 | 4.01초 | 개선 입증 실패 |
| next p95, n=4 | 3.93초 | 7.40초 | 재검증 필요 |
| report p50, n=4 | 3.95초 | 6.51초 | 개선 입증 실패 |
| report p95, n=4 | 4.14초 | 7.71초 | 재검증 필요 |
| report 도중 스키마 버전 증가 | 2 | **0** | 스키마 쓰기 제거 PASS |
| report 도중 외부 관측 연결의 data_version 증가 | 1 | 1 | 정상 보고에는 실제 데이터 쓰기가 남음 |

**순서 편향 확인을 위한 추가 교차 측정 (같은 Host·같은 /tmp, 3회씩):** 직전 → 최신 → 최신 → 직전 → 직전 → 최신 순서로 실행했다.

| 항목 | W6 직전 n=3 | 최신 W6 n=3 |
| --- | ---: | ---: |
| next p50 / p95 | 3.72 / 4.45초 | 3.48 / 3.64초 |
| report p50 / p95 | 4.13 / 4.14초 | 4.08 / 4.18초 |
| report 스키마 변경 | 각 샘플 2회 | 각 샘플 0회 |
| report data_version 증가 | 각 샘플 1회 | 각 샘플 1회 |

교차 측정에서는 큰 지연 증가가 재현되지 않았다. 최초 순차 측정과 달리 새 버전의 중앙값이 비슷하거나 약간 낮지만 표본이 너무 작다. **호스트 부하/측정 순서의 영향 가능성이 남으며 성능상 인과적 개선·퇴보 모두 미확정**이다. p95는 표본 수가 적어 신뢰할 만한 tail-latency 추정이 아니다.

위 값에는 Node 프로세스 시작, Host 증거/Review/CLI JSON 처리, Git/파일시스템 시간과 시스템 부하가 포함된다. 따라서 느려진 수치의 원인을 W6 변경으로 확정하거나, 스키마 쓰기 감소가 전체 CLI 지연 개선으로 이어졌다고 주장하지 않는다. 본 W7 표본은 작은 파일럿이며 baseline 인과 비교 재현성은 추가 확인해야 한다.

## 4.1 Raw fixture evidence (milliseconds, next/report)

- W6 직전 4개 샘플: (3562.0/3953.3), (3511.9/3922.6), (3931.7/4142.0), (3520.8/3998.8).
- 최신 W6 4개 샘플: (3732.5/4582.7), (4012.5/6514.3), (7398.6/7706.5), (6352.3/6937.7).
- 교차 실행 6개: 직전 (4446.2/3979.3), 최신 (3475.7/3932.8), 최신 (3451.3/4180.9), 직전 (3672.6/4132.9), 직전 (3720.1/4140.4), 최신 (3639.3/4079.2).
- 각 샘플의 report 프로세스는 별도 PID로 실행됐으며 별도의 새 Runtime DB 사용. 결과는 JSON status completed였고, 코드 변경이나 계정 DB 영향은 없었다.

## 5. 미완료 수용 조건

- **W7 Host 사용자 세션:** Mac 및 Windows Native의 실제 사용자 Codex in-flight 작업을 강제 종료하거나 계정 설치본을 변경하지 않았다. 활성 세션 보호를 우선해 사용자 계정 재시작 증거는 없음.
- **Mac 계정 설치 동기화(후속 완료):** Mac 원본 main을 580272b4로 Fast-forward하고 공식 install --sync로 Kernel 계정 설치를 갱신했다. 이전·이후 Manifest 1,143/1,143 SHA PASS, 백업 backup-1793537222034, CLI v0.1.0, Profile Doctor ready/관리 22개를 확인했다. 활성 Codex app-server는 재시작하지 않아 실제 사용자 in-flight 세션 수용은 PARTIAL.
- **공유 DB:** 물리 공유 WAL의 호환성 실패는 확인했다. 임의 사용자 지정 UNC/네트워크 저장소를 Kernel이 자동 거부하는 포괄적 보장은 없다.
- **W4/W5:** 단일-Step 수동 Retire의 Run ID 재사용·정리 재시도 경계는 새 소스 회귀로 보호한다. 그러나 과거 마커 없는 Run, 외부 Historical Consumer, 운영 DB 백업·복구 승인 조건은 미완료이므로 자동 Cleanup을 켜지 않는다.
- **성능:** CLI 벽시계 지연 개선 미입증. 순차 측정은 지연 증가를, 교차 측정은 유사한 지연을 관측했다. 차후 충분한 표본과 일정한 Host 부하에서 병목을 분리해야 한다. 새 지침/폴백을 추가하지 않는다.

**다음 운영 단계:** Mac 계정 소스/Kernel 설치 동기화는 완료됐으므로 실제 사용 중인 Codex 세션 재시작·Owner 인계 수용과 자동 Cleanup의 Historical Consumer 검증을 별도로 수행한다. 동일 물리 DB의 Host 간 직접 공유는 하지 않는다. SQLite의 일반 Open 스키마 쓰기 0은 유지한다.
