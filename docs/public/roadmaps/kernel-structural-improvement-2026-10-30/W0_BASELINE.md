# W0 기준선 — Moonshot Relay Kernel 구조적 개선 v2

- 확인일: 2026-10-30
- 실행 표면: Moonremote Linux workmachine (`/shared/moonshot-relay`), `main`
- 기준 HEAD: `bde95dab464461e6c810af0c8458bdd9b78011d0`
- 작업 추적: `e72d8f88-5920-426b-8565-0edc713faa18`
- 원 계획: `moonshot-relay-kernel-structural-improvement-integrated-final-plan-2026-10-30-v2.md` §4
- **W0 판정: PARTIAL.** 기준선 확보와 기존 회귀는 통과했지만 필수 물리적 파일 쓰기·내구 차단 반례가 남아 있다. 다른 Wave나 전체 계획을 COMPLETE로 선언하지 않는다.

## 확인된 실행 사실

1. `main`과 로컬 추적 `origin/main`은 동일 SHA였다. 등록된 Git worktree는 `main` 한 개. W0 시작 시 staged/unstaged 0건, 추적된 running/unknown MCP operation 0건. 원격 fetch에 의한 최신성은 이번 확인 범위가 아니다.
2. 기존 Legacy Proof Tier 작업(`9fc5aabe-...`)의 10개 경로는 `663a050a` 커밋에 반영되어 있다. 그러나 과거 Kernel Completion Decision/fresh proof 및 Linux typecheck는 확인되지 않아 완료로 취급하지 않고 미해결 이력을 보존한 채 `abandoned`로 추적을 닫았다.
3. 계정 Runtime SQLite 운영 DB는 **read-only source connection + SQLite Online Backup API**로 전용 `/tmp` 사본을 확보했다. 외부 wall-clock 제한 85초 안에 완료(15.33초), 사본 전체 `PRAGMA integrity_check` 결과 `ok`; 원본에 checkpoint/repair/migration 실행하지 않았다.
4. W0 회귀 fixture에서는 프로젝트 루트, Runtime Home, HOME, TMPDIR, XDG 경로를 `/tmp/moonshot-w0-cases-k6N6GsRd` 아래로 격리했다. 자식 프로세스의 상대 `bin`/`scripts` 탐색은 격리 프로젝트에 원본을 가리키는 링크를 제공해 해결했다.
5. 첫 회귀는 **163개 중 148개 통과 / 15개 실패**. 실패 모두 `cwd` 상대 `bin/` 또는 `scripts/` 경로가 없는 조사 fixture 설정 오류. 이를 보완한 두 번째 실행은 **163/163 PASS**, 실패 0건. 두 실행을 혼합해 첫 실행도 PASS였다고 주장하지 않는다.
6. `src/kernel`, `src/host/kernel`, `tests`의 추적 대상 파일 목록 및 바이트 해시는 테스트 전후 동일했다. 검사 종료 후 `HEAD`도 동일. `skills/explain-diff-html/scripts/render.py`는 일시적으로 Git status에 나타났으나 현재 clean이며 CRLF 정규화 후 HEAD 바이트와 동일했다. 파일을 변경·원복하지 않았다.
7. `check:boundaries`, `build:check`는 각 60초 외부 제한에 걸려 **exit 124 (timed out)**. `typecheck`는 Linux native `@typescript/typescript-linux-x64` 부재로 **exit 1**. 세 작업 모두 PASS 아님. 단 시간 제한만으로 소스 실패라고 판단하지 않는다.
8. 다른 Moonremote Mac Linux workmachine, Windows native, macOS native 표면은 이번 실행에서 직접 검증하지 않았다.
9. W0 추가 장애 주입(동일 HEAD): 실제 격리 병렬 Delivery에서 owner fence expiry를 DB fixture에 강제로 기록해 renewal을 거부했다. **물리적 alpha/beta 파일 모두 없음, Git clean, mutationRevision=0, 재시작 후 active 유지**를 직접 확인했다(C06의 apply 전 만료 경계).
10. W0 추가 장애 주입(동일 HEAD): 실제 alpha/beta 패치가 반영된 뒤 owner mutation 기록 실패와 차단 기록 실패를 **Control Plane 호출 경계에서 모의**했다. 실패 직후 Run은 active/revision 0이었지만, 재시작 복구는 **blocked / delivery_materialization_recovery_required**로 판정했다(C08의 대표 실패 경로). 실제 SQLite I/O 오류 전체 범위 검증은 아니다.


증거 재현: `fixtures/delivery-fence-restart-probe.mjs`의 `c06`/`c08`을 각각 실행해 `W0_ISOLATED_PROBE_PASS`를 확인했다. 이 스크립트는 W0 진단 fixture이며 Kernel 제품 동작이나 필수 실행 절차를 추가하지 않는다.

11. W0 후속 장애 주입: 실제 Delivery 이후 제3자 파일 추가(`c07_external`)와 이미 적용된 두 파일 중 하나 제거(`c07_partial`)를 각각 별도 fixture로 재현했다. 모두 Run `blocked`, `mutationRevision=0`이며 제3자/잔여 바이트를 보존했다. **이는 실제 `git apply` 프로세스 중 강제 종료 반례와는 구별한다.**
12. `c08_busy`는 별도 `DatabaseSync` 연결에서 실제 `BEGIN EXCLUSIVE`를 실행해 owner mutation과 차단 기록의 기존 SQLite API 호출이 모두 `ERR_SQLITE_ERROR`로 실패하도록 했다. 잠금 해제 후 재시작 시 `blocked` 확인. 메서드 내부의 예외 문자열만 모의하는 `c08`과 별도 실행했다. 실제 디스크 I/O 오류 전체를 대표하지는 않는다.

## 증거와 해석 경계

- 실제 163개 fixture 회귀 통과는 현재 Linux 소스의 **기존 테스트가 주장하는 계약**에 대한 결과다. C06의 **적용 전 lease 만료**, C08의 **Control Plane 차단 저장 예외 후 재시작**을 대표 장애 주입으로 확인했다. 하지만 C06의 적용 중 만료·실제 늦은 writer, C08의 SQLite I/O 오류 유형 전체를 증명한 결과는 아니다.
- `get_work_context`는 `time_budget_exceeded` 시 HEAD=null·partial 관측에도 `drift=detected`를 반환한 반면, 직접 Git 조회는 HEAD 일치·변경 0이었다. 이는 **관측 의미 불일치**의 근거이며, 실제 Kernel mutation 차단 인과는 미확정이다. 소유자는 W1(Moonremote transport 관측과 Kernel Work 권위를 분리).
- SQLite 용량과 Knowledge 중복은 확인됐지만 실행 지연·토큰 비용의 인과는 측정하지 않았다. 원인 미입증 상태에서 새 엔진/규칙/인덱스를 추가하지 않는다.
- `PARTIAL`인 W0를 `KEEP` 또는 `PASS`로 승격하지 않는다. W3-A의 안전성이나 W10의 전체 완료도 미확정 상태다.

## 다음 실행 하나

W0의 **남은 C06 실행 중 만료·C07 실제 프로세스 crash·C08 저장 장치 오류 반례**를 정확히 분리한 완전 격리 테스트로 추가한다. 특히 늦은 writer의 실제 파일 바이트·Git diff·mutation revision·Receipt, patch 적용 직후 crash, `blockDeliveryMaterialization` DB 쓰기 실패/재시작을 검증한다. 다음 결과에서 현행 P0 위반이 확인되면 W3-A를 W1보다 우선한다. 위반이 재현되지 않으면 범위·사례별 불확실성을 기록하고 W1 진입 여부를 재판정한다. 재현 없이 정책 분기·새 lock·상시 gate를 추가하지 않는다.
