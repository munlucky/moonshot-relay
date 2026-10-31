# W8 Host·설치·Session·Project Identity 검증

- 기준 HEAD: `1efb350f`. **Linux SOURCE PASS(해당 범위) / Windows·macOS native 및 실제 사용자 계정 INSTALL NOT VERIFIED**.
- 실제 실행 OS: Linux WSL2, `/shared` Windows 드라이브의 9p 공유 mount. Linux native 검증 결과는 Windows/macOS native 실행 결과가 아니다.
- 기존 Host/Session/runtime-home/Identity/installer/cross-surface 집중 테스트 최초 실행: 총 71건, **65 PASS / 2 FAIL / 4 SKIP**. 두 실패 모두 `runtime_build_stale`로 생성 Runtime이 현재 canonical 소스와 일치하지 않아 Installer가 정상 거부한 사례다.
- 별도 Linux overlay의 동일 HEAD에서 Runtime + 테스트를 재생성한 다음 관리 Runtime 설치 테스트를 실행하자, symlink로 외부 `node_modules`를 공유하는 격리 방식이 `Runtime dependency escapes source root`로 거부됐다. 안전한 차단 동작이며 제품 결함이 아니다.
- 격리 사본에 `npm ci --include=dev --include=optional --ignore-scripts`로 Linux 의존성을 실제 설치한 후 관리 Runtime 테스트 **9/9 PASS**. 기존 계정 설치·설정·실행 프로세스를 변경하지 않았다.
- Run/Session identity는 W1의 영속 SQLite 검증을 재사용하고, 승인 후 Identity 소비는 W3-B 53/53 결과를 재사용한다. Session Binding을 새로운 Work 선택 권위로 변경하지 않는다.
- W4 Windows 전용 Proof timeout SKIP과 W8의 native 플랫폼 SKIP은 해당 표면에서 PASS한 것으로 취급하지 않는다. Windows native 계정 install source/payload digest, macOS native 실제 Codex/Reviewer, Host 교체·재시작·계정 설치 동기화는 **NOT_TESTED / environment_blocked**.
- 설치 자체가 필요한 경우 사용자 소유 파일·진행 중 작업을 확인하고 별도 지원 경계에서 수행한다. 운영 namespace merge/adopt 승인은 W8 검증만으로 대체하지 않는다.

**W8 판정: Linux SOURCE PASS, native Host/계정 설치는 PARTIAL/environment_blocked.** 새 제품 폴백·프로세스 권위·Identity 정책을 추가하지 않았다.

## 2026-10-31 native macOS follow-up

실제 macOS ARM64에 canonical `edbefb26`을 별도 checkout하여 Codex 관련 native 테스트 **62/62 PASS**, TypeScript7/Boundaries/BuildCheck PASS를 검증했다. Mac 계정 설치 소스는 이전 버전이고 실제 생성 파일 2개의 SHA가 달라 설치 parity는 실패한다. 선택적 Qwen/ADE CLI Smoke도 timeout으로 전체 PASS가 아니다. 자세한 증거와 소유권 보호 판단: `W8_NATIVE_FOLLOWUP_2026-10-31.md`. 최종 판정은 **source verified / native account PARTIAL**을 유지한다.

## 현지 수정 회수 및 후속 재현

Mac의 관리 Runtime에 별도 수정된 Identity alias 충돌 코드가 존재함을 확인했고, 정확한 기존 root의 재시작 중단 반례를 canonical에서 재현했다. `control-plane.ts`는 정확한 root를 저장 권위에서 확인한 경우에만 타 저장소 소유 remote alias 재등록을 생략한다. 신규 root의 소유권 검증·상태스토어 엄격한 경계는 변경하지 않는다. TypeScript7/빌드 및 63/63 Identity 회귀 PASS. 상세 내용 `W8_NATIVE_FOLLOWUP_2026-10-31.md`.

## Mac 계정 적용 완료

canonical `e047f182` Mac native TypeScript7/BuildCheck 및 focused 69/69 PASS 후 운영 Mac 계정 Kernel Runtime을 공식 설치 백업과 함께 동기화했다. 설치 Manifest **1,143/1,143 SHA MATCH**, Codex 프로필 관리 **22개, doctor `ready`**, 사용자 전용 skill 보존 및 별도 rollback 예행연습 PASS. 강제 세션 재시작 없이 새 Kernel CLI 실행만 확인. Windows native 및 활성 Codex 세션 E2E는 검증 불가로 남는다. `W8_NATIVE_FOLLOWUP_2026-10-31.md` 참조.
