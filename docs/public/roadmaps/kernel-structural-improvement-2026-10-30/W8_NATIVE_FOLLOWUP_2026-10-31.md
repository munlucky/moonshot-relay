# W8 native Host 후속 검증 — 2026-10-31

**판정: macOS 동일 소스 Codex 관련 격리 검증 PASS, 전체 native/계정 설치 검증은 PARTIAL.** W10 Linux 완전 회귀 결과를 약화시키지 않는다. 운영 계정·Codex 세션·기존 소스 체크아웃은 변경하지 않았다.

## 실행 환경과 소스 일치

- 통합 canonical HEAD: `edbefb267f0e70df067f75e1f717660f67f9082e` (`main`, W10 Linux Reliability 282/282 PASS 기준).
- Moonremote Mac Linux workmachine은 별도 저장소로 `bde95dab464461e6c810af0c8458bdd9b78011d0`에 머물러 있었다. 이 상태를 최신 canonical과 혼동하거나 원본 작업 트리를 강제 동기화하지 않았다.
- **실제 native Host:** macOS 26.5.2 / Darwin 25.5.0 / arm64, Node 24.6.0, Codex CLI 0.162.1. Mac 원본 `/Users/dev/moonshot-relay`는 `bde95dab`이고 clean이다.
- `/tmp/moonshot-w8-mac-native.2oOiMO/repo`에 원본 Mac repo를 별도로 clone한 다음 GitHub `main`을 fetch하여 정확히 `edbefb26`을 detached checkout했다. Mac의 기존 native `node_modules` 108MB를 **이 격리 사본에 복사**했다. 새 버전에서 `npm ci`로 lockfile부터 재설치한 검증은 아니므로 의존성 출처 조건을 명시한다.

## 실제 Mac ARM64 검증

- 정확한 `edbefb26`에서 Runtime build **308 files, 841 edges**, TypeScript 7.0.2 `--noEmit`, boundaries **9 modules/308 files/841 edges**, `build:check` **308 files/changed 0/removed 0** 모두 PASS.
- 격리 Runtime/Home/Config에서 native managed installation, Session Binding, Runtime Home Isolation, Review Host Bridge 및 cross-process Review Claim: **62/62 PASS** (`/tmp/moonshot-w8-mac-exact.f80v5m/exact-native.tap`). 작업에 사용하는 Codex CLI `--version` 정상.
- Native surface resolver 검사는 **1/1 PASS**. 별도 전체 native CLI Smoke는 **6개 중 3 PASS/3 FAIL**. Qwen 및 ADE의 `--version`이 각각 10초 제한에서 `ETIMEDOUT`; 두 개의 하위 실패 및 상위 실패다. Codex/Claude CLI 버전 검사는 통과했다. Qwen/ADE는 resolver에서 `not_required`로 표시된 표면이나, 전체 CLI Smoke는 여전히 설치 감지된 이 명령의 오류를 FAIL로 기록한다. 선택적 Provider 문제를 Codex의 실제 Review Receipt 실패로 둔갑시키지 않고, 전체 Smoke PASS도 주장하지 않는다.

## 계정 설치 상태 (읽기 전용)

- macOS 계정 `~/.codex/.moon-relay-kernel-profile-manifest.json`: **2026-10-13** 설치, 관리 파일 22개. 설치된 전체 파일 SHA-256 비교에서 19개 MATCH, `AGENTS.md`/`config.toml`/`hooks.json` 3개 DRIFT. 이 3개는 `managed-section`/`json-paths` 소유이므로 파일 전체 SHA만으로 관리 섹션 손상을 단정하지 않는다.
- macOS `~/.moon-relay-kernel/.moon-relay/install-manifest.json`: **2026-10-29** 설치, 소유 파일 **1,143개** 기록. 설치 소스 경로는 `/Users/dev/moonshot-relay`이며 현재 checkout HEAD가 `bde95dab`으로 canonical과 다르다.
- 정확한 `edbefb26`의 격리 산출물과 계정 설치 산출물 직접 해시 비교: `scripts/kernel/persistence/knowledge-lifecycle-store.js` **DIFF**, `scripts/kernel/control-plane.js` **DIFF**, `scripts/kernel/git/closeout.js` MATCH. 따라서 **현재 Mac 계정의 완전한 canonical source/payload parity는 성립하지 않는다.** 미확인 나머지 1,140여 파일은 MATCH라고 주장하지 않는다.
- 실제 Codex 앱/CLI 관련 프로세스가 동작 중이었다. 운영 profile/config/runtime 설치·재시작은 사용자 작업에 영향을 줄 수 있어 시행하지 않았다. 별도 account backup/merge/rollback 및 native 설치 후 Receipt 확인 전 PASS로 처리하지 않는다.

## 다른 환경과 최종 판정

- Windows native: 기존 Moonremote Linux WSL2/9p에서 `powershell.exe`/`cmd.exe` 또는 Windows 계정 경로가 제공되지 않았다. **NOT_TESTED**. macOS 성공으로 Windows를 대체하지 않는다.
- Linux W10 Reliability 282/282, Unification 13/13, Recovery 24/24, Lifecycle 66/66 등의 source PASS는 그대로 유지한다.
- 남은 필수 검증: (1) 실제 Windows native 지원 경계·계정 설치/재시작, (2) Mac 계정 managed-section 소유 경계를 보호한 **최신 canonical 설치 및 SHA parity/재시작**, (3) 필요 시 선택적 Qwen/ADE 버전 검사 환경 조사. Qwen/ADE의 실패 때문에 Codex 구현에 특별 규칙·Provider 하드코딩·새 fallback을 추가하지 않는다.

**통합 최종 판정은 PARTIAL 유지.** 읽기 전용 Mac 소스 검증을 마쳤지만 계정 설치 검증과 Windows native 검증이 빠졌으므로 `COMPLETE`는 불가하다.

## 2026-10-31 후속 — 운영 설치본의 별도 Identity 코드와 canonical 수렴

- Mac 계정 설치 Manifest 1,143개 소유 파일 전체 해시 검사 결과 **1,142 MATCH / 1 modified**. 변경은 `kernel-payload/scripts/kernel/control-plane.js`이며 기존 설치(2026-10-29) 이후 추가된 `exactRootIdentity` 별칭 충돌 처리 12줄이다. 이력만 보고 임의로 `--sync` 덮어쓰기 하지 않았다.
- 동일 remote URL을 가진 물리적으로 독립된 저장소 A/B에서 **A의 기존 정확한 root Identity가 이미 저장된 상태**로 A에 remote가 추가되면 기존 canonical control-plane은 `project_identity_alias_conflict`로 재시작을 중단함을 격리 재현했다. B의 remote alias는 B 소유로 남아 있었다.
- 소유권 정책은 state-store의 `registerProjectIdentity`에서 유지하고, control-plane의 **이미 저장된 정확한 root에만** 원격 alias 등록을 필터링하도록 정리했다. 정확한 root는 `getProjectIdentity({ canonicalRoot })` 조회로 입증하며, shared remote URL만 같은 신규 저장소는 기존대로 차단한다. 다른 namespace/Run/Knowledge의 병합은 없다.
- 별도 hash authority·특정 프로젝트 경로·일시적 우회 허용·DB schema/fallback 없음. TypeScript 7 타입 검사 및 Runtime/Test 빌드 통과. 신규 exact-root/새 root 반례 1/1, 전체 Project Identity·Runtime Ownership·Report Identity Migration **63/63 PASS**.
- 해당 수정이 포함된 canonical 코드 커밋 후에만 Mac **격리된 최신 소스**와 계정 설치본 사이의 승인된 동기화를 검토한다. 계정 설치와 Windows native 여부는 별도 증거 없이는 PASS로 승격하지 않는다.
