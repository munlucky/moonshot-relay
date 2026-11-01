# W6-B — Host SQLite Writer 경계 및 장애 복구 검증

검증일: 2026-11-01
기준 커밋: `513e0e2e`
전체 판정: **PARTIAL**. 이번 격리 테스트와 오류 분류 수정은 PASS이나, Mac 최신 코드 수용·다중 OS 공유 파일 Writer의 독점성·실제 사용자 Codex 세션 복구는 아직 검증하지 않았다.

## 기존 구현과 관측

- Windows Native 기본 Kernel Runtime: `C:\Users\moon\.moon-relay-kernel`.
- Windows 측 Linux MCP Runtime: `/root/.moon-relay-kernel`.
- Mac Native 기본 Runtime: `/Users/seokgimoon/.moon-relay-kernel`.
- Mac 측 Linux MCP Runtime: `/root/.moon-relay-kernel`.

각 Host의 기본 경로는 해당 Host의 로컬 계정/컨테이너 안에 별도로 존재한다. 문자열이 같아도 두 Linux MCP는 서로 다른 환경이므로 동일 DB 파일임을 뜻하지 않는다. **사용자가 override한 UNC/공유 마운트, 심볼릭 링크, 다른 Host의 동일 DB 파일 접근까지 배제하는 증거는 아니다.** 공유 DB에 대한 동시 Writer 금지 조건을 최종 PASS로 선언하지 않는다.

Mac Native 체크아웃은 `c53bcd63`으로 Windows 측 최신 W6-A 소스 `513e0e2e`보다 뒤처져 있다. Mac Native의 기본 로그인 셸은 없는 임시 `env` 파일을 읽으려는 경고를 내보냈으며, 로그인하지 않는 셸에서는 기본 Node 명령 실행이 확인됐다. 이는 W6 변경 코드의 결함이라고 판단할 근거가 없다. Mac의 계정 설치본과 활성 Codex 세션은 변경하지 않았다.

## 확인한 구조 문제와 수정

기존 SQLite Adapter는 `node:sqlite`와 `better-sqlite3`를 함께 지원한다. 같은 DB에 열린 두 쓰기 연결이 충돌하면, `node:sqlite`는 `errcode=5` 및 일반 `code=ERR_SQLITE_ERROR`, 메시지 `database is locked`를 반환했다. 기존 bounded busy 재시도는 메시지로 이를 감지했지만, 최종 오류의 `code`는 `ERR_SQLITE_ERROR`여서 Host가 안정적으로 `SQLITE_BUSY`를 구분할 수 없었다.

`src/kernel/sqlite-adapter.ts`의 기존 `normalizeError()`에 SQLite의 숫자 결과 코드 사용을 추가했다.
- `errcode=5` 또는 기존 `SQLITE_BUSY`: `SQLITE_BUSY`.
- `errcode=6` 또는 기존 `SQLITE_LOCKED`: `SQLITE_LOCKED`.
- 그 외 오류의 기존 처리와 bounded retry는 유지한다.

새 파일 잠금층, 중앙 Host Coordinator, WAL 복사, OS별 경로 하드코딩, 이중 DB, 무제한 재시도는 도입하지 않았다.

## 격리 복구 회귀

`tests/kernel-sqlite-runtime-recovery.test.ts`:
1. 별도 `mkdtemp` Runtime에서 정상 Run을 영구 기록한다.
2. 별도 Node 자식 프로세스가 `BEGIN IMMEDIATE` 후 `meta`에 행을 쓰고 커밋 없이 프로세스를 종료한다.
3. 이후 새 Kernel StateStore 연결은 기존 Run을 정상 조회하고, 미커밋 행은 없어야 하며 `PRAGMA integrity_check=ok`여야 한다.
4. 동일한 격리 DB에서 두 SQLite 연결을 열고 첫 번째가 잠금을 보유한 상태로 두 번째 쓰기를 시도한다. 재시도 한도 이후 `SQLITE_BUSY`로 실패해야 하고 중간 행은 남지 않아야 한다.
5. 잠금을 해제하면 두 번째 연결에서 쓰기가 성공하며, 재Open도 성공해야 한다.

Linux(WSL2)와 Windows Native에서 W6-A 빠른 Open 회귀와 함께 검증했다. 이 테스트는 운영 DB 및 실제 사용자 세션을 변경하지 않는다.

## 수용 판정 및 잔여

- W6-B 격리 Run/SQLite 자식 프로세스 비정상 종료 복구: **PASS**.
- W6-B bounded BUSY 오류 분류 및 잠금 해제 후 쓰기: **PASS**.
- 최신 W6-A schema fast-open 회귀 유지: **PASS**.
- Linux 집중 W6-A/W6-B 회귀 **4/4 PASS**; Windows Native 동일 **4/4 PASS**. Runtime/Test 빌드, 생성물 정합성 및 Boundary 검사도 검증했다.
- Mac Native 최신 W6 코드 검증: **4/4 PASS (별도 임시 clone a5577baa)**. 사용자 계정 체크아웃·설치본·활성 세션은 변경하지 않았다.
- Mac 측 Linux MCP 최신 W6 코드 검증: **4/4 PASS (별도 임시 clone a5577baa)**.
- Windows Native ↔ Linux MCP의 동일 물리 임시 SQLite/WAL 파일 동시 접근: **호환성 실패 재현**. Windows의 BEGIN IMMEDIATE 동안 Linux의 /c 경로 INSERT에서 code=ERR_SQLITE_ERROR, errcode=4618 (SQLITE_IOERR_SHMLOCK), disk I/O error가 발생했다. Windows 커밋 후 integrity_check=ok, Linux 읽기도 성공했다. 따라서 공유 WAL 경로는 교차 Host Writer로 승인하지 않는다.
- Kernel next/report 및 Host Session/Owner E2E 회귀: 네 Host 환경 모두 51/51 PASS. 실제 사용자 Codex 앱 서버 강제 재시작·인계 및 개선 전·후 지연의 인과 비교는 미검증.
- W4/W5 자동 Cleanup, 운영 Runtime DB 이관/정리: **비활성 유지**.

다음에는 별도의 임시 작업 Runtime과 사용자가 승인한 Host 인계 세션으로 소유권·재시작·정착 영수증을 검증해야 한다. 기존 계정의 활성 작업을 중단하거나, 복구를 가장하는 임의 폴백을 추가하지 않는다.

## 추가 통합 검증 결과 (2026-11-01)

- PASS: Windows 측 Linux MCP, Windows Native, Mac 측 Linux MCP, Mac Native의 최신 a5577baa W6-A/B 집중 회귀 4/4씩, Kernel next/report·MCP·Session/Owner E2E 51/51씩.
- UNSUPPORTED (실측): Windows ↔ Linux의 같은 물리 DB를 공유 마운트로 여는 WAL 동시 Writer. 확장 오류 4618(SQLITE_IOERR_SHMLOCK)로 실패했고, 정상 커밋 뒤 무결성은 통과했다. 정상 Host-local Runtime 분리를 유지한다.
- PARTIAL: 실제 사용자 Codex 프로세스의 in-flight 세션 강제 재시작·복구, 모든 사용자 지정 공유 경로의 자동 차단, W4/W5 자동 Cleanup 및 운영 DB 이관.
- 성능: W6-A 일반 Open의 DDL/DML 쓰기 0은 측정됐으나, next/report 개선 전·후 지연은 비교하지 않았으므로 수치상 개선을 단정하지 않는다.

이번 단계는 테스트와 경계 확인이며 추가 Host 잠금 DB, OS별 폴백, 공유 WAL 호환 모듈을 구현하지 않았다.
