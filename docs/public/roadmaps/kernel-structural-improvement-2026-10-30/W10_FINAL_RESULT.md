# W10 통합 최종 판정 — 2026-10-31

**전체 통합 판정: PARTIAL (Linux SOURCE 회귀 통과, 필수 native Host/계정 설치 미검증).** 각 Wave에서 실제 검증된 PASS·KEEP 결과는 보존한다. 운영 승인 대기를 외부 소유로 변환하지 않는다.

## Wave별 결과와 커밋

| Wave | 판정 | 커밋 |
|---|---|---|
| W0 | 격리 Linux Safety/Build PASS | `40921a61` |
| W1 | Run/Session authority PASS·keep-baseline | `6edf5075` |
| W2 | 차단 Class 권위 오류 수정 PASS | `861b36ab` |
| W3-A | 승인 전 물리 파일 적용·재시작 PASS·keep-baseline | `9d8003ea` |
| W3-B | 승인 후 Git/Identity 사용 PASS·keep-baseline | `34ccc418` |
| W4 | Proof/Review SOURCE PASS; Windows native SKIP | `4142c353` |
| W5 | 다른 required_verification 의무 저장 누락 수정 SOURCE PASS; 운영 migration 선택 보류 | `4bd47194` |
| W6 | Receipt 감사/복구 21/21 PASS, 비용 최적화 KEEP | `30b49cf4` |
| W7 | Knowledge/Context 42/42 PASS, 최적화 KEEP | `1efb350f` |
| W8 | Linux SOURCE/Installer 재빌드 9/9 PASS, native Host/계정 설치 미검증 | `8d4ac071` |
| W9 | next/Proof/Prompt/Cache 50/50 PASS, 실측 성능 개선 미입증 KEEP | `09796afa` |

W10 문서 커밋은 최종 SHA가 기록되는 Git 로그를 권위로 사용한다.

## W10 실제 통합 재검증

- `npm run test:kernel-recovery`: **24/24 PASS**, 원본 Linux 작업공간.
- `npm run test:kernel-lifecycle`: **66/66 PASS**, 원본 Linux 작업공간.
- `npm run test:kernel-unification`: 원본 공유 작업공간 12/13 PASS(1건은 `runtime_build_stale`로 안전 거부). **동일 HEAD의 격리 Linux `npm ci`, Runtime/Test build 이후 13/13 PASS**.
- `npm run typecheck`, `npm run check:boundaries`, `npm run build:check`: 동일 HEAD 격리 Linux에서 모두 **PASS**, `build:check` 308파일 changed=0·removed=0, 9 modules·841 edges.
- `npm run test:kernel-reliability`: 원본 공유 경로에서는 240초 제한에 도달(225번째 테스트까지 PASS). Git 없는 archive 격리 빌드는 **279 PASS / 2 FAIL / 1 SKIP**이었으며, Git HEAD 조회 불능과 Reviewer 경쟁 결과 차이가 원인이었다. 원본 Git checkout에서 해당 사례 **2/2 PASS** 확인 후, **실제 Git 이력과 Linux native dependencies를 갖춘 별도 checkout**에서 동일 HEAD의 Runtime/Test build를 검증하고 **전체 Reliability 282/282 PASS (0 FAIL, 0 SKIP)**로 재실행 완료했다. 앞선 실패 이력은 보존하되 최종 Linux SOURCE 검증은 PASS다.
- W10 재검증에 사용한 `git archive` 새 사본에는 원래 Git 추적 밖 생성 파일이 빠져 있다. Runtime build·test build 순서가 요구되며 native Linux optional packages를 격리 사본에 설치한다. 설치 거부·환경 차이를 제품 코드 실패로 오인하지 않는다.

## 복잡도·소유권·환경 검토

- W2와 W5의 실제 결함 외에 새 상시 Rule, DB writer, cache router, 누적 fallback은 추가하지 않았다. W5 저장 dedup는 기존 canonical identity를 재사용한다.
- 운영 DB·Knowledge 1,915건을 삭제/병합하지 않았다. 선택적 W5-B migration의 비용/품질 이득 미입증, 기존 계보 보존을 우선한다. 실제 운영 정리가 필수로 다시 정의되면 승인 대기 상태는 PARTIAL이지 external_owner가 아니다.
- Linux WSL2/9p, Windows native 계정, Mac 연결 Linux workmachine, 실제 macOS native는 서로 다른 실행 표면이다. 이번 검증의 `SOURCE PASS`는 Windows/macOS native smoke, 실제 Codex Reviewer Host, 계정 설치 source/payload SHA, 계정 Runtime 재시작 성공을 증명하지 않는다. **INSTALL NOT APPLIED / NOT VERIFIED**. Mac 연결의 별도 Workspace는 같은 HEAD를 가리킨다는 증거가 없으므로 이 계획 검증으로 합치지 않는다.
- 실제 Provider 사용량/캐시토큰/first edit→delivery wall time A/B는 확보하지 못했다. W9 성능 성과는 주장하지 않는다.
- 원본 작업 트리의 기존 사용자 변경·staged 내용은 훼손하지 않는다. `render.py`의 간헐적 CRLF/LF 차이만 관찰했으며 해당 파일을 제품 수정·커밋하지 않았다.

## 인계 및 남은 필수 검증

1. **W8 Native Host 검증:** Windows native 설치/Runtime/Profile source digest·재시작·Codex/Reviewer 경계, 실제 macOS native가 계획의 필수 표면인지 확정 후 필요한 경우 native E2E. 사용자 계정 설치는 소유권·진행 작업 보호를 검증한 별도 승인 절차가 필요하다.
2. **W10 Reliability 결정:** 실제 Git checkout과 정상 생성 Runtime 및 플랫폼별 의존성을 맞춘 격리 환경에서 전체 Reliability를 재실행하고 Reviewer 경쟁 상태를 반복 검증한다. 부분 PASS를 전체 PASS로 승격하지 않는다.
3. **운영 승인 경계:** 운영 Knowledge migration은 비필수 보류. 추후 실제 필수가 되면 owner 승인·Online Backup·dry-run·rollback 없이 변경하지 않는다.

**현재 결론:** W4~W9의 확보된 검증/변경은 적용했고 `main`에 Wave별 푸시했다. W10 최종 RELEASE 판정은 **PARTIAL**. 필수 native Host·계정 설치 검증이 충족되기 전 `COMPLETE`라고 선언하지 않는다.
