# W0 사건/반례 매트릭스 (C01~C14)

판정 정의: `already_fixed`는 현행 대응 경로가 격리 회귀에서 확인된 범위만 뜻한다. `internal_unverified`는 자료·재현 범위가 부족하여 현재 결함/안전을 확정할 수 없음을 뜻한다. `historical_only`는 현행 재현 없는 과거 이력이다. 시험 결과와 런타임 운영 결과는 혼용하지 않는다.

| ID | 현재 확인한 사실/재현 | 판정 | 단일 실제 수정 소유 Wave | 남은 검증 또는 경계 |
|---|---|---|---|---|
| C01 | `get_work_context` partial/HEAD null + drift detected, 직접 Git clean/HEAD 일치. `kernel-run-locator-fail-soft` 회귀 통과 | `internal_unverified` (관측 불일치 확인) | **W1** | transport의 부분 관측이 실제 승인/작업 차단으로 이어지는지 검사. Moonremote 전용이면 외부 소유로 분리 |
| C02 | `kernel-parallel-fencing`의 HEAD/dirty/revision mismatch 거부 회귀 통과 | `already_fixed` (해당 fixture 경계) | **W1** 관측, **W3-A** 물리 쓰기 | 실제 소스 변경 뒤 stale proof 재승인 여부는 별도 |
| C03 | W0 DB 백업에서 blocked `external-dependency` 7건(FRAME 2/PROVE 5). Report가 차단 Class를 덮어쓸 수 있던 실결함은 W2에서 수정 | `internal_unverified` (독립 구현 중단의 인과 미확정) | **W2** | 명시적으로 blocked인 Run에 독립 실행 가능 Step이 남아 있었는지 원본 사례/인과가 없으므로 자동 unblock 추가 금지 |
| C04 | W2에서 `progressive-admission` 재실행 PASS: 명령 부재 시 구현 시작/EXECUTE 가능, PROVE에서 Hard Evidence 미충족 차단, 명령 제공 후 자동 Rebinding | `already_fixed` (격리 Linux PROVE 경계) | **W2** | 실제 Provider/native Host와 계정 설치 환경은 별도 소유 Wave에서 검증 |
| C05 | `kernel-review-host-bridge`와 Reviewer 관련 회귀 통과 | `internal_unverified` | **W4** | macOS native/실제 독립 Reviewer 세션 증거 미확인 |
| C06 | 패치 전 owner fence expiry 시 actual byte 0·revision 0. 실제 `git apply` 12,000파일 재실행에 249ms fence-derived timeout 적용 시 ETIMEDOUT/SIGTERM, 4,384파일 생성 뒤 만료 이후 **추가 파일 0** (기존 3,000파일 PASS 증거도 보존) | `internal_unverified` (단일 subprocess deadline 사례 통과) | **W3-A** | 외부 owner fence 강제 교체와 실제 kernel dispatcher 동시 경합은 미검증; 경계 실패로 곧바로 새 권위/Lock 추가 금지 |
| C07 | 기존 C07 제3자·부분 파일 상태와 더불어 실제 `git apply` 3,000파일 중 SIGKILL 후 **43파일 잔존** (기존 16파일 재현도 보존), 격리 Kernel durable routed attempt 기반 재시작 **blocked/revision 0**, 바이트 보존 확인 | `already_fixed` (대표 crash recovery) | **W3-A** | worker receipt는 fixture가 만들어 제공; 실 Provider 연결·동시 중복 요청은 다른 경계 |
| C08 | 실제 격리 SQLite **배타 잠금**으로 owner CAS·차단 기록 모두 `ERR_SQLITE_ERROR`, 실패 직후 active/revision 0 → 잠금 해제 후 재시작 **blocked**. 기존 모의 실패도 재현 | `internal_unverified` (실제 디스크 I/O 오류 전체 범위 미검증) | **W3-A** | SQLITE_BUSY 경계 이외 I/O·디스크 가득 참, 차단 후 명시적 복구 승인 정책은 별도 검증 |
| C09 | W3-B 실제 로컬 Git 원격 push 실패→재시도, 승인 commit SHA 재사용·중복 커밋 0, `commit_created`/`completed` crash 뒤 report 재전송·외부 HEAD/index drift 거부 검증 | `already_fixed` (격리 승인·재시작 범위) | **W3-B** | 실제 운영 원격의 승인된 closeout은 수행하지 않았고 별도 검증 필요 |
| C10 | W3-B에서 선택적 Knowledge·Projection 후속 실패가 승인 코드/Git을 무효화하지 않고, 필수 Knowledge 미완료면 전체 최종화되지 않음 재검증 | `already_fixed` (격리 후속 처리 범위) | **W3-B** | 운영 범위 내 필수 승인 대기는 PARTIAL, 외부 소유와 혼동 금지 |
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
