# W8 Windows 설치 파일 읽기 전용 검증 — 2026-10-31

**판정: Windows 계정 설치 Manifest 및 소스 Payload 정적 검증 PASS. Windows native 실행·Reviewer·Session 복구 E2E는 NOT_TESTED. 전체 통합 PARTIAL 유지.**

## 실제 경로·버전

- 조회 환경: Moonremote Linux WSL2 (`6.18.54.1-microsoft-standard-WSL2`)의 `/c` 매핑에서 **읽기 전용** 검사. 실제 Windows native PowerShell/cmd를 실행한 것이 아니다.
- Windows 사용자의 소스: `C:\dev\moonshot-relay`, `main`, HEAD=`dbc63831a40ba0fc1eb08fd0b873544ddb4cd4de`, Git clean. 이 커밋에는 canonical Identity hotfix `e047f182`와 W8 Mac 후속 문서가 포함돼 있다.
- Windows Codex 프로필 Manifest: `C:\Users\moon\.codex\.moon-relay-kernel-profile-manifest.json`, 설치 시점 `2026-10-28T11:41:26.942Z`, account-root-direct, 관리 엔트리 5개.
- Windows Kernel Runtime Manifest: `C:\Users\moon\.moon-relay-kernel\.moon-relay\install-manifest.json`, 설치 시점 `2026-10-28T22:21:13.332Z`, 관리 엔트리 1,147개.

## 확인한 증거

1. Manifest의 모든 상대 경로가 안전한 경로인지 확인한 뒤 설치 파일 1,147개를 SHA-256으로 검사: **1,147 MATCH / 0 modified / 0 missing / 0 unsafe**.
2. 설치 Payload를 Windows 소스 체크아웃의 동일 상대 경로 파일과 해시 비교: **1,144/1,144 일치**. 나머지 2개는 source checkout 밖의 installer 생성물 `kernel-payload/runtime/current/node.exe`와 `kernel-payload/runtime/current/runtime-manifest.json`이다. 이 2개도 1번 Manifest 해시 검사에 포함된다. `track.yaml` 1개는 Payload 밖이다.
3. 읽기 전용 Linux 측 Kernel `inspectProfile('/c/Users/moon/.codex')`: **`status: ready`, 관리 파일 검사 5/5 PASS**. `AGENTS.md`와 `config.toml`은 `managed-section`, `hooks.json`은 `json-paths` 소유권을 확인한다. **이 검사를 Windows native profile-doctor PASS로 해석하지 않는다.**
4. Windows 계정 `bin/kernel.cmd`와 `bin/moon-relay-kernel-mcp.cmd` 존재. Runtime 내부 `kernel-payload/runtime/current/node.exe` 존재(약 89 MB). `kernel.cmd`는 Windows PATH의 Node를, MCP shim은 관리 Runtime Node를 참조하는 내용이다. 정적 존재 확인만 수행했으며 실제 시작 성공은 미확인.
5. 이 Moonremote 컨테이너에는 `powershell.exe`, `pwsh`, `cmd.exe`, `/c/Windows/System32`와 WSLInterop가 없다. Windows `node.exe --version`의 직접 실행은 **exit 1, `WSL ... UtilBindVsockAnyPort ... socket failed 1`**. Windows native 실행 결과를 얻지 못했다.
6. GitHub workflow `.github/workflows/ci.yml`은 `workflow_dispatch`와 `windows-latest`의 Node 20/22/24 matrix를 이미 보유한다. GitHub Actions repository permission API 결과는 **`enabled: false`**. workflow 정의의 `state: active`와 저장소 실행 권한은 별개다. 실행 권한을 임의 변경하거나 실패를 PASS로 처리하지 않았다.

## 실제 Windows native 실행이 가능해졌을 때의 최소 검증

Windows PowerShell에서 현재 사용자 계정/정상 checkout에 대해 다음을 순서대로 확인한다. 설정 및 사용자 Runtime을 임의로 덮어쓰지 않으며, 기존 활성 Codex 프로세스는 강제 종료하지 않는다.

```powershell
Set-Location C:\dev\moonshot-relay
git status --short
git rev-parse HEAD
& "$env:USERPROFILE\.moon-relay-kernel\.moon-relay\kernel-payload\runtime\current\node.exe" --version
& "$env:USERPROFILE\.moon-relay-kernel\bin\kernel.cmd" --version --json
node bin/moon-relay-kernel.mjs profile-doctor --target-root "$env:USERPROFILE\.codex" --runtime codex --runtime-home "$env:USERPROFILE\.moon-relay-kernel"
node --test --test-concurrency=1 tests/kernel-project-identity.test.mjs tests/kernel-managed-runtime.test.mjs tests/kernel-session-binding.test.mjs tests/kernel-review-host-bridge.test.mjs tests/kernel-review-cross-process.test.mjs
```

Windows native CLI 실행과 managed runtime node/Reviewer 테스트 통과 증거가 확보되면 W8의 Windows Host 부분을 재판정한다. **이미 실행 중인 Codex 세션의 실제 Host restart/recovery**가 필수인 경우에도 새 임시 세션·독립 Runtime을 우선 사용하고, 사용자 작업을 중단하지 않는다. 선택적 Qwen/ADE CLI는 필수 Codex 판정과 분리한다.

## 결론

Windows 설치 상태가 손상됐다는 증거는 없다. 현재 canonical 소스와 관리 Payload의 정적 동일성이 확인됐으므로 **계정 설치를 다시 실행할 필요가 있다는 근거도 없다**. 부족한 것은 Windows **native 실행 권한/실행기**다. 새 Provider 예외, Windows 전용 fallback, 중복 실행 권위, 자동 승인 절차는 추가하지 않는다. Windows native 테스트 전까지 통합 `COMPLETE`를 선언하지 않는다.
