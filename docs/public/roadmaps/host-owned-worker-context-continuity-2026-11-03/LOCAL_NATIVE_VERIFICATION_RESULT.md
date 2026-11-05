# Windows 로컬 Native 검증 결과

판정은 **HOLD_SAFE**다. 기준은 main `b3239072`, Windows 10 build 19045, Codex App Server `0.166.0-alpha.6`이다. 독립 시험 계정과 시험용 Codex 홈만 사용했다. 모델과 effort는 고정하지 않았다.

| 단계 | 판정 | 관측 |
| --- | --- | --- |
| L0 | PASS | 별도 Windows 표준 계정과 시험 파일, 실제 App Server, Job Object를 확인했다. |
| L1A/L1B | PASS | 시험 SID의 Worker 쓰기 성공, Owner 직접·하드링크·junction 쓰기 거부, 독립 인증 및 실제 모델 Tool 실행을 확인했다. |
| L2 | PARTIAL | 확인한 실제 Tool·자식·분리 Writer에서 보호 경로 쓰기 12건을 차단했다. 제품의 격리 권위는 미검증이다. |
| L3 | PARTIAL | Host 강제 종료 후 관측 프로세스 전부 종료, 보호 해시 유지. NTFS 단일 파일 수확과 일반 Proof/CAS 양·음성 시험 통과. 보호된 Windows Proof는 미수용이다. |
| L4 | PARTIAL | 같은 Run·Step에서 이전 예약 거부, 수동 Attempt 정리 후 새 Worktree에서 실제 후속 모델 Tool 성공. 제품 자동 재개는 기존 Attempt 차단을 확인했다. |
| L5 | DEFER | macOS 별도 권한 검증은 보류했다. |

- I01/I04/I06~I12와 T25/T26에 관련된 관측은 이전 Attempt 보존, 동일 Worktree 재예약 거부, Host 종료 후 프로세스 핸들 확인, 새 Worktree 실행, Owner revision 유지다. 해당 항목의 전체 수용은 보류한다. G0/G1/G5는 부분 증거다. G2~G4/G6는 수용 보류다.
- 같은 SID의 Windows unelevated Proof는 기존 하드링크를 통해 Owner를 변경했다. 별도 AppContainer에서 초기 Node 시작 실패의 원인을 드라이브 루트 조회의 EPERM으로 확인했다. 시험 진입점에 --preserve-symlinks-main을 적용한 뒤 Node와 분리 Writer 모두 Proof 파일 쓰기에 성공했고 Owner 직접 경로·하드링크·junction 쓰기는 각각 EPERM이었다. Owner 해시는 유지됐다. 정지 상태에서 Job에 할당한 후 실행했고, 부모 종료 뒤 살아 있던 Writer 핸들은 마지막 Job 핸들을 닫자 5초 제한 안에 신호 상태로 바뀌었다. 시험 프로필 삭제 결과는 0이다. 임의 Proof 명령 및 제품 CAS 경로는 검증 범위에 포함되지 않는다.
- 원본 증거는 로컬에 보관했다. 별도 SID 시험은 Public 시험 폴더의 lifecycle-attempt-v4/lifecycle-summary.json이다. Job Object·NTFS·동일 Run 증거는 Windows TEMP의 moonrelay-native-app-job-b89a1b29, moonrelay-native-snapshot-f7b7129f, moonrelay-native-run-resume-241331b7에 있다. 관측 프로세스는 종료했고 시험 계정과 시험 파일은 보존했다.
- 추가 운영 서비스나 관리자 작업은 적용하지 않았다. 새 보안 주체가 필요한 제품 설계와 자동 시작은 보류한다. MCP는 Native 격리와 독립적인 기존 Kernel 통합·회귀를 이어갈 수 있다. Windows guarded Proof 및 종료 근거를 제품 경로에서 검증한 뒤 W3~W6를 수용한다.

상세 실행 및 반례는 [Windows Native 후속 검증](WINDOWS_NATIVE_HOST_EXECUTOR_FOLLOWUP_2026-11-05.md)에 기록했다.

표준 npm 명령은 임시 드라이브 매핑을 적용한 AppContainer에서 종료 코드 0을 반환했다. npm이 시작한 Node와 분리 자식의 보호 경로 쓰기 6건은 거부됐다. 기존 하드링크를 포함한 폴더에 상속 ACL을 재적용한 별도 대조는 Owner 권한과 내용을 변경했다. Git for Windows는 같은 AppContainer에서 종료 코드 128을 반환했다. 상세 결과에 두 반례를 기록했다.

시험 전용 로더로 연결한 실제 guarded Dispatcher는 AppContainer와 Job Object에서 npm Proof를 실행했다. 정상 Proof는 Owner CAS 1회와 Report 2건, 실패 Proof는 CAS와 Report 0건을 기록했다. 별도 시험에서 CAS 이후 Report 검증이 Owner 저장소 밖의 파일을 변경했지만 Dispatcher는 성공했다. 제품 경로에서는 시작 차단을 유지한다.

후속 수정으로 guarded Report 검증이 통합 Worktree에서 실행된다. Windows 시험 전용 보호 실행기로 이전 CAS 이후 외부 쓰기 반례를 재실행했고, 외부 파일은 유지됐다. 정상 사례는 CAS 1회와 Report 2건, 실패 사례는 CAS와 Report 0건이었다. 제품 Windows 보호 실행기와 Writer 종료 증거의 제품 연결은 남아 있다.

감독 프로세스가 Host 종료 후 실제 App Server·모델 Tool Job의 활성 프로세스 10 → 0을 확인했다. 시험 제어기의 명시적 정리 뒤 두 독립 Host 중 하나만 기존 Kernel Step을 선점했고, 실제 후속 모델 Tool은 새 Worktree에서 한 번 실행됐다. 같은 SID 모델 Tool이 감독 디렉터리의 사전 하드링크를 통해 외부 시험 파일을 변경했으므로, 이 파일 기반 기록은 제품의 종료 권위로 수용하지 않았다.
