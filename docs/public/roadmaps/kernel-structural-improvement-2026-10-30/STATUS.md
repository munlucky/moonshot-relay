# 통합 구조 개선 v2 진행 현황

- W0: **PARTIAL** — 2026-10-30 Linux 기준선·DB Online Backup 무결성·격리 회귀 163/163 확인. C06 패치 실행 중 늦은 writer, C07 실제 프로세스 종료, C08 저장 장치 I/O 장애 전 범위, 빌드 제한시간 및 native TypeScript 환경은 미확인.
- W1~W10: **NOT STARTED**. W3-A는 C06~C08 현행 P0 위반 입증 시 최우선으로 전환.
- 완료와 승인: 운영자 승인이 범위 내 필수이면 승인 대기 상태는 `PARTIAL`이며 `external_owner`가 아님. 실제 외부 소유 작업만 `external_owner`로 분류.
- 다음 작업: `W0_CASE_MATRIX.md`의 C06 적용 중 lease 만료·C07 crash/부분 적용·C08 SQLite I/O 실패를 완전 격리 재현한 후 W0 최종 판정. 동일 소스에 재검증된 근거만 사용.
- 생산 코드 수정: 없음. 새 실행 엔진·DB 필드·하드코딩·fallback·모델-visible 지침 추가: 없음.
- 격리 재현 스크립트: `fixtures/delivery-fence-restart-probe.mjs` (`c06`, `c07_external`, `c07_partial`, `c08`, `c08_busy` 재실행 성공). 제품 코드/상시 단계 추가 없음.
- 이번 재개(2026-10-30): C07 외부 파일 변경과 부분 파일 상태, C08 실제 SQLite 배타 잠금 실패 후 재시작 격리 테스트 PASS. C06 `git apply` 실행 도중 만료와 C07 실제 프로세스 종료·C08 스토리지 I/O 전 범위는 미검증. W0 PARTIAL 유지.
