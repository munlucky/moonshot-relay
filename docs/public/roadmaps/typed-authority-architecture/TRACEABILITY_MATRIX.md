# 요구사항 추적표

각 Evidence Path는 현재 baseline에서 존재하는 근거다. 미래의 통과 근거는 VERIFICATION의 V 신호에 연결한다.

| Requirement ID | ASR ID | Scenario ID | ADR ID | Spec Delta ID | Task ID | Owner | Evidence Path | Verification Signal |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| REQ-001 | ASR-001 | QAS-001 | ADR-0001 | DELTA-001 | TASK-001 | Architecture | src/kernel/state-store.mjs | V01 |
| REQ-002 | ASR-002 | QAS-002 | ADR-0002 | DELTA-002 | TASK-002 | Build | tsconfig.json | V02 |
| REQ-003 | ASR-003 | QAS-003 | ADR-0004 | DELTA-003 | TASK-003 | Work | src/kernel/run/work-cursor.mjs | V03 |
| REQ-004 | ASR-004 | QAS-004 | ADR-0001 | DELTA-004 | TASK-004 | Trust | src/kernel/proof/trust-authority.mjs | V04 |
| REQ-005 | ASR-005 | QAS-005 | ADR-0002 | DELTA-005 | TASK-005 | Knowledge | src/kernel/knowledge/knowledge-authority.mjs | V05 |
| REQ-006 | ASR-006 | QAS-006 | ADR-0001 | DELTA-006 | TASK-006 | Host | src/host/kernel/turn-dispatcher.mjs | V06 |
| REQ-007 | ASR-007 | QAS-007 | ADR-0004 | DELTA-007 | TASK-007 | Architecture | src/kernel/control-plane.mjs | V07 |
| REQ-008 | ASR-008 | QAS-008 | ADR-0003 | DELTA-008 | TASK-008 | Delivery | src/kernel/installer.mjs | V08 |
| REQ-009 | ASR-009 | QAS-009 | ADR-0004 | DELTA-009 | TASK-009 | Developer Experience | tools/build/source-graph.mjs | V09 |
| REQ-010 | ASR-010 | QAS-010 | ADR-0003 | DELTA-010 | TASK-010 | Delivery | .github/workflows/ci.yml | V10 |
