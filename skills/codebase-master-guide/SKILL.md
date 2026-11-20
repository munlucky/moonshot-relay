---
name: codebase-master-guide
description: >-
  코드베이스 전수 분석 및 인터랙티브 개발자 가이드(슬라이드북) 제작 스킬.
  "Why(기술적 이유)" 중심 해설, 아키텍처 토폴로지, E2E 데이터·트랜잭션 바운더리,
  선택한 핵심 파일의 생략 없는 1:1 라인별 코칭 리뷰, 엣지 시나리오, 실무 함정 매트릭스,
  자가진단 퀴즈를 포함한 단일 Standalone HTML을 생성합니다.
user-invocable: true
---

# Codebase Master Guide Skill

## 1. 목적 및 사용 시점 (Use When)

Use this skill when the user asks to:
- analyze a backend, frontend, or full-stack codebase and create an interactive onboarding handbook
- generate a zero-dependency slidebook developer guide HTML (`scripts/render_slidebook.py` or `node scripts/kernel/standalone/codebase-master-guide.mjs`)
- conduct a line-by-line code review of selected core modules with 1:1 coaching notes
- document system topology, transaction/data boundaries, edge scenarios, and practical pitfalls

Trigger phrases:
- `$codebase-master-guide`
- `코드베이스 분석 가이드 만들어줘`
- `개발자 가이드 슬라이드북 제작`
- `전수 코드 리뷰 문서 만들어줘`
- `인터랙티브 슬라이드북 생성`
- `master slidebook`
- `codebase master guide`
- `프로젝트 전수 코드 리뷰 가이드`

## 2. 제외 및 라우팅 기준 (Route Away)

- 단순 1~2개 파일 또는 단일 브랜치/PR의 변경분 설명만 필요한 경우 ➔ `explain-diff-html`로 라우팅.
- 신규 아키텍처 의사결정(ADR)이나 PRD 설계 단계인 경우 ➔ `moonshot-architecture`로 라우팅.
- 새로운 기능을 직접 구현하거나 리팩터링을 수행하는 경우 ➔ `moonshot-orchestrator`로 라우팅.

## 3. 핵심 원칙 (Core Principles)

1. **Why(기술적 당위성) 중심 해설**: 단순 문법 요약이 아니라 설계 의도, 식별자·상태 분리 이유, 장애 전파 및 복구 영향을 설명합니다.
2. **선택한 핵심 파일 100% 라인 수록**: 선정한 핵심 파일은 생략 부호(`...`) 없이 20~30행 단위로 분할 수록하고 라인별 코칭 노트를 매핑합니다.
3. **2-Tier 레이아웃 & 반응형 안정성**: 도식/핵심 요약 카드와 심층 분석 패널(비교표, SOP, 체크리스트)을 결합하고 가로 스크롤을 방지합니다.
4. **코드베이스 사실 기반**: 실제 존재하는 파일, 심볼, 상태 머신, 인프라 구성을 확인한 내용만 기재하고 미확인 사항은 추정하지 않습니다.

## 4. 적응형 커리큘럼 구조 (Adaptive Curriculum)

대상 프로젝트의 실제 스택과 아키텍처에 맞춰 챕터를 구성합니다(세부 UI 토큰·슬라이드 규격은 `references/curriculum-and-layout-spec.md` 참조):

| 챕터 영역 | 주제 | 핵심 구성 요소 |
| :--- | :--- | :--- |
| **CH.00** | **온보딩 & 아키텍처 블루프린트** | • 마스터 대시보드, 학습 트랙, 키보드 내비게이션 안내<br>• 시스템 토폴로지, E2E 데이터·트랜잭션 바운더리, 동시성·장애 대응 매트릭스, 모듈 경계 |
| **CH.01** | **식별자 & 도메인 상태 모델** | • 주요 엔티티/외부 연동 ID 분리, 상태 전이 및 멱등성·개인정보 경계 |
| **CH.02~07** | **핵심 파일 라인별 전수 리뷰** | • 대상 스택에 맞게 선정한 핵심 모듈(예: Entrypoint/Handler, Orchestration/Service, Domain/State Model, Async/Webhook/Integration, Background/Scheduled Jobs, Test/Spec) |
| **CH.08+** | **부가 도메인, 엣지 시나리오, 함정, 퀴즈** | • 주요 프로덕션 엣지 시나리오 타임라인, 실무 함정 매트릭스, 자가진단 퀴즈 스테이션 및 수료 체크리스트 |

## 5. 실행 절차 (Procedure)

1. **정적 탐색 및 핵심 파일 선정**: 대상 저장소의 실제 스택을 확인해 아키텍처 계층별 대표 파일(진입점, 오케스트레이션, 상태/원장, 비동기/통합, 배치/스케줄러, 테스트)을 선정합니다.
2. **토폴로지 및 경계 도출**: 실제 코드·설정에서 확인된 신뢰 경계, 트랜잭션/커넥션 정책, 타임아웃·재시도 정책을 정리합니다.
3. **식별자·상태 모델 지도 작성**: 내부/외부 식별자와 상태 전이 규칙을 매핑합니다.
4. **라인별 슬라이드 스펙 JSON 생성**: `templates/example-spec.json`과 `references/curriculum-and-layout-spec.md` 형식으로 20~30행 단위 코드 슬라이드와 1:1 코칭 노트를 구성합니다.
5. **렌더링 및 정적 검증**: `python scripts/render_slidebook.py spec.json -o <project-name>-guide.html` (또는 `node scripts/kernel/standalone/codebase-master-guide.mjs`)를 실행하고 생성 HTML의 슬라이드/코드 누락·퀴즈·가로 스크롤 여부를 점검합니다.

## 6. 하드 스톱 (Hard Stops)

- 선정한 핵심 파일 슬라이드에 생략 부호(`...`)로 코드를 건너뛰지 않습니다.
- 실제 소스에서 확인하지 않은 파일 경로, 라인 번호, 상태값, 인프라 구성을 지어내지 않습니다.
- 비밀키, 토큰, 인증정보, 실명·민감 개인정보를 슬라이드북 스펙이나 출력 HTML에 포함하지 않습니다.
- 기본 템플릿과 CSS/JS 스캐폴딩은 `scripts/render_slidebook.py`와 `templates/slidebook-template.html`을 재사용합니다.

## References

- `references/curriculum-and-layout-spec.md`: 상세 커리큘럼 안내 및 GitHub Primer/PrettyLights CSS 토큰 규격
- `templates/example-spec.json`: 최소 슬라이드 스펙 JSON 예시
- `templates/slidebook-template.html`: Standalone HTML 렌더 템플릿
- `scripts/render_slidebook.py`: Standalone HTML 생성 스크립트
