# Codebase Master Guide: Curriculum & Layout Specification

본 문서는 백엔드 및 풀스택 코드베이스를 분석하여 대화형 마스터 슬라이드북(Interactive Slidebook)을 제작할 때 준수해야 하는 상세 기술 명세서입니다.

---

## 1. 적응형 커리큘럼 명세 (Adaptive Curriculum Specification)

대상 백엔드·풀스택 코드베이스의 실제 구조에 맞춰 챕터를 구성합니다. 아래 구성은 대표 예시이며, 실제 프로젝트에 없는 계층(예: 분산 락, 웹훅, 특정 프레임워크)은 해당 프로젝트의 실제 컴포넌트로 대체합니다.

### CH.00 온보딩 & 아키텍처 블루프린트 (Architecture Blueprint)
1. **마스터 대시보드**
   - 핵심 아키텍처 메트릭스(슬라이드 수, 선정 파일 커버리지 100%, 주요 경계/계층 요약)
   - 학습 트랙(인프라·경계 / 식별자·상태 / 전수 코드 / 엣지 시나리오) 및 키보드 내비게이션 안내
2. **시스템 토폴로지**
   - 클라이언트 진입점부터 에지/게이트웨이, 애플리케이션 런타임, 데이터 저장소, 외부 연동까지의 경계 및 단방향 통신 규칙
   - 하단 패널: 보안 경계, 풀/리소스 격리, 인증·검증 정책
3. **E2E 데이터 흐름 & 트랜잭션 바운더리**
   - 동기 요청 접수, 비동기/백그라운드 처리, 외부 연동, 최종 일관성 수렴 단계
   - 하단 패널: 트랜잭션/락 범위 비교, 타임아웃 예산, 장애 격리 전략
4. **고가용성 & 분산 코디네이션 (해당 시)**
   - 중복 실행/동시성 제어 메커니즘, 재시도·복구 파이프라인, 파라미터 튜닝 가이드
5. **장애 대응 & DR 매트릭스**
   - 주요 장애 시나리오(타임아웃, 중복 요청 폭주, 풀 고갈, 외부 API 오류, 데이터 불일치)별 방어 명세 및 에스컬레이션 절차
6. **모듈 구조 및 패키지 맵**
   - 모듈 간 의존 방향, 경계 불변식, 공개/내부 진입점 구분

---

### CH.01 식별자 & 도메인 데이터 모델 지도 (Identifier & State Mapping)
1. **도메인 주체 및 외부 연동 식별자**
   - 내부 PK, 외부 연동용 가명화 키, 감사/추적 ID의 분리 원칙과 개인정보·민감정보 보호 경계
2. **요청·이벤트 추적 식별자 및 상태 전이**
   - 접수 ID, 멱등성 키, 웹훅/메시지 이벤트 ID의 역할 분리와 재시도·중복 차단 생명주기 매트릭스

---

### CH.02 ~ CH.07 핵심 파일 100% 전수 코드 리뷰
- 대상 코드베이스에서 선정한 핵심 파일(진입점, 오케스트레이션, 상태/원장, 비동기 수신, 배치/스케줄러, 테스트)을 20~30행 단위로 분할하며 한 줄도 생략하지 않습니다.
- 각 코드 슬라이드는 반드시:
  1. `startLine`, `highlightLines` (핵심 로직 라인 강조)
  2. PrettyLights 구문 강조 토큰 클래스 적용
  3. 사수의 1:1 라인 코칭 노트 배열 (`comments: [{ line, text }]`)

---

### CH.08+ 엣지 시나리오, 실무 함정, 자가진단 퀴즈
1. **프로덕션 엣지 시나리오 (3개 이상)**
   - 중복 요청/동시성 방어, 외부 호출 타임아웃 격리, 비동기 누락 보정 등 실제 코드 기반 타임라인 및 상태 전이 다이어그램
2. **실무 함정 매트릭스**
   - 문서·기획과 실제 구현의 차이, 상태값 오해, 재시도/트랜잭션/락 점유 시간, 경계 조건 등 코드에서 직접 확인된 함정 목록
3. **자가진단 퀴즈 스테이션 & 수료 대시보드**
   - 질문 카드(난이도, 핵심 질문) + 정답 및 파일/라인 인용 토글 + 리뷰 체크포인트 + `[관련 소스코드 슬라이드 바로가기]` 버튼
   - 핵심 컴포넌트 마스터리 요약 및 배포 전 체크리스트

---

## 2. 디자인 및 레이아웃 토큰 표준

- **2-Tier Vertical System**: 모든 `card` 슬라이드는 `h-full min-h-[calc(85vh-150px)] flex flex-col justify-between`을 적용하고, 상단 도식 카드(`min-h-[380px] ~ min-h-[430px]`)와 하단 심층 패널(비교표, SOP, 체크리스트)로 빈 공간을 제거합니다.
- **가로 스크롤 방지**: `overflow-x: hidden !important; max-width: 100vw;`로 모바일·데스크톱 전 해상도에서 가로 스크롤을 차단합니다.
- **소스코드 뷰어 6대 툴바**: 폰트 줌(A-/A+), 줄바꿈 토글, 분할/와이드 레이아웃 전환, 실시간 인코드 검색, 전체화면 모달, 원클릭 코드 복사 및 라인 거터·코칭 카드 양방향 점프.

### GitHub Primer & PrettyLights CSS Tokens
```css
/* Dark Mode */
.theme-dark {
  --bg-main: #0d1117;
  --bg-deck: #161b22;
  --bg-card: #161b22;
  --bg-subtle: #21262d;
  --border: #30363d;
  --border-focus: #388bfd;
  --text-title: #f0f6fc;
  --text-body: #c9d1d9;
  --text-muted: #8b949e;
  
  --code-bg: #0d1117;
  --code-border: #30363d;
  --code-text: #e6edf3;
  --gutter-num: #6e7681;
  --gutter-active: #f0f6fc;
  --highlight-bg: rgba(56, 139, 253, 0.15);
  --highlight-border: #388bfd;
  --line-hover: rgba(110, 118, 129, 0.15);

  --tok-kw: #ff7b72;
  --tok-anno: #d2a8ff;
  --tok-type: #79c0ff;
  --tok-method: #d2a8ff;
  --tok-str: #a5d6ff;
  --tok-const: #79c0ff;
  --tok-num: #79c0ff;
  --tok-bool: #ff7b72;
  --tok-comment: #8b949e;
  --tok-op: #e6edf3;
}

/* Light Mode */
.theme-light {
  --bg-main: #f6f8fa;
  --bg-deck: #ffffff;
  --bg-card: #f6f8fa;
  --bg-subtle: #ffffff;
  --border: #d0d7de;
  --border-focus: #0969da;
  --text-title: #1f2328;
  --text-body: #24292f;
  --text-muted: #656d76;
  
  --code-bg: #ffffff;
  --code-border: #d0d7de;
  --code-text: #1f2328;
  --gutter-num: #8c959f;
  --gutter-active: #1f2328;
  --highlight-bg: #ddf4ff;
  --highlight-border: #0969da;
  --line-hover: rgba(175, 184, 193, 0.2);

  --tok-kw: #cf222e;
  --tok-anno: #8250df;
  --tok-type: #0550ae;
  --tok-method: #8250df;
  --tok-str: #0a3069;
  --tok-const: #0550ae;
  --tok-num: #0550ae;
  --tok-bool: #cf222e;
  --tok-comment: #57606a;
  --tok-op: #1f2328;
}
```

### 펄스 애니메이션 (Pulse Focus Animation)
코칭 카드 클릭 시 해당 코드 라인으로 이동하며 1.8초간 시각적 집중 효과를 제공합니다:
```css
@keyframes pulseLineFocus {
  0% { background-color: rgba(56, 139, 253, 0.45); box-shadow: 0 0 15px rgba(56, 139, 253, 0.6); }
  50% { background-color: rgba(56, 139, 253, 0.25); box-shadow: 0 0 8px rgba(56, 139, 253, 0.3); }
  100% { background-color: var(--highlight-bg); box-shadow: none; }
}
.code-line-row.pulse-focus {
  animation: pulseLineFocus 1.8s ease-out forwards !important;
  border-left: 3px solid var(--highlight-border) !important;
}
```
