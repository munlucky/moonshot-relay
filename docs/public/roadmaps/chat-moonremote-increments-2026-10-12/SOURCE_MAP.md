# 확인한 source와 미확인 경계

확인일: 2026-10-12 (Asia/Seoul).

## 대상과 버전

- 개발 대상: C:/dev/moonshot-relay
- 확인 HEAD: d0c07ade7f4f46499a5a95350e2654a4f93515e2
- 문서 작성 전 git status는 clean이었다.
- Moonremote 구현: C:/dev/chatgpt-remote-mcp (사용자가 지정).
- 확인 HEAD: d8caa670f6b93c05b62f5e32a8ccefda9809934f
- 확인 시 Moonremote source의 git status는 clean이었다.
- 현재 Chat의 연결 도구 검색과 plugin 검색에는 moonremote가 노출되지 않았다. 로컬 코드를 직접 읽었다. 실제 MCP 배포와 source parity는 확인하지 않았다.

## Moonremote 구현 근거

| source | 확인한 동작 | 계획 반영 |
| --- | --- | --- |
| C:/dev/chatgpt-remote-mcp/src/batch-read.ts | 16 files, 동시 4개, 기본 4096 bytes, 최대 16 KiB/file | 3~6 files씩, nextOffset 처리 |
| C:/dev/chatgpt-remote-mcp/src/file-tools.ts | read/write/replace/unified diff patch, patch checkOnly | 작은 patch, 읽기 후 적용 확인 |
| C:/dev/chatgpt-remote-mcp/src/exec-tools.ts | task/operation 쌍, 기본 750ms yield, nextCall/nextSeq, read_process | 실행과 조회 분리, 같은 operation 재사용 |
| C:/dev/chatgpt-remote-mcp/src/continuity/task-tools.ts | create/update, UUID requestId, expectedRevision, checkpoint replacement, complete | 카드 목표·CAS·결과 증거 |
| C:/dev/chatgpt-remote-mcp/src/continuity/task-service.ts | summary/full와 bounded 관찰 | full도 partial 여부 확인 |
| C:/dev/chatgpt-remote-mcp/src/config.ts | process 기본 출력 128 KiB, 최소 16 KiB, 배포 설정 가능 | 조회 16 KiB 시작 |
| C:/dev/chatgpt-remote-mcp/src/mcp-server.ts | initialize 복구 지침 | 작업 시작/재개 때 context 조회 |
| C:/dev/chatgpt-remote-mcp/README.md | restart unknown, tracked execution, file edits 비중복 보장 없음 | unknown reconciliation, patch 재전송 금지 |
| C:/dev/chatgpt-remote-mcp/templates/chatgpt-project-instructions.md | 10개 복구 규칙 | RUNBOOK/START_HERE |

Moonremote source의 전체 제품 테스트는 이번 계획 작성에서 실행하지 않았다. 위 동작은 코드/문서 확인 결과다. 운영 catalog에서 schema가 다르면 실제 배포 계약을 확인한다.

## Moonshot의 기존 기능

| source | 관찰 | 후속 처리 |
| --- | --- | --- |
| src/host/kernel/prompts/common-execution.ts | 공통 실행 지침, 필수/선택 필드, 중복 지침 탐지 | C02/C08에서 재사용 |
| src/host/kernel/prompt-envelope.ts | schema v2, 6개 segment, digest/cache identity, provider prompt 참조 | C02~C07의 변경 경계 |
| src/host/kernel/provider-prompt-policy.ts | capability flag와 shadow/on/off 정책 | 기존 registry/delta 사용 |
| src/host/kernel/context-segments.ts | 기존 context 계층 source가 존재 | C07에서 상세 추적 |
| src/kernel/knowledge/records.ts | 기존 record type과 candidate mapping | C17의 표현 가능성 근거 |
| src/kernel/proof/ 및 src/kernel/run/ | Trust/Work 원본 경로 | C12~C16의 owner 경계 |
| src/kernel/knowledge/ 및 src/kernel/persistence/ | Knowledge와 persistence 원본 경로 | C18~C26 |
| src/host-tooling/kernel-eval/ 및 src/kernel/eval/ | 기존 평가 자산 | 새 framework 생성 전 재사용 조사 |
| package/source-layout.json | contracts/kernel/host/host-tooling/application 생성 매핑 | 원본만 수정 |
| docs/public/development.md | TypeScript, generated test, source/build 경계 | 공통 검증 절차 |

기존 테스트 파일 이름과 원본 존재를 확인했다. 모든 테스트 body/런타임 동작을 전수 검증한 것은 아니다. 카드에 적은 기존 테스트 이름은 실행 시작 때 확인하며, 신규 동작에는 실제 부정 사례를 보강한다.

과거 Typed Authority의 CURRENT_ARCHITECTURE.md는 2026-10-09 초기 snapshot이다. 현재 TypeScript source truth로 오인하지 않는다. 일부 문서의 work/trust 디렉터리 설명과 달리 현재 실제 경로는 run/proof다. 이 계획은 실제 경로를 사용했다. 선행 완료 여부는 C00에서 별도로 판정한다.

## 공식 자료 처리

첨부 원문의 깨진 chatgpt-content-reference 표시는 근거로 인정하지 않았다. OpenAI Prompt 재검토 글, Prompt Caching 문서, Claude Prompting Best Practices 페이지를 직접 조회했다. 본 계획은 모델 교체를 요구하지 않는다. 모델별 지원과 성향은 실행 시 재확인한다.

## 문서 검증과 유지보수

이번 산출물은 이 새 계획 폴더에만 쓴다. 기존 canonical 지침 구조는 바꾸지 않는다. 링크·카드 ID·의존 관계·전체 Wave coverage를 검사한다. 현지 source 및 설치 scripts에서 별도 knowledge repository audit 전용 entrypoint를 찾지 못했으므로 해당 감사 완료를 주장하지 않는다. 설치본의 일반 skills audit나 promotion audit를 이 감사의 대체물로 호출하지 않는다.
