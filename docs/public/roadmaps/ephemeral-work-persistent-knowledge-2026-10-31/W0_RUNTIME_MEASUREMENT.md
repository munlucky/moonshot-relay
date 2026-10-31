# W0 — Native/MCP 저장 경계 및 SQLite 실행 비용 실측

- 조사일: 2026-10-31, 현행 기준선 `main / 362a518a` (제품 소스 변경 없음)
- 목적: Ephemeral Work 전환 전에 **현행 SQLite 사용 경계와 기본 실행당 SQL 호출 부하**를 실측한다.
- 방식: 운영 DB는 경로/파일 메타데이터만 읽고, 실제 DB 조작·계측은 Linux `/tmp`의 완전 격리 Kernel Runtime과 프로젝트에서만 수행.
- 환경: Windows 10 Native + WSL2/Linux Moonremote, macOS ARM64 Native + Linux ARM64 Moonremote VM.
- **판정: W0 측정 완료 / Local·MCP 동시 writer 및 Host 인계 안전성은 W1/W7의 별도 미검증 항목.**

## 1. Native/MCP 운영 DB 경로 대조

| Host | 프로세스 환경 | 실제 DB/공유 마운트 | 근거 | 미검증 |
| --- | --- | --- | --- | --- |
| Windows Local | Windows Native, 10.0.19045 | `C:\Users\moon\.moon-relay-kernel\state\runtime-state.sqlite`, 228,564,992 bytes | Native PowerShell Host 실행으로 `Test-Path`/`Get-Item`, 경로 직접 확인 | 실제 동시 writer 파일 핸들 |
| Windows MCP | WSL2 Linux | `/root/.moon-relay-kernel/state/runtime-state.sqlite`는 같은 Windows C:의 `9p` 공유 경로 | 동일 계정 경로, 기존 `findmnt`/파일 메타데이터 대조 | Windows/WSL VFS 잠금 일관성 |
| Mac Local | macOS ARM64 (Darwin 25.5.0) | `/Users/seokgimoon/.moon-relay-kernel/state/runtime-state.sqlite`, 48,054,272 bytes | **Mac Native** Host 실행, `stat`/마운트 확인 | 실제 SQLite 핸들/중단·인계 시험 |
| Mac MCP | Linux ARM64 VM | `/root/.moon-relay-kernel/state/runtime-state.sqlite`, 48,054,272 bytes, `virtiofs`로 Mac Host 홈 공유 | **Mac MCP** 컨테이너 `stat`/`df -T`/`mount`, macOS와 크기·mtime 일치 | Host↔VM SQLite VFS 동시 WAL writer 안전성 |

Mac MCP에서는 `runtime-state.sqlite-wal`(0 bytes)과 `-shm`(32,768 bytes)이 존재했다. 운영 데이터는 열거나 변경하지 않았다. 이는 **실제 파일 공유 구조의 증거**이지 동시 쓰기 또는 데이터 손상 인과 증거가 아니다.

기존 Linux 컨테이너/Host의 분리가 중요하다. Linux 컨테이너가 별도 VM에서 동작하더라도 DB가 독립 ext4가 아니라 Host 공유 볼륨에 위치하면 동일 raw SQLite 파일을 여러 VFS가 열 수 있다. Windows도 9p를 통해 동일한 문제가 있다.

Mac Native Host와 Windows Native Host 실행 명령은 이번 연결에서 모두 정상 종료(0)됐다. 과거 W8의 Windows native 사용자 실행 접근 불가 상태가 **현재 연결에서도 여전히 불가하다는 주장은 아니다**. 다만 실제 사용자 진행 중 Codex/Reviewer 세션을 강제 종료하거나 재시작하지 않았다.

## 2. SQLite 단독 State Store 계측 (Linux 임시 `/tmp`)

현행 `scripts/kernel/state-store.js`를 실제 호출했으며 Node.js 22.23.4의 `node:sqlite` `DatabaseSync.exec`, `StatementSync.run/get/all`을 **프로세스 안에서만 계측**했다. 제품 파일에 계측 코드를 삽입하지 않았다.

| 단계 | 시간(ms) | API `exec` | CREATE 시도 | ALTER TABLE 시도 | DML 구문 기록 |
| --- | ---: | ---: | ---: | ---: | --- |
| 최초 `openKernelStateStore` | 56.66 | 156 | 70 | 143 | INSERT 12, UPDATE 16, DELETE 1 |
| 기존 DB 다시 열기 1 | 9.55 | 156 | 70 | 143 | INSERT 12, UPDATE 16, DELETE 1 |
| 기존 DB 다시 열기 2 | 9.51 | 156 | 70 | 143 | INSERT 12, UPDATE 16, DELETE 1 |
| 기존 DB 다시 열기 3 | 8.17 | 156 | 70 | 143 | INSERT 12, UPDATE 16, DELETE 1 |
| 기존 DB 다시 열기 4 | 11.62 | 156 | 70 | 143 | INSERT 12, UPDATE 16, DELETE 1 |
| Knowledge Revision 단일 조회 | 0.04~0.12 | 0 | 0 | 0 | 없음 |
| `createRun` | 0.94 | 2 | 0 | 0 | INSERT 1 |
| Completion Decision 기록 | 0.89 | 0 | 0 | 0 | INSERT 1, UPDATE 1 |
| Knowledge Commit (Revision CAS) | 3.83 | 2 | 0 | 0 | INSERT 4, UPDATE 4 |

- 파일 크기: 최초 open 중 `db 4,096 B`, `wal 1,779,872 B`; Knowledge Commit 후 `wal 1,874,632 B`; SQLite 종료·checkpoint 이후 DB `421,888 B`.
- 위 DML/DDL 수치는 실행된 **SQL 텍스트 안의 구문 발견 횟수**다. SQL 실행 실패/조건 불일치/트랜잭션 rollback을 포함할 수 있으며 성공한 쓰기, 실제 변경 행 수, fsync/물리 I/O 수와 동일하지 않다.
- 특히 `ALTER TABLE` 143회는 이미 존재하는 컬럼 재추가의 실패 시도를 포함한다. 반복적인 일반 DB open 단계에 대량의 스키마 변형 SQL을 수행하는 경로가 있다는 점이 핵심이다.

## 3. Control Plane end-to-end 샘플

임시 프로젝트 파일 `.moon-relay/track.yaml`, `package.json`, `app.mjs`과 임시 Runtime에서 실제 `createKernelControlPlane`, `startRun`, `next`, `report`, `close`, 재시작 후 `next`를 실행했다.

| 단계 | 관측 시간(ms) | SQL exec | get/all | INSERT / UPDATE / DELETE 시도 | 실제 결과 |
| --- | ---: | ---: | ---: | --- | --- |
| Control Plane 최초 열기 | 91.79 | 162 | 47 / 124 | 15 / 18 / 1 | 초기 구성 성공 |
| `startRun` | 142.22 | 2 | 8 / 6 | 5 / 4 / 0 | Run 생성 성공 |
| `next` | 95.42 | 2 | 34 / 35 | 0 / 0 / 0 | `implement` |
| `report` (부분 acceptance) | 304.74 | 14 | 149 / 86 | 8 / 31 / 1 | `in-progress`, step passed |
| `report` (완료 acceptance) | 328.16 | 12 | 125 / 82 | 9 / 23 / 2 | `completed`, 다음 동작 `done` |
| 재시작 Control Plane 열기 | 29.19 | 162 | 45 / 127 | 14 / 22 / 1 | 기존 Run 복구 |
| 재시작 후 `next` | 15.22 | 0 | 31 / 33 | 0 / 0 / 0 | `done` |

- 두 Control Plane open 모두 CREATE 70개, ALTER TABLE 143개 시도.
- 단일 샘플의 시간에는 코드 로딩/파일시스템 관측/실제 테스트 명령 실행 등이 포함될 수 있다. 각 단계에 귀속된 SQLite 계측과 모든 경과 시간 사이에 인과 또는 비례관계는 입증되지 않는다.
- `next` 자체에서는 이 샘플의 DML 쓰기가 없었다. 따라서 **일반 조회가 반드시 DB를 쓰는 것처럼 기술하면 안 된다**. 문제는 DB 연결 시점의 스키마 초기화 및 `report` / Start의 넓은 영속화다.

## 4. 반복 지연 기준선 (계측 프록시 없는 동일 `/tmp` 격리 fixture)

동일 Runtime/실행기에서 안정 상태의 `cp.next(activeRun)` 20회와 `createKernelControlPlane` 재연결 20회를 순차 실행.

| 지표 | N | p50 | p95 | 최소 | 최대 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 동일 활성 Run `next` | 20 | 10.38ms | 15.22ms | 8.43ms | 80.18ms |
| 기존 Runtime Control Plane reopen | 20 | 29.39ms | 36.46ms | 26.55ms | 47.03ms |

- p50/p95는 위 20개 독립 관측의 nearest-rank 백분위다.
- 역사적 W9 수치(다른 테스트 환경)와 직접 A/B 성능 차이를 주장하지 않는다.
- W0는 변경 전 기준선이므로 개선률(%)은 아직 없다.

## 5. W1/W2/W6에 전달할 실증 과제

1. **W1 Host 소유와 인계:** Mac Local↔MCP, Windows Local↔MCP가 실제 raw DB 파일을 공유하는 현황. 실제 병렬 writer 안전성, Lease/Fencing, Codex 세션 복구와 작업 인계를 격리 fixture에서 입증해야 한다. 운영 DB에 동시 쓰기 실험 금지.
2. **W2 Knowledge 독립화:** `knowledge-lifecycle-store.ts`가 `getRun`, `getCompletionDecision`, `getKnowledgeReviewReceipt`, `runs` 갱신을 포함하는 현재 트랜잭션 의존을 분리하고, source/trust/Revision CAS 증명이 유효한지 확인한다.
3. **W3 Trust 정착:** Git push 결과/검증/Reviewer/Completion 영수증의 정착 이전 재실행 방지와 정착 이후 영구 Run 제거 가능 조건을 확립한다.
4. **W6 SQLite 일반 열기:** 명시적인 마이그레이션 여부 확인과 정상 open 경로 분리. 현재 143 ALTER/70 CREATE 반복 시도 제거의 인과 효과와 기존 호환성을 같은 fixture로 비교한다. 새 범용 migration engine, 캐시/하드코딩 폴백 금지.
5. **W7 Native 교차 검증:** Windows 및 macOS Native에서 실제 Codex/Kernel 사용, 연결 단절·재시작·Review·Knowledge/Scope 유효성 측정. 사용자 활성 세션 무단 종료 금지.

## 6. 검증 상태

- 파일 편집: 이 조사 문서와 W0 결과 설명 외 제품 소스 변경 없음.
- 운영 DB 쓰기: 없음.
- 제품 기존 회귀: 이전 W0에서 `23/23 PASS`.
- 이번 격리 DB 실행: Store cold/warm/CAS/Knowledge Commit 및 Control Plane `startRun → next → report(partial/full) → reopen → next` 모두 명령 종료 0. 반복 20+20 관측 정상 종료.
- 남은 한계: 실제 네 OS/VFS 경계의 **동시 writable access** 및 실제 에이전트 작업 인계에 대한 end-to-end 증거는 아직 없음. 이것은 W1/W7에서 검증하며 동작이 안전하다고 가정하지 않는다.
