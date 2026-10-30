# W0 환경·백업·회귀 증거 인벤토리

**작업:** `e72d8f88-5920-426b-8565-0edc713faa18` · 2026-10-30 · W0 PARTIAL

| 표면 | 기준선/결과 |
|---|---|
| Moonremote Linux | `/shared/moonshot-relay`, Node v22.23.4, `main`, HEAD `bde95dab464461e6c810af0c8458bdd9b78011d0` |
| Origin tracking | 조회 시 로컬 `origin/main` 동일 (fetch 미실시) |
| Worktree/프로세스 | 등록 worktree 1개, W0 이전 확인한 Kernel/Codex 관련 실행 프로세스 0, MCP unsettled 0 |
| 원본 SQLite | `~/.moon-relay-kernel/state/runtime-state.sqlite`, 읽기 전용 조사, 226,783,232 bytes |
| 백업 | `/tmp/moonshot-w0-backup-qtJAXQm0/runtime-state-backup.sqlite`, 226,783,232 bytes |
| 백업 SHA-256 | `72b3efa43c4fdcec1492159979fd50ad121a431d0bd462364ae24a238faf033d` |
| 백업 방법 | `sqlite3` Online Backup API; source URI `mode=ro`; 별도 destination; `timeout` 외부 85초 및 후속 강제종료 조건 |
| 백업 검증 | 전체 `PRAGMA integrity_check = ok` / 15.33초 / ACCEPTED |
| 백업 인벤토리 | `/tmp/moonshot-w0-backup-qtJAXQm0/backup-manifest.json` (Git 미포함) |
| 격리 테스트 | `/tmp/moonshot-w0-cases-k6N6GsRd`, `project`·`runtime`·`home`·`tmp`·`cache`·`config` 각각 격리 |
| 자식/재시작 | HOME, MOON_RELAY_KERNEL_HOME, TMPDIR, XDG 경로 상속; fixture project의 `bin`/`scripts` 링크는 소스 실행만 참조 |
| 테스트 로그 | `/tmp/moonshot-w0-cases-k6N6GsRd/results-v2.tap`, 163/163 PASS, 130606.93ms |
| 재현 가능한 W0 fixture | `docs/public/roadmaps/kernel-structural-improvement-2026-10-30/fixtures/delivery-fence-restart-probe.mjs` (`node .../delivery-fence-restart-probe.mjs c06|c07_external|c07_partial|c08|c08_busy`; 인자 각각 독립 실행) — 임시 프로젝트/Runtime 생성·삭제, 운영 DB 미사용 |
| C06 장애 주입 | `/tmp/moonshot-w0-cases-k6N6GsRd/c06-result.log`: DB fixture owner lease 만료 → 실제 Delivery bytes 변경 0, Git clean, revision 0, restart active |
| C08 장애 주입 | `/tmp/moonshot-w0-cases-k6N6GsRd/c08-result-v2.log`: 실제 patch bytes 반영 뒤 Control Plane 기록 실패 2곳 주입 → restart blocked/recovery required |
| C07 추가 재현 | `/tmp/moonshot-w0-check-iye3P2sa/c07_external.log`, `c07_partial.log`: 적용 뒤 제3자 변경·부분 파일 상태 각각 blocked, revision 0 |
| C08 SQLite 잠금 재현 | `/tmp/moonshot-w0-check-iye3P2sa/c08_busy-verified.log`: 실제 BEGIN EXCLUSIVE, 두 API에서 ERR_SQLITE_ERROR → unlock 뒤 restart blocked |
| C07 자식 프로세스 중단 | `fixtures/real-git-apply-crash-probe.mjs`: 실제 Git SIGKILL, 3,000개 중 16개 적용 뒤 restart blocked, 잔여 파일 보존 |
| C06 자식 프로세스 제한 | `fixtures/git-apply-deadline-probe.mjs`: 250ms·SIGTERM·ETIMEDOUT, 996/3,000 파일 생성 뒤 추가 writer 미관측 |
| 재현 로그 | `/tmp/w0-repro-final-FTmxyMDL/{crash,deadline}.log` (현지 임시 자료, 영구 증거는 fixture/커밋) |
| 컴파일 환경 | boundaries 175초에도 exit124; Runtime graph `scandir(src/contracts)` ENOMEM, 동일 위치 `find` 실패; Linux native TypeScript 패키지 없음 |
| 소스 파일 | 테스트 전후 `src/kernel`, `src/host/kernel`, `tests` 추적 파일 목록·해시 동일; HEAD 불변 |
| 빌드 검증 | `check:boundaries` exit 124 (60초); `build:check` exit 124 (60초); `typecheck` exit 1 (Linux native TS package 없음) |
| 미시험 표면 | Windows native, Mac 연결 Linux workmachine, macOS native, 실제 Provider 세션 |

### 읽기 전용 DB 크기/개수 통계

- DB 테이블: 39개.
- `knowledge_context_receipts`: 62.52 MiB / 1,608건.
- `run_step_attempts`: 50.70 MiB / 1,319건.
- `evidence_packs`: 39.07 MiB / 1,785건.
- `finalization_receipts`: 21.21 MiB / 397건.
- `runs`: 13.74 MiB.
- `knowledge_records`: 2,001건 중 `known_failure_pattern` 1,915건(고유 statement 34개).
- `session_bindings`: 415건 중 active 25건.

모든 데이터 집계는 운영 DB가 아니라 일관 백업 사본에서만 수행했다. 백업은 운영 변경 전용이 아니라 조사 사본이며 최신성 보장/rollback 원본으로 사용하지 않는다. Git HEAD·파일 snapshot·SQLite backup은 서로 원자적 스냅샷이 아니다. 부하/지연의 인과나 수치 개선량은 미확정이다.

### 사용자 파일·Git 보호 점검

테스트 전 staged/unstaged 0건이었고 테스트 종료 뒤 직접 Git 조회도 clean이었다. `skills/explain-diff-html/scripts/render.py`는 작업 트리 CRLF(205행)와 HEAD LF(205행)의 차이만 확인됐으며, 정규화한 실제 내용은 동일하다. W0는 이 파일을 수정하지 않았다. 사용자가 소유한 기존 파일·설치·운영 DB는 변경 대상으로 삼지 않았다.

### 종료까지 필요한 별도 검증

- 물리적 늦은 writer/DB 차단 쓰기 실패의 원본 바이트·revision·재시작 결과(C06~C08)
- 소유 Wave 결정 뒤 독립적으로 가능한 build/typecheck/Native 호스트 검사
- 원격 추적 최신성 확인 및 필요한 문서 커밋/푸시 (force push·일괄 staging 금지)
