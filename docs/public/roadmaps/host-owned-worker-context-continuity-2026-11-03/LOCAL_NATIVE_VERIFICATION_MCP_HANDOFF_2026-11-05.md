# Windows 로컬 Native 검증 — MCP 인계 수신·증거 판정 (2026-11-05)

- 원본 실행 기준 SHA: `76eee92c53e2a9d435e1cf3a9c2a9c0e2299e664`.
- 검증 환경: Windows 10 Pro x64 build 19045, Node v24.18.0, Codex Desktop CLI `0.166.0-alpha.6`.
- 수신: Moonremote Linux workmachine에서 Windows 마운트 `/c`를 통해 **두 원본 사본을 읽기 전용으로 확인**. 사본은 운영/사용자 CODEX_HOME에 접근하거나 수정하지 않았다.
- 로컬 Markdown SHA-256: `a8f24e89bb10945274c5bebc984619d14d8cdc2afa32ad5c27f55af2c9d57c10`.
- 로컬 ZIP SHA-256: `d7ff6d4e2535103a89c3f9c826196dee132557dcd927447129736a9771c093a8`.
- ZIP: 28개 엔트리, 압축 해제 없이 무결성 검사 통과. ZIP 내 `LOCAL_NATIVE_VERIFICATION_RESULT.md`와 외부 Markdown 사본 바이트 일치. `evidence-manifest.json`에서 참조하는 11개 `evidence/*.json`의 SHA-256 모두 일치.
- **원본 ZIP과 원본 로그는 Git에 편입하지 않았다.** 해시가 인계 증거의 식별자이며 문서에는 사용자 로컬 전체 경로, 토큰, 원본 프로세스 환경값을 중복 보관하지 않는다.

## 원본 검증 결과 그대로 수용

| 단계/계약 | 실제 관측 | 판정 |
| --- | --- | --- |
| L0 | Windows Native와 독립 Clone/Runtime 확인, 원본 main 불변 | PASS |
| L1A | 제한 토큰 **객체 생성** 성공, 실제 제한 토큰 프로세스 시작 **미실행**. Job Object 직접 자식 종료 성공 | PARTIAL |
| I03 동일 SID 대조군 | 동일 SID FullControl DACL의 Owner 직접/사전 하드링크 쓰기 **모두 성공**, Owner hash 두 번 변경 | **FAIL (해당 대조군)** |
| L1B | 독립 CODEX_HOME에서 실제 App Server `initialize` 및 `account/read` 성공. 비로그인, 실제 모델 Turn/Tool 없음 | PARTIAL |
| L2–L4 | 별도 OS 보호 주체·인증이 없어 실제 Native Tool 상속, Snapshot, Fence, 재연결 시험 미실행 | DEFER |
| L5 | macOS Native 미실행 | DEFER |
| L6 | 결과·증거 번들 작성; 이번 MCP에서 **수신 및 해시 검증 완료**. 제품 수용은 미진행 | 증거 인계 PASS / 제품 수용 미완료 |
| Kernel | 별도 시험 Run `blocked / external-dependency`, `action.type=done` 관측되지 않음 | HOLD_SAFE |
| G0/G1/G5/G6 | G0 PARTIAL, G1 DEFER, G5 PARTIAL, G6 NOT_RUN | **제품 자동 합류 미승인** |

**검증 범위에 관한 주의:** Job 직접 자식 종료는 손자/분리 후손 종료를 증명하지 않는다. `initialize`는 Tool 실행·권한 상속 증거가 아니다. 동일 SID 대조군 실패는 별도 SID/Restricted Token 후보 실패를 뜻하지 않는다. 제한 토큰 생성 성공도 실제 파일 쓰기 차단 성공을 뜻하지 않는다. 전체 DACL/Token/환경의 원본 로그는 ZIP에 보존한다.

## 다음 수용 조건

1. Windows에서 사용자 승인을 받은 **실제 별도 SID 또는 제한된 보안 주체**로 시험 프로세스를 시작하고, Owner DACL과 별칭/하드링크/동일 UID(Windows에서는 동일 SID) 외부 Writer의 접근을 다시 시험한다. 사용자 실계정/운영 권한은 변경하지 않는다.
2. 독립 CODEX_HOME에 대한 정식 테스트 인증 없이는 Native Tool L2 검증에 착수하지 않는다. 사용자 인증 파일을 복제하거나 사용자 세션을 종료하지 않는다.
3. L1A의 **실제 프로세스 파일 보호**와 L1B의 **실제 Native Tool**이 준비된 경우에만 L2→L3→L4 실행. 공유 inode/열린 Handle/후손 권한 상속·snapshot 일관성·후기 쓰기/중복 실행을 명시적으로 검증한다.
4. 안전 Gate가 통과하기 전에는 `writerExitVerified:false`, `deliveryAuthorized:false` 및 Native 자동 합류/예약 자동 해제 차단을 유지한다. DB·Queue·Scheduler·Provider별 폴백은 추가하지 않는다.
5. 실제 증거가 확보되면 기존 `VERIFICATION.md`의 I01~I12/T25/T26 및 G0~G6에 맞춰 **최소 Host 접합 구현 여부**를 판정한다. 작업 절차용 새 영속적 권위는 만들지 않는다.

## 자료 식별과 상태

- 원본 로컬 결과: `LOCAL_NATIVE_VERIFICATION_RESULT.md`, 원본 Zip: `LOCAL_NATIVE_VERIFICATION_HANDOFF.zip`.
- ZIP 내부 검토: `L1_WINDOWS_OS_BOUNDARY.md`, `L1_NATIVE_CODEX_CAPABILITY.md`, `KERNEL_LOCAL_CLOSEOUT.md`, `evidence-manifest.json` 및 원본 결과 파일.
- 원본 증거는 로컬에 보존. 이 문서는 재현 환경·시험 판정·원본 해시를 전달하는 **비밀 제외 MCP 인계 기록**이며 실제 실행 원본을 완전히 복제했다고 주장하지 않는다.
- 기존 계획: [로컬 L0~L6 실행계획](LOCAL_NATIVE_VERIFICATION_EXECUTION_PLAN_2026-11-05.md) · [T50 결정](T50_NATIVE_OS_ISOLATION_FEASIBILITY_AND_FINAL_DECISION_2026-11-05.md).

**최종 판정: `HOLD_SAFE`.** 파일 전달 문제는 해결됐다. Native OS 권한 격리 미증명 상태는 별개로 유지한다.
