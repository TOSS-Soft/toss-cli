---
policy: DATA
version: 1.0.0
status: ACTIVE
governance: 1.6.0
---

# Data Governance Policy

## DATA-001 — Data Classification
Project data MUST use:
- D0 Public/Non-sensitive
- D1 Internal
- D2 Personal/Confidential
- D3 Highly Sensitive/Secret

## DATA-002 — Data Minimization
Agents MUST access, process, and retain only the minimum data reasonably required.

## DATA-003 — Masking and Redaction
Sensitive evidence SHOULD use masking, redaction, aggregation, or pseudonymous identifiers where full values are unnecessary.

## DATA-004 — Production Data in Non-Production
Production personal/confidential data MUST NOT be copied into development/test by default. Synthetic or properly anonymized data SHOULD be used.

## DATA-005 — PDA-1 Aggregate / Metadata Read
Non-sensitive production metadata/aggregate information MAY be accessed under scoped least-privilege authority.

## DATA-006 — PDA-2 Sensitive Production Read
Sensitive production reads MUST have defined purpose, minimum scope, read-only access where possible, and must avoid unnecessary reproduction/disclosure.

## DATA-007 — PDA-3 Production Mutation
Production data mutation is a distinct high-authority action and MUST NOT occur under normal PM authority.

## DATA-008 — DATAFIX
Material production data remediation MUST use a reviewed and traceable DATAFIX record or approved equivalent.

## DATA-009 — Production Mutation Approval
Production data mutation requires explicit verified CEO approval unless governance defines narrower pre-approved recovery authority.

## DATA-010 — Recovery Before Mutation
Recovery feasibility MUST be evaluated before material production data mutation.

## DATA-011 — Sensitive Evidence
D2/D3 data MUST NOT be copied into ordinary project evidence when redacted/derived evidence is sufficient.

## DATA-012 — Sensitive Artifact Cleanup
Temporary sensitive debugging artifacts MUST be securely cleaned up when no longer required, subject to audit obligations.

## DATA-013 — Financial Integrity
Operations affecting balances, payments, tokens, financial records, or equivalent critical state MUST evaluate duplication, partial completion, ordering, retry behavior, reconciliation, and recovery.

## DATA-014 — Idempotency
Retryable state-changing operations MUST evaluate idempotency. Material duplicate-execution risk MUST have a verified control.

## DATA-015 — Destructive Data Operations
Bulk DELETE, irreversible transformation, balance correction, or equivalent destructive operations MUST receive risk-appropriate review and authorization.

## DATA-016 — Data Truth
Operational convenience MUST NOT justify silently changing historical data merely to make application state appear correct.
