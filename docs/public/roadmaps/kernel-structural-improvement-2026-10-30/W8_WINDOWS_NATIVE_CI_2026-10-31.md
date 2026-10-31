# W8 Windows native CI 최종 검증 — 2026-10-31

## 판정

**Windows native SOURCE·격리 설치·Reviewer/Session 집중 검증 PASS** (`windows-2022`, Node 22); 원래 Windows 사용자 계정의 실행 중 Codex 세션 종료·재개 E2E는 실행하지 않았다. 실제 Windows 사용자 계정은 변경하지 않았다.

- 최종 GitHub Actions 수동 실행: [41158554174](https://github.com/munlucky/moonshot-relay/actions/runs/41158554174), 커밋 `f229678024a4a51cb538a65a73953c839e3a6cab`, 전체 `conclusion=success`.
- `npm ci`, TypeScript7 `typecheck`, `check:boundaries`, `build`, `build:tests`, `build:check` 모두 PASS.
- Project Identity·Managed Runtime·Session Binding·Review Host Bridge·Cross-process Reviewer **103개 중 102 PASS / 0 FAIL / 1 SKIP**. SKIP은 Windows에서 지원하지 않는 POSIX 경로의 의미 있는 trailing whitespace 테스트다. Windows 전용 검증 결과를 해당 SKIP으로 약화시키지 않는다.
- Windows 실제 `RUNNER_TEMP`에만 Kernel 공식 설치 `--track-home`과 Codex 계정 프로필 `--account-root` 설치: **Kernel 설치 1,145 managed files, Profile 28 managed files**, `profile-doctor status=ready/effective=kernel`, command shim/MCP launcher 생성, `kernel.cmd --version --json`에서 `moon-relay-kernel v0.1.0` 응답 PASS. 설치 시 관리 Node `runtimeSource`를 지정하지 않았으므로, 관리 `runtime/current/node.exe`가 생성됐다고 주장하지 않는다.
- CI 종료 후 기존 GitHub Actions 저장소 설정 `enabled=false`, `allowed_actions=null` 복원. 최초 CI 워크플로는 일회성 검증 목적이며 **최종 소스에서 삭제**한다.

## 실패→원인→개선의 실제 증거

| 실행 | 범위·결과 | 확인된 원인과 판단 |
|---|---|---|
| [41155955931](https://github.com/munlucky/moonshot-relay/actions/runs/41155955931) | `windows-latest` 의존성 설치 FAIL | Visual Studio 2026(18.x)을 `node-gyp@11.5`가 인식하지 못함. 제품 코드 결함으로 오인하지 않고 일회성 CI에 `windows-2022` 사용. |
| [41156252467](https://github.com/munlucky/moonshot-relay/actions/runs/41156252467) | 103개 100 PASS/3 FAIL | POSIX-only 경로 fixture, Windows에서 부적합한 `..` 경로 fixture, Git linked-worktree 실제 short/long 경로 분리 발견. |
| [41156955200](https://github.com/munlucky/moonshot-relay/actions/runs/41156955200) | 준비 과정 TS2339 FAIL | 임시 테스트 진단에 존재하지 않는 property를 넣은 실수. TS7 타입 검증 후 제거. |
| [41157292647](https://github.com/munlucky/moonshot-relay/actions/runs/41157292647) | 103개 101 PASS/1 FAIL/1 SKIP | 같은 Git common-dir가 `RUNNER~1` vs `runneradmin`으로 비교되는 실제 Windows ownership 연속성 오류. 임시 설치는 `--track-home`을 지정하지 않아 shim 미생성. |
| [41157988990](https://github.com/munlucky/moonshot-relay/actions/runs/41157988990) | 103개 102 PASS/0 FAIL/1 SKIP; 프로필 Doctor ready·CLI PASS, 전체 CI FAIL | `fs.realpathSync.native`로 Git common-dir 일관화. 마지막 단계가 설치 요청에 포함되지 않은 managed Node 파일 존재를 가정한 테스트 오류. |
| [41158554174](https://github.com/munlucky/moonshot-relay/actions/runs/41158554174) | **모든 필수 단계 SUCCESS** | 실제 Windows native Test/Installer/Doctor/CLI 통과. |

수정된 영속 제품 경계는 `src/kernel/project-identity.ts`와 `src/host/kernel/workspace/stable-workspace.ts`의 Git common-dir 파일 시스템 `realpathSync.native` 정규화다. 기존 소유권·Approval/Run/Knowledge 분리 규칙은 그대로다. Windows 계정 이름·드라이브·저장소 이름을 특수 처리하지 않았고 별도 fallback, DB authority, 상시 프롬프트 규칙을 추가하지 않았다.

Windows 설치 계정의 정적 증거는 별개인 `W8_WINDOWS_READONLY_2026-10-31.md`를 따른다: 기존 계정 Runtime Manifest **1,147/1,147 SHA**, 소스↔Payload **1,144/1,144 동일**, Codex Profile 소유권 **5/5 PASS**. GH-hosted 임시 Runtime 1,145개 설치는 **사용자 PC의 기존 Runtime 재설치**를 의미하지 않는다.

## 나머지 검증 경계

- 기존 Windows 사용자 Codex 세션의 강제 재시작·실제 in-flight Run 복구는 검사하지 않았다. 이 표면의 비파괴 E2E가 필수이면 독립 시험 세션으로 별도 검증해야 한다.
- macOS ARM64 집중 회귀, 실제 계정 Kernel 및 Profile 검증은 기존 `W8_NATIVE_FOLLOWUP_2026-10-31.md` 결과로 보존한다. GitHub Windows runner의 성공을 사용자 Mac/Windows 세션 복구 성공으로 확대하지 않는다.
- **W8 Windows native 개발/격리 설치 검증은 PASS**, 기존 사용자 계정의 진행 중 세션 복구는 미검증이므로 **통합 W0~W10 최종 판정은 PARTIAL**이다. 다른 Wave의 source PASS·keep-baseline 결과를 소급 무효화하지 않는다.
