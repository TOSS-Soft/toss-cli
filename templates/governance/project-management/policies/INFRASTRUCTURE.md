---
policy: INFRASTRUCTURE
version: 1.0.0
status: ACTIVE
governance: 1.6.0
---

# Infrastructure Policy

## INFRA-001 — IaC First
Material infrastructure state SHOULD be represented through Infrastructure as Code where technically reasonable.

## INFRA-002 — Infrastructure Classification
Material changes MUST be classified:
- I1 Low Impact
- I2 Material Infrastructure Change
- I3 Strategic / Production / Destructive

## INFRA-003 — I1
I1 changes MAY be managed by PM within approved architecture and Task scope.

## INFRA-004 — I2
I2 changes MUST receive infrastructure review, impact analysis, plan/diff evidence where supported, recovery consideration, and environment validation.

## INFRA-005 — I3
I3 changes require applicable CEO approval before execution.

## INFRA-006 — Plan Before Apply
Where supported, plan/preview/dry-run MUST be obtained before material apply.

## INFRA-007 — Unexpected Plan
Unexpected destructive/material plan output MUST block execution until analyzed.

## INFRA-008 — Production Identity Verification
Before material production infrastructure action, actual target environment MUST be verified. Labels alone are insufficient.

## INFRA-009 — Environment Separation
LOCAL, DEVELOPMENT, STAGING, and PRODUCTION are distinct authority domains.

## INFRA-010 — Production Write Session
Material production write access SHOULD be scoped and temporary.

## INFRA-011 — Destructive Command Boundary
Destructive infrastructure operations require explicit target, scope, environment, expected impact, authority, and recovery path.

## INFRA-012 — Drift Detection
Material differences between declared and actual infrastructure state MUST be treated as drift and MUST NOT be silently overwritten.

## INFRA-013 — DRIFT Record
Material drift SHOULD create a `DRIFT-xxx` record.

## INFRA-014 — Manual Change Reconciliation
Material manual infrastructure changes MUST be reconciled into declared configuration or explicitly reverted.

## INFRA-015 — Protected Validation Infrastructure
CI/CD workflows, validation scripts, scanners, test runners, coverage config, and deployment workflows are protected validation infrastructure and MUST NOT be weakened solely to make a Task pass.

## INFRA-016 — CI Change Review
Material CI/CD changes MUST evaluate checks, permissions, secrets, coverage, failure behavior, and deployment capability.

## INFRA-017 — Backup Classification
Backups SHOULD be classified B1 Operational, B2 Critical Data, or B3 Pre-Change Safety Backup.

## INFRA-018 — Backup Is Not Recovery
Backup existence does not prove recoverability. Restore capability matters.

## INFRA-019 — Backup Before Destructive Change
Where required, backup MUST be VERIFIED before execution.

## INFRA-020 — Disaster Recovery
Critical systems SHOULD define appropriate disaster-recovery capabilities.

## INFRA-021 — DR Evidence
DR testing SHOULD capture scenario, environment, procedure, measured RTO/RPO, result, gaps, and corrective work.

## INFRA-022 — External Service Failure
Critical third-party dependencies SHOULD evaluate timeout, bounded retry, backoff, idempotency, failure isolation, observability, and fallback where appropriate.

## INFRA-023 — Vendor Switching
Provider outage MUST NOT authorize an unapproved strategic vendor change.

## INFRA-024 — Cost Impact
Material infrastructure/runtime changes MUST classify cost impact: NONE, NEGLIGIBLE, LOW, MEDIUM, HIGH, UNKNOWN.

## INFRA-025 — Material Cost Escalation
HIGH, UNKNOWN, or materially recurring cost impact MUST be escalated for CEO decision when not already covered.

## INFRA-026 — Unknown Infrastructure State
Material unknown infrastructure state MUST be represented as UNKNOWN and MAY block further production change.

## INFRA-027 — Retry Governance
Retry MUST be explicitly safe. Retry policy SHOULD define max attempts, timeout, backoff, idempotency, final failure destination, and observability.

## INFRA-028 — Asynchronous Processing
Material async processing MUST evaluate duplicate delivery, lost processing, poison messages, retry exhaustion, ordering, dead-letter handling, and observability.

## INFRA-029 — External Side Effects
Tests MUST NOT generate unintended real-world production side effects. Sandbox/testnet/mock SHOULD be used where available.

## INFRA-030 — Generated Artifacts
Generated output MUST remain traceable to canonical source/generator.

## INFRA-031 — Repository Hygiene
Repositories MUST NOT intentionally contain unauthorized credentials, production dumps, temporary sensitive logs, local caches, or unintended build output.
