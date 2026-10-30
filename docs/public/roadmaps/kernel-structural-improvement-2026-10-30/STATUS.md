# 통합 구조 개선 v2 진행 현황

- W0: **PASS (대표 안전 반례 + 동일 HEAD의 격리 Linux 소스 기준선)** — SQLite Online Backup 무결성, 163/163 회귀, C06~C08 대표 실패·파일 바이트/재시작, native TypeScript 7.0.2, boundaries/build/build:check 확인. 공유 9p/Windows·macOS native 검증은 별도 Host 범위로 이관. 통합 W0~W10은 미완료.
- W1: **PASS / keep-baseline** — 격리 회귀 16/16 및 실제 SQLite Active/Blocked/Completed Run+stale Session Binding 재시작 fixture PASS. 생산 코드 변경 없음. W2: **PASS** — Report 차단 분류 권위와 구형 차단 투영 오류 수정, 격리 회귀 49/49 PASS. W3~W10은 NOT STARTED. W3-A는 C06~C08 현행 P0 위반이 확인될 경우 최우선으로 전환. 현재는 재현된 제품 P0 위반이 없다.
- 완료와 승인: 운영자 승인이 범위 내 필수이면 승인 대기 상태는 `PARTIAL`이며 `external_owner`가 아님. 실제 외부 소유 작업만 `external_owner`로 분류.
- 다음 작업: **W3-A/B**의 독립 검증 범위를 확인하되 W0의 C06~C08 안전 결과를 재사용. 현행 P0 반례가 없다면 W3-A의 새 방어 구현을 강행하지 않는다. W3-B는 승인 후 Git/Identity 사용 지점에 한정한다.
- 생산 코드 변경: W0/W1은 없음. W2는 기존 Kernel 차단 분류 권위 경계 2곳을 수정. 새 실행 엔진·DB 필드·하드코딩·모델-visible 지침 추가 없음.
- 격리 재현 스크립트: `fixtures/delivery-fence-restart-probe.mjs` (`c06`, `c07_external`, `c07_partial`, `c08`, `c08_busy` 재실행 성공). 제품 코드/상시 단계 추가 없음.
- 이번 재개(2026-10-30): C07 외부 파일 변경과 부분 파일 상태, C08 실제 SQLite 배타 잠금 실패 후 재시작 격리 테스트 PASS. C06 `git apply` 실행 도중 만료와 C07 실제 프로세스 종료·C08 스토리지 I/O 전 범위는 미검증. W0 PARTIAL 유지.
- 추가 실행(2026-10-30): C07 실제 Git 자식 SIGKILL 뒤 16/3,000 물리 파일 보존 및 Kernel restart blocked/revision 0, C06 실제 Git 250ms timeout 뒤 996/3,000 파일 및 만료 이후 추가 쓰기 0 확인. `check:boundaries` 175초 timeout, Runtime graph 디렉터리 열거 ENOMEM 별도 입증. 새로운 생산 방어 로직/DB 필드/규칙 추가 없음.
- W0 환경 최종 검증: `W0_ENVIRONMENT_VERIFICATION.md`. Windows 9p 경로 `ENOMEM`, Linux native 플랫폼 의존성 누락 및 npm omit=dev를 분리. `/tmp` Linux 사본에만 필요한 의존성을 설치하고 정상 `build → build:check`까지 PASS. 제품 빌드 폴백·모델 지침·DB 상태 추가 없음.
- W1 초기 조사: `W1_RUN_AUTHORITY_BASELINE.md`. Moonremote `get_work_context`의 partial/HEAD null은 실제 Git HEAD 상실과 동일하지 않으며, Kernel 수정 전에 인과 검증 필요. Session Binding은 Task identity가 아님.
- W1 결과: `W1_RESULT.md`; 독립 SQLite 재시작 경로에서 오래된 완료 Run Session Binding이 있어도 Run 선택·재개 오류가 재현되지 않았다. `get_work_context` 부분 관측은 외부 Moonremote 경계로 구분하고 Kernel 코드는 keep-baseline.
- W2 최종 증거: `W2_RESULT.md`. 호출자 차단 분류 상·하향 주입 거부, 구형 SQLite blocked 27건의 NULL Class 투영 정합화. 49/49 회귀 통과. C03 독립 구현이 불필요하게 중단됐다는 인과는 미확정으로 보존.
