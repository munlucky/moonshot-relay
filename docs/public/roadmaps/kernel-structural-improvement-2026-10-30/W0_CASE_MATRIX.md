# W0 사건/반례 매트릭스 (C01~C14)

판정 정의: `already_fixed`는 현행 대응 경로가 격리 회귀에서 확인된 범위만 뜻한다. `internal_unverified`는 자료·재현 범위가 부족하여 현재 결함/안전을 확정할 수 없음을 뜻한다. `historical_only`는 현행 재현 없는 과거 이력이다. 시험 결과와 런타임 운영 결과는 혼용하지 않는다.

| ID | 현재 확인한 사실/재현 | 판정 | 단일 실제 수정 소유 Wave | 남은 검증 또는 경계 |
|---|---|---|---|---|
| C01 | `get_work_context` partial/HEAD null + drift detected, 직접 Git clean/HEAD 일치. `kernel-run-locator-fail-soft` 회귀 통과 | `internal_unverified` (관측 불일치 확인) | **W1** | transport의 부분 관측이 실제 승인/작업 차단으로 이어지는지 검사. Moonremote 전용이면 외부 소유로 분리 |
| C02 | `kernel-parallel-fencing`의 HEAD/dirty/revision mismatch 거부 회귀 통과 | `already_fixed` (해당 fixture 경계) | **W1** 관측, **W3-A** 물리 쓰기 | 실제 소스 변경 뒤 stale proof 재승인 여부는 별도 |
| C03 | `external-dependency` 때문에 안전한 구현까지 중단된다는 과거 보고 | `historical_only` | **W2** | blocked 관측과 권위 판정의 현행 실제 경로 재현 |
| C04 | `kernel-required-capability` 회귀 통과, 실제 필수 환경 부재 표면은 미시험 | `internal_unverified` | **W2** | 일반 구현 진행과 필수 Proof 완료 승인 분리 |
| C05 | `kernel-review-host-bridge`와 Reviewer 관련 회귀 통과 | `internal_unverified` | **W4** | macOS native/실제 독립 Reviewer 세션 증거 미확인 |
| C06 | 현재 격리 Delivery에서 expiry 주입 시 **패치 전 actual byte 변경 0·Git clean·revision 0** 직접 확인. 기존 fencing 회귀도 통과 | **`internal_unverified` (적용 중 만료 미검증)** | **W3-A** | 패치 프로세스 시작 후 lease 상실/종료 경합에서 실제 바이트·Run/Step 검사 필요 |
| C07 | 실제 Delivery 뒤 `third-party.txt` 삽입 및 `beta` 삭제(부분 파일 상태) 독립 fixture 각각 **blocked/revision 0**, 외부·잔여 파일 보존 확인. 기존 settlement crash 회귀 통과 | `internal_unverified` (실제 프로세스 강제 종료 중 patch 적용 경계 미검증) | **W3-A** | 실제 patch 도중 프로세스 중단·재시작에서 잔여 파일/Receipt 보존과 중복 적용 0 직접 검증 필요 |
| C08 | 실제 격리 SQLite **배타 잠금**으로 owner CAS·차단 기록 모두 `ERR_SQLITE_ERROR`, 실패 직후 active/revision 0 → 잠금 해제 후 재시작 **blocked**. 기존 모의 실패도 재현 | `internal_unverified` (실제 디스크 I/O 오류 전체 범위 미검증) | **W3-A** | SQLITE_BUSY 경계 이외 I/O·디스크 가득 참, 차단 후 명시적 복구 승인 정책은 별도 검증 |
| C09 | `kernel-git-closeout-retry` 및 `kernel-report-replay` 재시작·중복 Git 전달 회귀 통과 | `already_fixed` (fixture) | **W3-B** | accepted SHA·Identity 사용 지점, live closeout 재시도는 별도 |
| C10 | `kernel-finalization-knowledge-nonblocking`에서 Knowledge 저장 실패·review·projection 후속 deferred 회귀 통과 | `already_fixed` (fixture) | **W3-B** | 선택/필수 Knowledge 후속의 운영 승인 대기는 별도 구분 |
| C11 | `kernel-project-identity`의 alias/merge/isolation 회귀 통과; 과거 Git common-dir 미검증 이력 | `internal_unverified` | **W8** 원천 정책, **W3-B** 승인 후 사용 지점 | 운영 namespace를 임의 adopt/merge 금지; 소유 승인 없이 live repair 금지 |
| C12 | 운영 백업에서 `known_failure_pattern` **1,915건·서로 다른 statement 34개** 직접 계수, `kernel-knowledge-candidate` dedupe 회귀 통과 | `internal_unverified` (중복 데이터 확인) | **W5** | 현재 생성 경로·occurrence/verified resolution을 분리; 운영 정리 승인은 필수/선택 구분 |
| C13 | 백업 dbstat Context 62.52 MiB, Attempts 50.70 MiB, Evidence 39.07 MiB, Finalization 21.21 MiB | `internal_unverified` (용량 확인) | **W6** 저장, **W7** 조회 | 지연 인과, payload 필수성, 조회/파싱 A/B 측정 전 무조건 축소 금지 |
| C14 | 운영 백업의 Session Binding **415건(활성 25)**, `kernel-session-run-lifecycle` 및 locator 회귀 통과 | `internal_unverified` | **W1** Run 선택, **W8** Host handle 수명 | 실제 stale binding의 타 Run 선택·재시작 결과 미확인 |

## 수정 책임 중복 금지

- Run 선택·실행 재개·부분 관측: **W1** (W8은 해당 권위의 중복 수정 금지).
- 승인 후 Git 전달·Identity 사용 지점에서의 복구: **W3-B** (W8은 결과 검증 재사용).
- Host Session 수명·설치·Project Identity 원천 정책: **W8** (W1/W3-B는 소유 경계 밖 새 정책 금지).
- 승인 **전** 실제 파일 반영·fence·차단 내구성: **W3-A** (W3-B의 성공으로 대체 불가).
- 겹친 함수/DB 필드는 W0 매트릭스의 수정 소유자만 변경한다. 공통 W0 선행 외에 무조건적인 Wave 간 의존성은 도입하지 않는다.
