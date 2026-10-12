# Chat에 붙여 넣을 요청

## 첫 요청

아래 문장을 Moonremote를 사용할 Chat에 붙여 넣는다. 프로젝트 경로는 도구가 확인한 MCP 실행 환경의 경로를 사용한다.

```text
Moonremote로 Moonshot Relay의 C00 작업만 수행해줘.

계획 폴더:
docs/public/roadmaps/chat-moonremote-increments-2026-10-12

먼저 실제 MCP workspace 경로를 확인하고 get_work_context로 활성 작업을 조회해줘.
START_HERE.md, RUNBOOK.md, cards/C00.md를 필요한 범위만 읽어줘.
활성 작업이 있으면 같은 taskId를 사용하고, 없을 때만 C00 목표로 checkpoint를 만들어줘.
다른 프로젝트의 task는 선택하지 마.

이번 범위는 원격 도구·경로·shell·Git 기준선과 Typed Authority 종료 근거 확인이야.
C01 이후 구현은 시작하지 마.
Kernel 모드는 이 요청으로 활성화하지 않아. 기존 활성 Kernel 작업이 발견되면
계약을 재발급하지 말고 현재 상태와 필요한 다음 조치를 알려줘.

검증된 결과와 남은 항목을 checkpoint와 STATUS.md에 기록해줘.
완료 조건을 충족한 경우에만 해당 continuity task를 complete_work로 닫아줘.
```

## 다음 카드 요청

```text
Moonremote로 같은 계획 폴더의 cards/C02.md 한 장만 실행해줘.
C02는 실행하려는 실제 카드 ID로 해석해줘.
get_work_context와 STATUS.md에서 현재 작업, 선행 완료, 증거 freshness를 먼저 확인해줘.
관련 source와 테스트만 읽고, 카드의 범위 안에서 구현과 검증을 끝내줘.
이미 구현된 항목은 현재 evidence로 확인하고 다시 만들지 마.
작업이 커지면 동작 경계로 a/b 카드를 나누고 이번 요청에서는 첫 카드만 수행해줘.
완료하면 변경·검증·미완료·다음 카드 ID를 기록하고 자동으로 다음 카드에 진입하지 마.
Kernel 모드는 별도 명시가 있을 때만 사용해줘.
```

C01 실행에는 위 C02를 C01로 바꾼다. 카드 번호가 입력되지 않은 상태에서 임의로 다음 카드를 시작하지 않는다. 사용자가 특정 여러 카드를 명시하면 그 범위 안에서 순서대로 진행할 수 있다.

## 끊긴 Chat 재개 요청

```text
Moonremote의 기존 작업을 이어가줘.
계획 폴더는 docs/public/roadmaps/chat-moonremote-increments-2026-10-12야.
먼저 get_work_context로 해당 workspace의 taskId와 최신 revision을 확인해줘.
prepared/running/unknown 실행을 새 operationId로 반복하지 마.
기존 sessionId와 nextSeq로 결과를 확인하고, unknown이면 현재 파일·receipt를 대조해줘.
파일 쓰기와 patch는 실행 ID로 중복 방지되지 않으니 적용 여부부터 읽어줘.
마지막으로 검증된 단계 다음의 미완료 단계만 진행해줘.
전체 계획이나 기존 Kernel 계약을 다시 만들지 마.
```

## Kernel 모드를 명시적으로 사용할 경우

이 계획은 실행 모드를 자동 결정하지 않는다. 사용자가 해당 카드 실행에 moon-relay-kernel을 명시하면 실제 Kernel work unit과 allowed paths가 우선한다. 카드 범위와 충돌하면 카드 실행 범위를 조정한다. 기존 run binding을 보존하고 허가되지 않은 reviewer, subagent, 검증을 추가하지 않는다. Moonremote checkpoint는 통신 복구 기록이며 Kernel completion authority를 대체하지 않는다.
