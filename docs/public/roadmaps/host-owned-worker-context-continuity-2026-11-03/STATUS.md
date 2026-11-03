# Host-owned Worker / Context Continuity 진행 현황

- 최종 갱신: 2026-11-03 (KST) — **W0 착수 준비 완료 (기능 미실행)**
- 기준 소스: `main / 3797c60f662d7b61e7b57b00bc41f96bf7525e94` (문서 편입 전)
- 문서: [PLAN](PLAN.md) · [W0 착수](W0_START.md) · [검증 계약](VERIFICATION.md)
- 이 파일의 상태는 **새 제품 기능의 PASS가 아니다.**

| 항목 | 상태 | 증거·다음 조치 |
| --- | --- | --- |
| v2 전략·검증 기준 분석 | 완료 (문서 검토) | 2026-11-03 제공된 v2 두 문서와 코드 기반 실행계획 사용 |
| Linux/Windows-side MCP canonical code | 읽기 전용 조사 완료 | `src/host/kernel`/`src/kernel/run`/`src/kernel/persistence` 및 `context-build.ts` |
| Mac-side MCP canonical checkout | 조회 완료 | 문서 편입 전 양쪽 `main / 3797c60f`, 별개 Runtime·DB·세션 |
| 기존 사용자 작업 간섭 | 없음 (준비 작업 범위) | 사용자 Runtime/DB·Codex 세션 종료·설치·마이그레이션 없음 |
| 프로젝트 로드맵 문서 정착 | **문서 검증 완료 / 커밋 준비** | PLAN·VERIFICATION·W0_START·STATUS와 개발 가이드 연결 검증 |
| W0 — Capability/기준선 | **SOURCE PASS / G0 PARTIAL** | [W0_RESULT](W0_RESULT.md): 코드 경계·기준선 작성, Native 실생존 미검증 |
| W0-Fix — ContextReceipt | **SOURCE PASS** | T23 재현 → 최소 수정, focused 17/17, typecheck/build/boundaries PASS. 확장 test:source-runtime timeout |
| W1 — Host-owned Worker | **DEFER / G0 Native capability 대기** | 실제 독립 start/status/reconnect와 old Writer 차단 검증 후 기술 선택 |
| W2 — status/signal/reconnect | NOT STARTED | W1 생존·Owner 경계 필요 |
| W3 — Kernel loop 결합 | NOT STARTED | 기존 Dispatcher/Goals 중복 먼저 확인 |
| W4 — E/C/D Continuity | NOT STARTED | E(요약 없는 Resume) 먼저 |
| W5 — 장애/경쟁/보안 | NOT STARTED | 각 Wave 집중 테스트 후 종합 수용 |
| W6 — A/B/E/C/D 품질·총비용 | NOT STARTED | 사전 등록된 동일 조건 평가 |

## W0 수행 결과 (2026-11-03)

- 코드/테스트 변경: `src/kernel/context-build.ts`, `tests/kernel-context-compiler.test.ts`, `tests/kernel-context-policy-authority.test.ts`. 새 public API/DB/스킬 없이 필수 Context silent truncation 방지.
- W0 결과 문서: [W0_CODE_MAP](W0_CODE_MAP.md) · [W0_CAPABILITY_MATRIX](W0_CAPABILITY_MATRIX.md) · [W0_BASELINE](W0_BASELINE.md) · [W0_RESULT](W0_RESULT.md).
- 격리 Linux TypeScript 7.0.2 빌드·타입·경계·focused 17/17 PASS. 전체 `test:source-runtime`은 16개 subtest `ok` 뒤 240초 timeout, 전체 PASS 미확정.
- Native Windows executor heartbeat stale. Native Mac은 Darwin/Codex 실행파일 경로까지만 확인, version/help 결과 미수신. 기존 사용자 프로세스/계정 DB 변경 없음.
- G0 PARTIAL이므로 W1 구현을 임의로 시작하지 않음.

## 다음 세션의 정확한 재개 지점

1. `get_work_context(cwd="/shared/moonshot-relay", format="full")`를 먼저 실행해 active task/마지막 영수증/현재 Git 상태를 대조.
2. `W0_START.md`의 "0. 입장 조건" 수행. 완료된 분석·명령은 반복하지 않음.
3. **완료한 T23 재현·수정·집중 테스트는 반복하지 않음.** G0 미완료인 Native Worker 생존/status/signal 및 Windows executor heartbeat·Mac stdout 관측 문제부터 안전한 격리 probe를 재개. 기존 사용자 세션을 종료하지 않음.
4. 기존 W0 결과 문서를 읽고 부족한 Native 실측과 확장 source-runtime timeout 원인만 추가 검증. 새로운 Worker DB/Queue/Proxy는 시작하지 않음.
5. G0 종료 판단 전 W1 구현/기본값 전환 금지. Wave별 별도 검증·한국어 상세 커밋·푸시.

## 변경 범위 원칙

이번 준비는 `docs/public/roadmaps/host-owned-worker-context-continuity-2026-11-03/` 및 개발 가이드의 탐색 링크에만 적용한다. **생산 TypeScript·테스트·생성 runtime·계정 설치는 수정하지 않는다.**

기존 [Ephemeral Work W7 결과](../ephemeral-work-persistent-knowledge-2026-10-31/W7_RESULT.md)는 실제 Codex in-flight 사용자 세션 재시작 및 Host 간 인계가 미수용임을 명시한다. 이 미검증을 다음 Worker 기능의 PASS로 옮기지 않는다.
