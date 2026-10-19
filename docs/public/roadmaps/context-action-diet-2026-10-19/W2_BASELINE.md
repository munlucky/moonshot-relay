# W2 · 실제 completed run baseline

## 결론

Moonshot Relay canonical project(`path-ad34f90ddb7a2a17`)에는 `CLOSE + completed + finalization completed` run이 52개 있다.
W2 표본은 최신 20개 completed run으로 고정했다.

표본 수 자체는 충분하다. 다만 측정 세대가 섞여 있어 W3에서 모든 비용 축을 동일하게 비교할 수는 없다.

- Prompt footprint: 0/20. W1 이전 run에는 `promptMeasurement`가 없다.
- Provider token count: non-null token row를 가진 run은 1/20뿐이다.
- Model usage receipt가 존재하는 run: 9/20.
- Attempt ledger가 존재하는 run: 12/20.
- `timeToGoalResolutionMs`, `timeToReadinessMs`: 12/20.
- `timeToFirstMutationMs`: 11/20.
- `verificationWallMs`: 12/20.
- `reviewQueueMs`, `reviewWallMs`: 3/20.
- Verification receipt는 20/20에서 존재한다.
- `replanCount`, `interventionCount`, `mutationRevision`은 20/20에서 관측된다.

따라서 W3는 다음 원칙으로 진행해야 한다.

1. Context 비용 Pareto 순위는 만들지 않는다. W1 이후 실제 completed run이 쌓일 때까지 `insufficient-evidence`다.
2. Provider token 비용을 전체 표본의 대표값처럼 사용하지 않는다.
3. Action/Verification 분석은 coverage가 있는 run만 사용하고 분모를 항상 함께 표시한다.
4. 긴 lifecycle timestamp는 active compute time으로 해석하지 않는다. pause/resume 기간이 포함될 수 있다.
5. 누락값을 0으로 대체하지 않는다.

## 표본 선택

선택 규칙:

- project: `path-ad34f90ddb7a2a17`
- state: `CLOSE`
- status: `completed`
- finalization_status: `completed`
- order: `updated_at DESC`
- limit: `20`

실제 수집 receipt: Moonremote operation `90abf063-1159-48c0-87fa-8cf5624dd9cf`.

| # | Run | Updated UTC | Mutation | Replan | Intervention | Attempts | Model turns | Verifications | Reviews |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | `run-1bec6e30-a181-496c-a59a-2173e5704ea4` | 2026-10-19 12:53 | 1 | 1 | 0 | 0 | 0 | 1 | 0 |
| 2 | `run-b6290dbe-873f-4af1-944a-0e612cfc453b` | 2026-10-19 12:39 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| 3 | `run-0075c9b5-807a-4edf-a0d4-c7d3a99f46ab` | 2026-10-19 12:30 | 1 | 1 | 0 | 0 | 0 | 1 | 0 |
| 4 | `run-21849b21-8b0d-4851-9007-705299c737d3` | 2026-10-18 13:24 | 1 | 1 | 0 | 0 | 0 | 1 | 0 |
| 5 | `run-e0401d0f-3a94-4061-9b7f-f459a52f9ba5` | 2026-10-12 13:54 | 1 | 0 | 0 | 0 | 0 | 4 | 0 |
| 6 | `run-6432a2c6-261b-4af4-8fab-12f0bf00c636` | 2026-10-11 21:50 | 12 | 0 | 5 | 0 | 0 | 36 | 0 |
| 7 | `run-a93f305a-c553-430b-9112-f16980cd3c10` | 2026-10-08 23:05 | 6 | 0 | 0 | 0 | 0 | 16 | 0 |
| 8 | `run-4b2515b2-21bf-4d89-8292-256d34351c22` | 2026-10-07 00:00 | 12 | 8 | 0 | 0 | 5 | 33 | 4 |
| 9 | `run-a9c7f860-6882-421b-96e1-a07b1f9010fd` | 2026-09-08 01:04 | 6 | 0 | 0 | 5 | 3 | 21 | 3 |
| 10 | `run-daa73560-c9cd-4f63-b151-77238beaffcd` | 2026-09-07 22:29 | 6 | 4 | 0 | 7 | 0 | 6 | 0 |
| 11 | `run-5e51e0dc-4e11-4598-bec6-27d82fe70f75` | 2026-09-06 12:21 | 6 | 0 | 0 | 8 | 1 | 11 | 1 |
| 12 | `run-structural-improvement-2026-09-05` | 2026-09-06 02:08 | 12 | 4 | 1 | 34 | 3 | 145 | 6 |
| 13 | `run-23f5592b-c1ed-423f-a2e0-f6886d0c8cab` | 2026-09-05 03:35 | 18 | 0 | 0 | 25 | 2 | 100 | 2 |
| 14 | `run-7532b519-0104-44ec-b2ad-96be288e8fa8` | 2026-09-04 08:58 | 1 | 0 | 0 | 2 | 0 | 8 | 0 |
| 15 | `run-e069ad65-f39f-4096-8fb9-30dd7cef9a86` | 2026-09-04 08:10 | 7 | 5 | 0 | 10 | 0 | 25 | 0 |
| 16 | `run-a27e5ebb-5438-41b8-9afb-8a4de758543f` | 2026-09-02 02:58 | 1 | 0 | 0 | 1 | 0 | 1 | 0 |
| 17 | `run-6fec6516-d040-49ba-be0e-b4376f22614a` | 2026-09-01 23:53 | 6 | 4 | 3 | 9 | 2 | 29 | 1 |
| 18 | `run-5a88349a-f35a-4e3c-9a48-330a0ade3845` | 2026-08-31 06:32 | 8 | 0 | 0 | 12 | 18 | 126 | 16 |
| 19 | `run-7bf90992-f6e7-4b4c-93b6-b29ef03776d7` | 2026-08-30 09:20 | 3 | 2 | 0 | 6 | 4 | 14 | 4 |
| 20 | `run-f1bed217-fe27-44ff-9128-ebec1c127c3a` | 2026-08-30 04:01 | 7 | 3 | 0 | 12 | 10 | 40 | 7 |

## Measurement coverage

| Metric | Coverage | W3 사용 판정 |
|---|---:|---|
| completed/finalized identity | 20/20 | 사용 가능 |
| mutation/replan/intervention | 20/20 | 사용 가능 |
| verification receipts | 20/20 | 사용 가능 |
| attempt ledger | 12/20 | 제한적 사용 |
| model usage receipt | 9/20 | 제한적 사용 |
| provider token counts | 1/20 | 비교 금지 |
| prompt footprint | 0/20 | `insufficient-evidence` |
| goal/readiness timestamps | 12/20 | 제한적 사용 |
| first-mutation timestamp | 11/20 | 제한적 사용 |
| verification wall timestamp | 12/20 | 제한적 사용 |
| review queue/wall timestamps | 3/20 | 비교 금지 |

## 해석 주의사항

표본에는 여러 Kernel 세대가 섞여 있다. 따라서 필드 누락은 비용이 0이라는 뜻이 아니라 당시 해당 telemetry가 아직 없거나 Host가 값을 보고하지 않았다는 뜻이다.

특히 최신 표본 중 하나는 `timeToFirstMutationMs`가 약 28.5억 ms로 관측됐다. 이는 run이 장기간 중단됐다가 재개된 lifecycle 시간을 포함할 수 있으므로 active implementation time으로 직접 사용하면 안 된다.

W1에서 추가한 prompt footprint는 기존 receipt를 역으로 복원하지 않는다. W3에서 Context 병목을 숫자로 순위화하려면 W1 이후 실제 Host dispatch가 포함된 completed run이 새로 필요하다.

## 런타임 DB 관찰

최초 read-only 수집은 성공했다. 이후 추가 coverage 질의와 SQLite backup 시도에서 `disk I/O error`가 발생했다.

이 W2에서는 해당 오류를 제품 결함으로 판정하지 않는다.

- 기존 수집 receipt는 exit 0으로 완전한 20개 표본을 반환했다.
- 저장소 working tree에는 영향이 없다.
- W2 완료를 위해 live DB를 추가로 반복 조회하지 않았다.
- 재현성과 원인 분석이 필요한 경우 별도 작업으로 분리한다.

## W2 완료 판정

`COMPLETE_WITH_PARTIAL_EVIDENCE`

표본 수 조건 10~20개는 충족했다. W3는 Context 비용을 제외하고, coverage가 충분한 Action/Verification 지표만 Pareto 후보로 사용해야 한다.
