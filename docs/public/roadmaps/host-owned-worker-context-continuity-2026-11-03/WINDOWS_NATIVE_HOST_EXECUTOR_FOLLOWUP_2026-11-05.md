# Windows Native MCP 실행기 재연결 및 L1A 실측 상태 (2026-11-05)

- 기준 HEAD: `c5f16c0fb078986d65dab4e67f0921fef865f7f6`, `main=origin/main`, 변경 전 clean.
- 기존 Windows 로컬 증거: [MCP 인계](LOCAL_NATIVE_VERIFICATION_MCP_HANDOFF_2026-11-05.md), [로컬 계획](LOCAL_NATIVE_VERIFICATION_EXECUTION_PLAN_2026-11-05.md).
- **변경된 사실:** `moonremote exec_command(executionTarget=host)`에서 `powershell -NoProfile` 명령의 실제 출력·종료 코드 관측 가능. 이전에 Native 출력이 불명확했던 구간의 실행 수단은 이제 사용 가능함.
- 성공한 OS 식별: `native-host-probe`, `Microsoft Windows NT 10.0.19045.0`, `C:\dev\moonshot-relay`; exit 0; 실행 operation `b5c10f9f-3b90-4ea4-ae11-7dd733cfb969`.
- **별개 미완료:** Windows 실제 제한 토큰/별도 SID 프로세스 생성·DACL 접근 시험은 이번 실행에서 성공한 증거가 없음. Token 권한 조사 호출은 도구 안전 검사에서 차단되어 우회하지 않음. 앞선 구문 오류 PowerShell 명령은 실행 결론이 아닌 명령 인용 오류.
- 현재 `codex-app-server-transport.ts`의 App Server `spawn` 및 `writerExitVerified:false`, `host-owned-writable-attempt.ts`와 `parallel-dispatcher.ts`의 `deliveryAuthorized:false`를 소스에서 다시 확인. 설계 변경·제품 승인 없음.
- **판정:** Host Native 실행 연결 확인 PASS, Windows 별도 OS 보안 주체의 실제 Tool/파일 접근은 **DEFER**, G0 PARTIAL / G1 DEFER / G6 NOT_RUN / P2 **HOLD_SAFE**.
- 다음 실제 실행 조건: 적법하게 승인된 Windows 별도 보안 주체의 Native 프로세스가 보호 Owner 테스트 DACL에 대해 직접·기존 hardlink·외부 Writer 모두 차단됨을 확인하고, 독립 CODEX_HOME의 정식 시험 인증이 준비된 이후에만 L2~L4로 확장한다.
- 기존 Kernel C Lane 성공 및 Windows L0/L1 원본 결과를 중복 실행하지 않는다. 단독 Job Object 종료/제한 토큰 객체 생성/initialize 성공을 실제 Tool 격리로 전용하지 않는다.
- 보안 차단이나 사용자 승인 대기를 가정한 우회 시도, 새 상시 감시자, DB, Queue, Scheduler, Provider별 예외 분기 없음. 제품 코드 및 사용자 OS 계정/인증/실제 Run 미변경.
