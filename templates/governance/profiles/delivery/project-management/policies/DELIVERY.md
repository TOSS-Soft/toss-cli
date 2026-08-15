# Delivery Policy

## Profile Scope

This optional profile governs delivery records and operational coordination.
It does not grant release, deployment, rollout, or production authority.

## Merge vs Deployment

Code review, merge authorization, release approval, production deployment
authorization, and rollout authority are distinct. None may be inferred from
another. A merge does not authorize deployment, and a deployment decision does
not revise merge evidence.

## Explicit Merge Authority

Main-branch merge requires explicit verified CEO merge authorization for the
exact candidate and conditions. Generic code-review approval is insufficient
and does not grant merge authority.

## Exact Artifact

Identify the immutable artifact, source revision, build provenance, and target
environment before a delivery decision.

## Required Validation

Record applicable validation, outcomes, inputs, and any unresolved limits.

## Risk-Based Delivery Security Review

Classify the delivery security impact of every candidate and require review
depth proportional to risk. HIGH and CRITICAL security-impact changes require
independent security review before merge or deployment. The review MUST be
performed by a qualified reviewer independent of the implementation under
review, and every material finding requires a recorded disposition and fresh
evidence for the exact candidate.

## Release Record

Create and retain a RELEASE record for each release candidate and final state.

## Manifest Freeze

Freeze the release manifest before approval. Any material change creates a new
candidate and requires fresh evidence.

## Approval Invalidation

Invalidate approval when the artifact, scope, environment, validation, or
manifest changes materially.

## Deployment Authority

Production deployment requires explicit verified CEO deployment authorization
for the exact artifact, environment, rollout, and conditions. An authorized
operator executes that decision but does not acquire approval authority.

## Change Windows

Respect recorded change windows and document an authorized exception.

## Infrastructure Preview

Review the exact infrastructure change and target before execution.

## Configuration Safety

Identify configuration changes, protected values, rollback steps, and the
responsible operator before execution.

## Rollout

Record rollout stages, gates, owners, and stop conditions.

## Observation

Observe the agreed signals for the stated period and record the result.

## Rollback

Keep an executable rollback plan, decision threshold, responsible authority,
and final outcome in the release record. Verified CEO production authorization
MAY pre-authorize the exact reviewed rollback plan for its documented trigger;
that narrow recovery authority does not authorize another artifact, rollout,
or production-data mutation.

## Provenance

Preserve links between the artifact, source revision, validations, approvals,
operators, and records.
