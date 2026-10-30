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
