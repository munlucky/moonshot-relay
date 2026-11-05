# T49 P0–P1 통합 증거 매트릭스

- 작성: 2026-11-05 KST. 기준 HEAD `712185c15fea3ff406676e81cdae3d553b34df4c`.
- 원본 계약: [T49 실행계획](T49_END_TO_END_PARALLEL_VERIFICATION_EXECUTION_PLAN_2026-11-05.md), [VERIFICATION](VERIFICATION.md), [STATUS](STATUS.md).
- Linux MCP: WSL2 Linux 6.18.54.1, Node 22.23.4, `main=origin/main` clean. Linux continuity task revision 55, 미정착 실행 0.
- Mac MCP: 사용자 원본 checkout `4f1ed1b0`, 독립 continuity task revision 47, 미정착 실행 0. **원본 체크아웃과 Codex 계정은 수정하지 않는다.**
- 판정은 각각의 증거에서 직접 확인되는 범위로 제한한다. 기존 부정 반례는 후속 단발 정상 시험으로 무효화하지 않는다.

## P0 — 사전등록과 기존 증거

| Lane | 기존 원본 증거 | P1에서 확인할 범위 | 완료/보류 조건 및 위험 |
| --- | --- | --- | --- |
| A. Native 실행 | T39/T40 분리 손자 Writer, T44 hardlink, T48 격리 App Server initialize | 실제 모델 Turn/Tool의 OS 권한 상속, Host 종료 후 Writer, 임의 후손 물리 종료 | Mac 독립 Clone/임시 CODEX_HOME만. 인증 복사가 필요하면 Turn은 DEFER. `initialize` PASS는 Tool PASS 아님 |
| B. 파일시스템 | T44 사전 hardlink 100/100, T45 Git-clean alias, T46 동일 UID 비협조 쓰기, T47 DAC/Seatbelt | 생성 직후·실행 중 write exclusion, UID 분리와 FS 권한 | 원본 Owner 파일 사용 금지. 외부 Writer 한 건이라도 권한 경계 우회하면 Native 격리 미승인 |
| C. Kernel 복구 | T41/T42-B2-A/B/C/T43 실제 SQLite·Fence·CAS·Receipt | 1 Fence, TTL/stale 거부, CAS 1회/Reports 2건, crash 시 중복 Worker 0 | Linux 격리 테스트 Run·DB. Native 임의 Writer 종료 증거와 분리 |
| D. Main/Context | T23 ContextReceipt SOURCE PASS, T31 Main↔Host 재연결, T42 readback | 원본 Run/Step/Attempt·Context, cancel/approval·Goals 동시 진입 | 재조회와 실행 중인 OS Tool 복구를 구별. 불확실한 계약은 PARTIAL |
| E. 플랫폼 | T35 Mac OS Scoped Proof, T47 Linux WSL namespace EPERM, T48 Mac App Server | Linux/Mac/Windows Native 실제 OS capability | Windows native executor 없으면 DEFER; WSL은 Windows native로 계산 금지 |

### 유효성·반례 불변 조건

1. `writerExitVerified:false`, `deliveryAuthorized:false` 유지. 임의 분리 후손 종료, 미래 OS 쓰기 차단은 미증명.
2. Git clean, 단발 stat/ACL, Owner Fence/TTL, App Server 부모 종료는 단독 OS 배타성 증거가 아니다.
3. Native 자동 합류·예약 해제·Worktree 폐기·Owner CAS를 이 시험만으로 활성화하지 않는다.
4. 기존 T39–T48의 테스트 소스/결과 문서/커밋을 재사용한다. 같은 시험을 다시 실행하는 경우 변경된 소스·OS 또는 통합 계약 확인에 필요한 정확한 범위만 실행한다.
5. Lane A/B는 Mac 사용자 원본이나 기존 test-owned 보존 자료를 건드리지 않는다. Lane C/D는 고유 격리 fixture와 테스트 DB를 사용한다.

## P1 실행 기록

| Lane | 새 실행 출처/operationId | 판단 | 정확한 미증명 사항 |
| --- | --- | --- | --- |
| A | T39/T40/T44/T48 실제 Native 기존 증거 재사용; Mac `executionTarget=host` 새 확인 operation `f1429b21-8a64-44d8-8bc5-ed626882e950` 출력 없음 | DEFER | macOS 실제 모델 Turn/Tool와 임의 후손 종료를 새 실행에서 확인하지 못함. 사용자 인증 자료 이동 금지 |
| B | T44–T47 실제 부정 반례 재사용. 신규 변경된 OS 격리 후보가 없음 | PARTIAL | 동일 UID 비협조 Writer와 기존 외부 inode alias 물리 배제 실패 반례 유지 |
| C | Linux Node 22.23.4 / `712185c1`: `build:tests` op `08ff9634` exit 0 (304 tests, 9 helpers), `build` op `1b8d6c2b` exit 0 (313 files/855 edges); 1차 불일치 빌드 시험 op `cc0970a0` exit 1 (1 PASS/4 FAIL/2 SKIP); 동기화 후 3파일 회귀 op `6fbb4088` exit 1 (11 PASS/1 FAIL/2 SKIP) | PARTIAL | 남은 회귀 실패 1건 세부 원인은 현재 축약된 로그만으로 미확정. Native 물리 Writer 재합류 증명 아님 |
| D | W0 T23 ContextReceipt SOURCE PASS / T31 및 T42 readback 기존 증거 재사용; 신규 통합 Host 재연결 시험 없음 | PARTIAL | 실제 in-flight Main 교체와 Tool 생존, 승인/취소·Goals 중복 권위 미증명 |
| E | Linux WSL2 `6.18.54.1`, Node 22.23.4 확인; Mac MCP 기본 도구 `Linux aarch64`이고 Native Host 명령 빈 출력; T35/T47/T48 Mac 기존 근거, Windows native 미검증 | DEFER | 실제 macOS/Windows Native 추가 검증 부재, Linux namespace 차단 및 공통 OS confinement 미증명 |

결과가 확인될 때 각 행에 `sourceSHA / OS / fixture / operationId / exitCode / PASS·FAIL·SKIP / childExitVerified / cleanupStatus`를 반영한다. 제품 변경은 P2 결론 이전에 하지 않는다.

## T49 후속 — Kernel C Lane 실패 원인 복구 (2026-11-05)

- 원인: 실제 복구 Host의 `node -e import(...)`가 생성된 테스트 엔트리포인트 `tests/kernel-parallel-positive-two-hosts.test.mjs`를 경로 문자열로 고정함. 생성 파일이 없는 `dist/tests` 직접 실행은 `ERR_MODULE_NOT_FOUND`로 실패. `import.meta.url`은 빌더가 원본 `.ts` 경로로 변환하기 때문에 해결책이 아님.
- 최소 수정: `tests/kernel-parallel-positive-two-hosts.test.ts`의 복구 Host 자기 참조 2곳을 현재 Node test 진입점 `path.resolve(process.argv[1]!)`로 연결. 제품 코드 변경 없음.
- Linux Node 22.23.4 / T49 검증: 빌드 304 tests/9 helpers PASS; 수정된 crash/dual/TTL 집중 3 PASS/0 FAIL; **전체 3파일 회귀 12 PASS/0 FAIL/2 macOS SKIP** (op `4ccf54c6-244a-47b9-8fd4-99e0197d9175`, exit 0).
- `npm run typecheck` PASS, `npm run check:boundaries` PASS (9 modules/313 files/855 edges), op `bd700cc5-beb3-47e1-9ca9-aa07d49b2184`, exit 0.
- 환경: `NODE_ENV=production` 때문에 dev TypeScript 바이너리 누락. `npm install --include=dev --no-save --ignore-scripts --package-lock=false`로 현재 테스트 설치만 복구. 사용자 설정과 package-lock 수정 없음.
- C Lane Kernel 집중 회귀: **PASS (검증된 유한 동기식 Fixture에 한함)**. macOS OS-Scope SKIP은 Native PASS로 대체하지 않는다. 기존 Native OS Writer 반례 때문에 G0/P2는 여전히 HOLD_SAFE.
