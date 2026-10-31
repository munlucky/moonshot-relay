# Ephemeral Work · Persistent Knowledge — 구현 실행 계약

- 작성: 2026-10-31
- 기준 저장소: `/shared/moonshot-relay` / Windows `C:\dev\moonshot-relay`
- W0 조사 시작 기준: `main / c53bcd63` (clean)
- 목표: Agent/Host가 수행하는 작업의 영구 Run 이력 의존을 줄이고, Kernel은 최소 Work/Trust 및 검증된 Knowledge 영속화를 담당한다.
- 이번 파일은 2026-10-31 상세 계획의 저장소 내 실행 요약이다. 기존 v2 W0~W10과는 **별도 전략**으로 취급한다.

## 결정된 제약

1. SQLite는 유지한다. PostgreSQL·Kafka·범용 Event Store·이중 저장을 도입하지 않는다.
2. 완료된 작업의 영구 Run/Step/Attempt 누적은 축소 목표다. **진행 중** 작업의 소유권·재개·검증 근거까지 제거하지 않는다.
3. 소유권, 범위, CAS/fencing, 필수 검증, 보호된 Reviewer, 승인된 Git closeout, Knowledge Revision/Supersession은 유지한다.
4. Knowledge는 검증된 출처·적용 범위·내용 digest와 최소 검증 근거를 영속화한다. 에이전트의 자기 보고를 검증 권위로 대체하지 않는다.
5. 기존 Host/Codex 세션이 제공하지 않는 복구를 지원한다고 가정하지 않는다. Agent 세션은 삭제될 수 있다.
6. Runtime을 읽지 못하는 경우 무조건 허용/자동 초기화하지 않는다. 필수 권위 오류는 쓰기 차단, 선택적 Context/Analytics 실패는 좁게 격리한다.
7. 새 Host별 하드코딩/폴백, 영구 shadow DB, 무기한 이중 경로, 지침 누적을 만들지 않는다.
8. 운영 DB 교체·정리·세션 강제 재시작·계정 설치는 별도 승인/실제 native 검증이 필요하다.

## Wave 실행·검증 계획

| Wave | 목표 / 변경 경계 | 통과 조건 |
| --- | --- | --- |
| **W0** | 38개 테이블/인덱스/FK·writer/reader·권위/수명 전수조사, Windows/Mac/MCP 소유 경계, 현재 상태의 위험 | 근거가 있는 목록과 미검증 구간, 계약 변경 목록, 후속 테스트 매트릭스 |
| **W1** | Agent/Host 세션 복구 및 MCP 인계 실험. 영구 Run 제거 금지 | 정상/크래시/인계에서 재개 정확성, 무단 writer 0; 미지원은 명시 |
| **W2** | 활성 Run에서 검증된 Knowledge Commit을 정리 전에 완료하고, 확정된 Knowledge의 영구 Run 조회 의존 제거 | 완료 Knowledge의 Read/CAS/Supersede·동일 트랜잭션 재조회가 Run 없이 동작; 신규 Commit은 기존 Trust 검증 유지, 허위 출처·stale Revision 거부 |
| **W3** | Trust·Completion·Git closeout의 **정착 전** 최소 상태만 유지 | 중복 commit/push 0, Reviewer/Proof/승인 우회 0, required Knowledge 누락 시 false done 0 |
| **W4** | 일반 단일 Step부터 Ephemeral Work로 이전하고 활성 체크포인트만 유지 | 완료 뒤 영구 Run 누적 0; crash/retry/owner conflict에도 무단 변경 및 허위 PASS 0 |
| **W5** | FK 소비자 제거 확인 후 파생 Receipt/Context/Telemetry 및 구형 Run 저장 축소 | 운영 기록은 일관 백업 보존, Knowledge 출처/Revision 보존; 기존 운영 데이터 삭제 별도 승인 |
| **W6** | SQLite 일반 open의 반복 DDL/UPDATE 분리, WAL 파일 소유 Host 경계 정리 | 정상 `next/report`에서 불필요한 DDL 0; cross-OS 동시 SQLite writer 0; 오류 분류와 재시작 검증 |
| **W7** | Windows native / WSL2 MCP / Mac native / Mac MCP 기준선 대비 통합 수용 | 실제 Host E2E, Git/Knowledge/Owner 무결성, 복구율·DB write·지연 개선; 미실행은 PARTIAL |

**순서:** W0 필수 선행. W1과 W2의 격리 분석은 병행 가능하지만, W2 지식 독립성과 W3 완료 정착이 증명되기 전에 W4/W5 영구 Run을 삭제할 수 없다. 각 Wave는 하나의 독립적 검증·판정·한국어 상세 커밋/푸시 단위다.

## W2 실행 계약 조정 (2026-10-31 실측 후)

초기 W2의 'Run 없이 신규 Knowledge를 승인·커밋'하는 해석은 독립적인 새 승인 Authority 또는 준비 상태를 요구하며, DB 의존성 축소와 Trust 보존 목표에 반한다. **새로운 지식은 검증된 활성 Run에서 정리 전 Commit 완료**가 필수다. 그 후 Run/Completion/Review 기록이 정리되어도 **완료된 지식의 조회·CAS·Supersession 및 동일 트랜잭션 결과 재조회**는 FK가 없는 Knowledge 표면으로 수행한다. 미완료된 새 Commit은 자동 승인하지 않는다.

이 해석은 W3 정착 확인과 W5 FK 소비자 분리 전 **운영 Run 삭제를 허용하지 않는다**. W2의 구현 회귀와 전체 시스템 수용은 구분한다. 근거와 변경 범위는 [W2_RESULT.md](W2_RESULT.md) 참조.

## W0 기준선/관찰 방법

- **코드:** `src/kernel/state-store.ts`, `src/kernel/persistence/*.ts`, `src/kernel/control-plane.ts`, `src/kernel/run/*.ts`, `src/host/kernel/*.ts`, `src/application/kernel-cli/main.ts`의 실소비자 확인.
- **SQLite:** 운영 DB에 `immutable=1&mode=ro`로 연결하여 스키마와 인덱스/FK 메타데이터만 조사. WAL 변경, checkpoint, migration, vacuum, repair 금지.
- **환경:** Windows native와 WSL2가 같은 `C:\Users\moon\.moon-relay-kernel\state\runtime-state.sqlite`를 가리키는 경로가 조사됨. Mac 네이티브/원격 MCP 별로 DB 소유/실시간 인계 여부는 독립 입증 필요.
- **성능 기준:** 새 측정값을 기존 W9 p50/p95와 혼용하지 않는다. 같은 HEAD의 격리 fixture로 `next/report`별 DB writes, latency, 전후 file size, 작업 정착을 비교한다.
- **실패 주입:** owner conflict, stale step, crash-after-Git, required/optional Knowledge 오류, stale CAS, SQLite corrupt, wrong Host, session lost.
- **결과:** `W0_STORAGE_INVENTORY.md`와 `W0_RESULT.md`. 소유권/성능/Native 미측정 시 W0를 조건 없이 PASS로 표시하지 않는다.

## 진행 중 기존 작업과의 경계

기존 `docs/public/roadmaps/kernel-structural-improvement-2026-10-30/`의 W0~W10 결과는 역사적 검증 자료다. 기존 활성 MCP 체크포인트에는 Windows 실제 사용자 세션 재시작/복구 E2E 미확인이 남아 있다. 이 작업이 그 증거를 대체하거나 기존 작업을 자동 완료시키지 않는다.

운영 데이터를 직접 바꾸거나 기존 사용자의 진행 중 Codex 세션을 종료하지 않는다. Git 작업 트리에 다른 작업의 변경이 관측되면 해당 Wave 변경만 별도 보존하고 무단 병합하지 않는다.
