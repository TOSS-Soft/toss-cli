---
policy: RELEASES
version: 1.0.0
status: ACTIVE
governance: 1.6.0
---

# Release and Production Delivery Policy

## REL-001 — Merge Is Not Deployment
Merge authorization and production deployment authorization are distinct.

## REL-002 — Delivery Lifecycle
`NOT_READY → READY_FOR_MERGE → MERGE_APPROVAL_REQUIRED → MERGED → POST_MERGE_VALIDATION → READY_FOR_RELEASE → RELEASE_APPROVAL_REQUIRED → RELEASED → READY_FOR_PRODUCTION → PRODUCTION_APPROVAL_REQUIRED → DEPLOYED → OBSERVATION → PRODUCTION_VERIFIED`

## REL-003 — Explicit Merge Authorization
Main-branch merge requires explicit verified CEO merge authorization. Generic code-review approval is insufficient.

## REL-004 — Squash Merge
Default merge strategy is Squash Merge. Resulting main commit SHOULD preserve Task/PR traceability.

## REL-005 — Post-Merge Full Validation
After every merge to `main`, the complete required test suite MUST run against resulting new `main` HEAD. Delivery MUST NOT advance while failing/unresolved.

## REL-006 — Release Record
Every production release MUST have a typed `REL-xxx` record.

## REL-007 — Semantic Versioning
Production releases MUST use MAJOR.MINOR.PATCH unless governance is amended.

## REL-008 — Release Manifest
Every production release candidate MUST have an immutable versioned Release Manifest.

## REL-009 — Approval Follows Artifact
Production approval MUST be scoped to exact approved Manifest/artifact identity.

## REL-010 — Release Freeze
Release Manifest MUST become frozen before production approval.

## REL-011 — Manifest Revision
Material scope/artifact/migration/infrastructure/feature plan changes MUST create a new Manifest Revision.

## REL-012 — Approval Invalidation
Material artifact or Manifest change invalidates prior production approval.

## REL-013 — Immutable Production Tag
Successful production release version tag MUST identify deployed immutable artifact and MUST NOT be silently moved.

## REL-014 — Pre-Deploy Check
PM MUST verify applicable pre-deploy evidence.

## REL-015 — Preflight Freshness
If material state changes between approval and deployment, affected preflight evidence MUST be reevaluated.

## REL-016 — Production Deployment Agent
Production deployment MUST be executed by appropriately authorized deployment/DevOps capability.

## REL-017 — Exact Deployment Artifact
Deployment agent MUST deploy only approved exact candidate artifact.

## REL-018 — Deployment Lock
Material production deployment SHOULD acquire a logical deployment lock.

## REL-019 — Risk-Based Change Window
LOW/MEDIUM releases MAY deploy after valid approval+preflight. HIGH/CRITICAL releases MUST use predefined production change window.

## REL-020 — Missed Change Window
Missed HIGH/CRITICAL window requires rescheduling and evidence-freshness evaluation.

## REL-021 — Production Change Collision
Conflicting deployment/migration/DATAFIX/infrastructure/config/feature activation MUST NOT execute uncontrolled in parallel.

## REL-022 — Rollout Classification
Use RLO-1 Full, RLO-2 Progressive, RLO-3 Internal/Allowlist First, RLO-4 Dark Deployment.

## REL-023 — High-Risk Rollout
HIGH/CRITICAL releases SHOULD use progressive/allowlist/dark rollout when technically reasonable.

## REL-024 — Pre-Approved Rollout Gates
Approved rollout plan MAY contain predefined progression gates; PM MAY continue stages when those gates are satisfied.

## REL-025 — Rollout Plan Change
Material change to approved rollout plan requires renewed authority.

## REL-026 — Production Feature-Change Classification
Use PFC-1 Pre-Approved Rollout Action, PFC-2 Operational Adjustment, PFC-3 New Product Behavior Activation.

## REL-027 — PFC-1
PFC-1 MAY execute within approved rollout plan.

## REL-028 — PFC-2
PFC-2 MAY be coordinated by PM when within approved operational authority and no new product intent is created.

## REL-029 — PFC-3
PFC-3 requires explicit verified CEO production approval.

## REL-030 — Emergency Kill Switch
Approved emergency kill switch MAY be used during qualifying Emergency Containment. Re-enable returns to normal governance.

## REL-031 — Production Configuration Classification
Use PCC-1 Pre-Approved/Routine, PCC-2 Material Operational Change, PCC-3 Critical/Security/Product Behavior.

## REL-032 — PCC-1
PCC-1 MAY execute within approved runbook or release scope.

## REL-033 — PCC-2
PCC-2 requires specialist impact analysis, previous-state capture, rollback, traceability, and post-change verification.

## REL-034 — PCC-3
PCC-3 requires explicit verified CEO production approval.

## REL-035 — Config as Code
Production config SHOULD be managed through traceable config-as-code where practical.

## REL-036 — Secret-Safe Config Audit
Audit records MUST identify secret-related changes without recording secret values.

## REL-037 — Deployment Does Not Equal Verification
Deployment tool success MUST NOT automatically establish PRODUCTION_VERIFIED.

## REL-038 — Post-Deployment Verification
Post-deploy verification MUST evaluate applicable smoke, critical journeys, migrations, health, logs, error rates, latency, queues, and integrations.

## REL-039 — Observation Window
Production releases MUST use risk-appropriate observation where immediate checks are insufficient.

## REL-040 — Observation Criteria
Observation criteria SHOULD be defined before deployment for material releases.

## REL-041 — Observation Failure
Material observation failure MUST trigger evaluation of rollback, roll-forward, feature disable, config mitigation, or containment.

## REL-042 — PRODUCTION_VERIFIED
A release may be marked PRODUCTION_VERIFIED only when applicable post-deploy/observation requirements are VERIFIED.

## REL-043 — Deployment Failure
Failed deployment MUST be analyzed before retry/rollback. Determine UNCHANGED, PARTIALLY_DEPLOYED, DEPLOYED_BUT_UNHEALTHY, or UNKNOWN.

## REL-044 — Partial Deployment
PARTIALLY_DEPLOYED MUST be explicit. Retry MUST wait until actual production state is sufficiently understood.

## REL-045 — Rollback Plan
Material production deployment SHOULD define rollback trigger, target, method, and limitations.

## REL-046 — Pre-Authorized Rollback
If CEO production approval includes exact verified rollback plan, PM MAY coordinate it when documented trigger occurs.

## REL-047 — Rollback Safety
Rollback MUST NOT be assumed safe; schema/data/infrastructure/external side effects/flags/config must be evaluated.

## REL-048 — Irreversible Migration
If logical rollback unavailable, actual recovery mechanism MUST be stated truthfully.

## REL-049 — Emergency Rollback
During qualifying incident, PM MAY coordinate previously verified safe rollback under Emergency Containment.

## REL-050 — Release Provenance
PM MUST be able to establish `Production → REL → Artifact → Build → Main SHA → PR → Task → Objective`.

## REL-051 — Development Branch Completion
After required technical verification and review, development-branch conclusion
MUST use `superpowers:finishing-a-development-branch`.

Its output MAY propose merge, pull request, retention, or cleanup actions. It
MUST NOT grant merge, release, deployment, rollout, or production authority.
All existing TOSS approval, exact-artifact, manifest, and production gates
remain binding.
