# Delivery Policy

## Profile Scope

This optional profile governs delivery records and operational coordination.
It does not grant release, deployment, rollout, or production authority.

## Merge vs Deployment

Merge approval and deployment approval are distinct decisions. A merge does not
authorize deployment, and a deployment decision does not revise merge evidence.

## Explicit Merge Authority

Record the authority, candidate, and conditions for every merge decision.

## Exact Artifact

Identify the immutable artifact, source revision, build provenance, and target
environment before a delivery decision.

## Required Validation

Record applicable validation, outcomes, inputs, and any unresolved limits.

## Release Record

Create and retain a RELEASE record for each release candidate and final state.

## Manifest Freeze

Freeze the release manifest before approval. Any material change creates a new
candidate and requires fresh evidence.

## Approval Invalidation

Invalidate approval when the artifact, scope, environment, validation, or
manifest changes materially.

## Deployment Authority

Deployment requires explicit recorded authority independent of merge approval.

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
and final outcome in the release record.

## Provenance

Preserve links between the artifact, source revision, validations, approvals,
operators, and records.
