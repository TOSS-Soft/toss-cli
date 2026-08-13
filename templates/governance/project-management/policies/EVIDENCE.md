---
policy: EVIDENCE
version: 1.0.0
status: ACTIVE
governance: 1.6.0
---

# Evidence Policy

## EVID-001 — Evidence States
Canonical states are `CLAIMED`, `EVIDENCED`, `VERIFIED`, and `UNKNOWN`.

## EVID-002 — No Unsupported Promotion
A claim MUST NOT advance to EVIDENCED without evidence. An evidenced claim MUST NOT advance to VERIFIED without required validation.

## EVID-003 — Exact Artifact Identity
Evidence MUST identify the artifact/state to which it applies when identity is material.

## EVID-004 — Evidence Applicability
The PM MUST determine whether evidence is applicable to the current candidate state.

## EVID-005 — Evidence Freshness
Time-sensitive evidence MUST be sufficiently fresh for the action it supports.

## EVID-006 — Negative Claims
Claims such as NO IMPACT, NO SECURITY ISSUE, NO BREAKING CHANGE, NO DATA IMPACT, or NO COST IMPACT MUST have sufficient basis when material.

## EVID-007 — UNKNOWN Is Explicit
When sufficient evidence does not exist, the state MUST remain UNKNOWN.

## EVID-008 — Evidence Conflict
When credible evidence materially conflicts, the PM MUST investigate before relying on the favorable result.

## EVID-009 — Original Evidence Integrity
Original machine-generated evidence MUST NOT be altered to improve apparent result.

## EVID-010 — Failure Preservation
A later successful run MUST NOT erase prior relevant failures.

## EVID-011 — Evidence Provenance
Material evidence SHOULD identify source, timestamp, environment, artifact identity, producer, and relevant command/workflow.

## EVID-012 — Verification Independence
Where risk requires independent verification, implementer-only evidence MUST NOT be the sole basis.

## EVID-013 — Audit Identity
Material operational actions SHOULD distinguish AUTHORITY, COORDINATOR, EXECUTOR, and VERIFIER.

## EVID-014 — Evidence Retention
Evidence MUST be classified as ER1 Permanent/Audit, ER2 Lifecycle, ER3 Ephemeral, or ER4 Sensitive Ephemeral.

## EVID-015 — Audit History
Permanent audit history MUST NOT be deleted merely to simplify state. Corrections MUST preserve historical truth.
