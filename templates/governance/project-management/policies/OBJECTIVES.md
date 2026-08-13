---
policy: OBJECTIVES
version: 1.0.0
status: ACTIVE
governance: 1.6.0
---

# Objective Management Policy

## OBJ-001 — Objective Required
Every verified CEO implementation intent MUST be traceable to an Objective. Trivial work MAY use a lightweight Objective representation.

## OBJ-002 — Preserve Intent
The PM MUST preserve verified CEO intent and MUST NOT silently expand, narrow, replace, or reinterpret it into a different product requirement.

## OBJ-003 — Objective Classification
Objectives MUST be classified as `TRIVIAL`, `STANDARD`, `COMPLEX`, or `CRITICAL`.

## OBJ-004 — Objective Baseline
Before material execution, the PM MUST establish sufficient baseline information for intent, expected outcome, known scope, constraints, and acceptance conditions.

## OBJ-005 — Adaptive Depth
Governance ceremony MUST be proportionate to complexity and risk. Required controls MUST NOT be removed merely because an Objective is small.

## OBJ-006 — Delegated Planning
Once sufficiently understood, the PM MAY decompose work, create Epics/Tasks, establish dependencies, select agents, and determine execution order without separate CEO planning approval.

## OBJ-007 — Execution Brief
COMPLEX and CRITICAL Objectives MUST receive a concise informational Execution Brief before material implementation.

## OBJ-008 — Intent Ambiguity
A3 ambiguity affecting product behavior, business rules, irreversible strategic direction, or material external commitment MUST be resolved by verified CEO decision. The PM MUST NOT guess.

## OBJ-009 — Objective Acceptance
Acceptance MUST describe observable outcomes rather than activity.

## OBJ-010 — Objective Completion
An Objective MUST NOT be marked COMPLETED solely because all associated Tasks are DONE.

## OBJ-011 — Production-Dependent Objectives
If acceptance requires production behavior, completion MUST wait for required `PRODUCTION_VERIFIED` evidence.

## OBJ-012 — Objective Reopen
A completed Objective MUST be REOPENED when material evidence shows its original acceptance is no longer satisfied due to defect/regression.

## OBJ-013 — New Requirement
A new CEO requirement MUST NOT be disguised as regression against an old Objective.

## OBJ-014 — Objective Cancellation
Cancellation MUST preserve historical traceability.

## OBJ-015 — Closure Report
Completed non-trivial Objectives MUST have a closure record covering verified outcome, acceptance, production state, unresolved risks, waivers, follow-up work, and material CEO decisions.
