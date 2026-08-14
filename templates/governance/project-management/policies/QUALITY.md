---
policy: QUALITY
version: 1.0.0
status: ACTIVE
governance: 1.6.0
---

# Quality and Verification Policy

## QUAL-001 — Risk-Based Validation
Validation depth MUST be proportional to change impact and risk.

## QUAL-002 — Applicable Test Types
The PM MUST evaluate applicability of unit, integration, contract, regression, E2E, migration, security, performance, and smoke tests.

## QUAL-003 — Exact Candidate
Required validation MUST apply to the candidate artifact intended for merge, release, or completion.

## QUAL-004 — Required Tests
Required tests MUST PASS before the corresponding quality gate may be satisfied.

## QUAL-005 — Test Failure Classification
Material failures MUST be classified:
- TF1 Product/Code Defect
- TF2 Test Defect
- TF3 Environment/Infrastructure Failure
- TF4 Flaky/Non-Deterministic
- TF5 Contract/Requirement Conflict
- TF6 Unknown

## QUAL-006 — No Rerun Until Green
Repeated execution MUST NOT be used to hide unexplained failures.

## QUAL-007 — Controlled Test Modification
A failing test MUST NOT be removed or weakened solely because implementation does not satisfy it.

## QUAL-008 — Flaky Tests
Material flakiness MUST be recorded and investigated.

## QUAL-009 — Independent Review
Independent review MUST be used where required by risk.

## QUAL-010 — Review Findings
Findings MUST use `BLOCKER`, `CRITICAL`, `MAJOR`, `MINOR`, `NIT`.

## QUAL-011 — Finding Lifecycle
Finding states are `OPEN`, `FIXED`, `VERIFIED`, `ACCEPTED_BY_WAIVER`. `FIXED` MUST NOT be treated as `VERIFIED`.

## QUAL-012 — BLOCKER
An OPEN BLOCKER prevents READY_FOR_MERGE and DONE.

## QUAL-013 — CRITICAL
An unresolved CRITICAL finding MUST NOT be silently deferred.

## QUAL-014 — Regression Protection
A defect affecting previously verified behavior SHOULD produce regression protection.

## QUAL-015 — Performance Impact
Material performance-sensitive changes MUST define appropriate performance validation.

## QUAL-016 — Observability Impact
Changes affecting critical runtime behavior MUST evaluate logs, metrics, traces, alerts, and operational visibility.

## QUAL-017 — Documentation Impact
Documentation MUST be updated when change materially affects public behavior, developer integration, operations, configuration, recovery, or architecture understanding.

## QUAL-018 — Compatibility
Backward compatibility MUST be evaluated where applicable. Breaking behavior MUST NOT be introduced silently.

## QUAL-019 — Review After Change
Material code changes after review MAY invalidate prior review. Re-review applicability MUST be evaluated.

## QUAL-020 — Validation System Failure
If a mandatory validation system cannot produce a trustworthy result, the gate MUST remain UNKNOWN or BLOCKED.

## QUAL-021 — Test-Driven Implementation
Feature and bug-fix implementation MUST use
`superpowers:test-driven-development`. Resulting tests remain subject to exact
candidate, applicability, and trustworthiness requirements in this policy.

## QUAL-022 — Systematic Debugging
Unexpected behavior, test failure, or unexplained validation failure MUST use
`superpowers:systematic-debugging` before a fix or retry is accepted.

## QUAL-023 — Completion Verification
A completion claim MUST include fresh evidence produced under
`superpowers:verification-before-completion`. The PM still determines whether
the governed gate is VERIFIED.

## QUAL-024 — Code Review Workflow
Work ready for review MUST use `superpowers:requesting-code-review`; received
review feedback MUST use `superpowers:receiving-code-review`. Finding severity,
lifecycle, waiver, and re-review rules remain governed by this policy.

## QUAL-025 — Superpowers Availability
If a required quality capability cannot run or cannot produce trustworthy
evidence, the corresponding gate remains UNKNOWN or BLOCKED and the Task uses
`BLOCKED_SUPERPOWERS_MISSING` when the capability itself is absent.
