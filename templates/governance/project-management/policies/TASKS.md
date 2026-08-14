---
policy: TASKS
version: 1.0.0
status: ACTIVE
governance: 1.6.0
---

# Task Execution Policy

## TASK-001 — Task Contract Required
Specialist implementation MUST operate under a Task Contract.

## TASK-002 — Readiness Gate
A Task MUST NOT enter READY unless the PM can determine parent Objective, required outcome, sufficient scope, acceptance criteria, known dependencies, applicable governance, and suitable specialist capability.

## TASK-003 — Contract Revision
Every assigned Task MUST have an explicit Contract Revision.

## TASK-004 — Contract Freeze
When implementation begins, the active Contract Revision becomes FROZEN. The specialist MUST NOT modify it.

## TASK-005 — In Scope
The specialist MAY perform work reasonably necessary to satisfy the frozen Task Contract.

## TASK-006 — Out of Scope
The specialist MUST NOT perform unrelated improvements merely because they are convenient while editing the same system.

## TASK-007 — Incidental Implementation
Minor implementation details inherently necessary to satisfy the contract MAY be performed without a Change Request.

## TASK-008 — Discovered Work
Material newly discovered work MUST be reported to the PM and MUST NOT be silently absorbed into the Task.

## TASK-009 — Change Request
A material change to a frozen Task Contract MUST use `CR-xxx` and a new Contract Revision.

## TASK-010 — Acceptance Criteria
Acceptance Criteria MUST be sufficiently observable to permit verification.

## TASK-011 — Completion Claim
A specialist completion report is a claim and MUST NOT directly transition the Task to DONE.

## TASK-012 — PM-Only DONE Authority
Only the PM may set execution Tasks to `DONE` or `DONE_WITH_WAIVER`.

## TASK-013 — Global Definition of Done
Before DONE, all applicable requirements MUST be VERIFIED, including acceptance, required tests, required review, blocking findings, security, performance, migration, compatibility, observability, documentation, evidence, artifact identity, and approvals.

## TASK-014 — N/A
A DoD item MAY be marked N/A only with a reason.

## TASK-015 — Waived Completion
If a gate is bypassed through approved waiver, the Task MUST preserve the waiver reference and use `DONE_WITH_WAIVER` where completion integrity is affected.

## TASK-016 — BLOCKED
A Task MUST enter BLOCKED when execution cannot safely or legitimately continue without dependency resolution, required decision, missing authority, critical evidence, or external unblock.

## TASK-017 — REWORK
Failed review or validation requiring implementation changes SHOULD return the Task to REWORK.

## TASK-018 — Cancellation
Cancellation MUST preserve reason, historical work, relevant evidence, and related decisions.

## TASK-019 — Task Identity
Task IDs are immutable and MUST NOT be reused.

## TASK-020 — GitHub Project State
Operational Task status MUST use the canonical GitHub Project field. Issue prose MUST NOT silently override Project status.

## TASK-021 — Superpowers Execution
Once the frozen Task Contract authorizes technical work, execution MUST use the
matching capability in the canonical root `SUPERPOWERS.md`. TOSS Task policy
defines scope and state; it does not replace the capability's method.

## TASK-022 — Missing Superpowers Block
If a required capability is unavailable, the Task MUST enter
`BLOCKED_SUPERPOWERS_MISSING`. Completed discovery and governance evidence MUST
be preserved. No legacy TOSS execution fallback is permitted.

## TASK-023 — Superpowers Output Is Evidence
A Superpowers completion result is a specialist claim. `TASK-011`, `TASK-012`,
and the Global Definition of Done remain binding.
