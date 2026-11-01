# W6 — SQLite Open 경량화와 Host writer 경계 점검

- 기준: `main / c29a5fc5`
- 작업 범위: W6-A DB Open 반복 DDL·UPDATE 제거 및 재시작 호환성 검증, W6-B Windows/Linux writer 경계 읽기 전용 점검
- 수정 대상: Kernel 스키마 초기화·마이그레이션·Knowledge 네임스페이스 복구 진입
- 판정: **W6-A PASS(집중 격리 검증), W6 전체 PARTIAL**. Host 사이 공유 SQLite의 원격 잠금·실제 중단 복구는 아직 수용하지 않았다.
- 운영 DB, 활성 Codex 세션, 사용자 Runtime 설치본은 변경·이관·삭제하지 않았다.

## 1. 관측된 기존 문제

기존 `openKernelStateStore()`는 매번 `initializeKernelSchema()`, `migrateKernelSchema()`, `recoverKnowledgeMigrations()`, `runJournalSchema()`를 실행했다. 과거 Migration은 인덱스 재생성·작업 이력 보정·Worktree backfill 등 DDL과 DML을 포함한다.

별도 임시 DB를 최초 생성하고 닫은 뒤, **다시 여는 동작만 두 번 수행**했다. 그 사이 외부 SQLite 연결에서 읽은 값은 `schema_version: 153 → 157`, `data_version: 2 → 3`, `user_version: 0`이었다. 작업 실행 없이도 스키마/데이터 변경이 반복된다는 재현 증거다.

## 2. 구현한 최소 변경

- `KERNEL_SCHEMA_REVISION=1`을 기존 Migration 모듈에 선언하고 SQLite의 기본 `PRAGMA user_version`으로 적용 완료를 표시한다. 별도 DB 테이블이나 새로운 Migration Runner는 만들지 않았다.
- 새 DB·구형 무버전 DB는 기존 스키마/마이그레이션을 **그대로 실행**한다. 모든 단계와 복구가 성공한 뒤에만 버전을 기록한다. 중간 실패 시 이전 버전을 유지해 정상 복구 경로가 재진입한다.
- 현재 버전의 DB는 전체 스키마 DDL·과거 backfill·append-only 트리거 재생성을 건너뛴다.
- 매 연결마다 필요한 `busy_timeout`, `foreign_keys`, `synchronous` 설정은 **항상 유지**한다. 현재 버전 DB에서 WAL이 아니면 조용히 변환하지 않고 명시적으로 오류를 반환한다.
- 자신보다 미래의 `user_version`은 **쓰기 없이 거부**한다. 오래된 실행기가 새 DB 스키마를 다운그레이드하거나 임의 보정하지 못하게 한다.
- 완료된 Knowledge 네임스페이스 복구 저널은 매 Open에서 계속 검색한다. 다만 **실제 pending 저널이 있어서 identity commit witness를 확인해야 할 때만** 프로젝트 관련 SQLite 테이블 메타데이터를 스캔한다.
- W5의 `run_journal` 삭제 보호 트리거는 매 Open에 SQL 정의를 검사하지만, 최신 정의라면 쓰지 않는다.

스키마 정의·마이그레이션을 향후 변경할 때는 같은 정식 Revision을 증가시켜야 한다. 구형 버전과 신버전을 같은 DB 파일에 동시 실행하는 것은 허용된 동작으로 주장하지 않는다.

## 3. Host 소유 경계 관측

현재 연결의 읽기 전용 Host 점검:
- Linux MCP: `/root/.moon-relay-kernel` (명시 환경 변수 적용, 저장소와 분리)
- Windows Native: `C:\Users\moon\.moon-relay-kernel` (사용자 계정 기본 Runtime, 저장소와 분리)

**현재 두 Host의 Runtime DB 경로는 서로 다른 OS별 저장 위치**다. 따라서 조사한 실행 환경에서는 동일 SQLite 파일을 직접 공유하고 있다고 볼 근거가 없다. 그러나 Mac Native/MCP, 사용자가 override한 공유 UNC·WSL mount 경로, cross-OS 동시 writer, 코덱스 재시작 인계는 검증하지 않았다.

SQLite 연결·트랜잭션 Authority는 그대로 유지한다. Host 전역 Writer Coordinator, Kafka, 별도 영구 Lock DB, Host별 예외 규칙은 새로 만들지 않는다. **통합 수용 조건인 cross-OS same-file writer 0은 아직 PARTIAL**이다. 로컬 Runtime 분리를 모든 Host에서 검증하기 전 운영 공유 DB로 전환하거나 자동 Cleanup을 활성화하지 않는다.

## 4. 검증 항목 및 판정

- W6 신규 격리 테스트: 최신 DB 반복 Open 3회의 `schema_version`/`data_version` 불변; legacy DB의 1회 index 재구축; 이후 재Open 불변; 더 높은 schema revision 읽기 거부·쓰기 없음.
- Windows Native에서도 동일 신규 테스트 실행.
- 기존 Project Identity/Knowledge Migration·Step·Report Recovery 집중 회귀로 오래된 DB와 FS 복구 계약 유지 확인.
- TypeScript runtime/test 빌드·생성물 정합성·Boundary PASS 확인.

- 격리 DB 단순 Open 두 번: 변경 전 schema_version 153→157, data_version 2→3, user_version 0. 변경 후 schema_version 153→153, data_version 2→2, user_version 1. 관측된 DDL 및 지속 데이터 쓰기 0.
- 신규 빠른 Open 및 Migration/미래 버전 거부 테스트: Linux 2/2 PASS, Windows Native 2/2 PASS.
- 기존 구형 Migration/Knowledge identity 회복/Step/Report 회귀: Linux 14/14 PASS, Windows Native Report Migration + W6 5/5 PASS.
- 기존 Report Migration fixture가 최신 상태로 stamping된 뒤 과거 report_digest를 직접 주입하므로 최초 회귀에서 3개 실패했다. 테스트 fixture를 실제 레거시 DB와 같도록 user_version=0으로 만들고 다시 검증하여 14/14 PASS를 확인했다. 정상 최신 DB를 무조건 재마이그레이션하는 폴백은 추가하지 않았다.
- TypeScript Runtime build/build:check, 테스트 build/build:tests:check (290 tests + 8 helpers), check:boundaries (9 modules, 308 files, 842 edges): 모두 PASS.

**W6-A 경량화 PASS.** W6-B cross-OS 공유 SQLite 파일 writer 분리/복구 및 Mac 수용은 아직 PARTIAL이며, 운영 DB와 일반 자동 Cleanup은 변경하지 않았다.

**남은 작업:** W6-B cross-host writer 동시성/재시작 검증, Mac Native/MCP, 운영 Runtime 설치본 점검, W7 실제 사용자 Run·세션 복구 수용. 이 범위를 완료하기 전 전체 Ephemeral Work는 PARTIAL로 유지한다.
