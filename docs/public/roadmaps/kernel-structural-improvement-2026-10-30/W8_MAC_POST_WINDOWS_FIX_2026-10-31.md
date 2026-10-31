# W8 macOS 최신 Windows Identity 수정 반영 및 비파괴 복구 검증 — 2026-10-31

## 범위 및 판정

**macOS native canonical source·계정 설치 Runtime·관리 프로필 PASS. 독립된 임시 Run/Session/Reviewer 복구 검증 PASS. 실제 사용 중 Codex 세션을 강제 종료한 뒤 재접속하는 E2E는 미실행이므로 해당 운영 관측은 DEFER, 통합 상태는 PARTIAL 유지.**

- 정확한 대상: GitHub `main`, `685c75349280bd9acfe8dc06a0372f7455b511f6`. macOS Darwin arm64 native host, 원본 `/Users/dev/moonshot-relay` HEAD 동일·작업 트리 clean. 사용자 작업과 무관한 새 Worktree를 강제로 바꾸지 않았다.
- Windows native에서 발견·수정한 Git 공통 디렉터리 8.3 short/long 경로 처리(`src/kernel/project-identity.ts`, `src/host/kernel/workspace/stable-workspace.ts`)를 반영했다. Mac에서 생성 Runtime 308개·841 edges, `build:check` changed 0/removed 0 PASS.
- 계정의 **설치 이전** Runtime Manifest 1,143개 SHA **1,143/1,143 일치**, 손상/사용자 수정 없음. 그러나 최신 소스와 설치본의 `project-identity.js` 및 `stable-workspace.js` 두 파일의 SHA는 달랐다. 기존 계정 설치 상태와 최신 소스 차이를 구분했다.
- 같은 macOS HEAD에서 `kernel-project-identity`, `kernel-managed-runtime`, `kernel-session-binding` **65/65 PASS**. 분리된 `HOME`/Kernel Runtime/`TMPDIR`에서 실행해 운영 DB와 사용자 세션을 건드리지 않았다.

## Mac 계정 공식 재설치와 무결성

- 원본 소스의 git clean 및 정확한 HEAD를 확인한 다음 공식 `node bin/moon-relay-kernel.mjs install --target-root ~/.moon-relay-kernel --source-root <canonical> --sync` 실행. 성공 `status=installed`, 관리 파일 1,143개.
- 설치기가 생성한 복원용 백업: `~/.moon-relay-kernel/.moon-relay/backups/backup-1793422312923`.
- **설치 후 Manifest 1,143/1,143 SHA 일치**, 두 경로 정규화 산출물의 소스 SHA와 설치 SHA가 각각 일치. Kernel 실행 `--version --json` PASS, `moon-relay-kernel v0.1.0`.
- 실제 계정 `profile-doctor`는 `status=ready`, `effective=kernel`, `managedFileCount=22`, 성공. 프로필 재설치와 사용자용 AGENTS/config/hooks 강제 변경은 이번 후속 단계에서 불필요하므로 수행하지 않았다.
- 실제 Codex `app-server` 프로세스는 유지했다. 운영 SQLite/Knowledge를 삭제·병합하거나 동작 중 Codex 세션을 강제 재시작하지 않았다.

## 독립 복구 검증

실제 macOS 원본 checkout HEAD에서 새 임시 `HOME`/Runtime/`TMPDIR`를 사용해 `kernel-agent-recovery`, `kernel-owner-mutation-recovery`, `kernel-review-claim-recovery`, `kernel-review-cross-process`, `kernel-recovery-continuity`, `kernel-session-run-lifecycle` **32/32 PASS (fail 0, skip 0)**. Run 수명주기, Review Claim 재획득, 독립 프로세스 경쟁, 소유권 복구를 확인했다. 해당 테스트 성공은 **사용자가 진행 중인 실제 Codex 세션의 강제 재시작 후 복구 성공을 증명하지 않는다.**

## 통합 해석

- Linux 전체 Reliability 282/282와 Windows Server 2022/Node22 native 102 PASS/0 FAIL/1 POSIX-only SKIP 및 Windows 격리 설치/Doctor/CLI 성공을 보존한다.
- Windows 사용자 소스 `C:\dev\moonshot-relay`도 HEAD `685c7534`·clean으로 관찰했다. Windows 사용자 계정의 실제 설치 Manifest는 2026-10-28 기록으로, native 사용자 세션 실행·재시작을 직접 검증하지 않았다. GitHub-hosted runner 성공과 구분한다.
- **W0~W10 구조 개선·Linux/Windows/macOS 격리 소스 검증과 Mac 계정 최신 동기화 완료**. 비파괴 원칙을 유지하기 위해 사용자 진행 중 세션 강제 재시작과 Windows 사용자 계정 native 실행 검증은 미이행으로 기록한다. 별도 운영 실측 필수 기준이 해결되기 전까지 전체 `PARTIAL`을 `COMPLETE`로 허위 승격하지 않는다.
