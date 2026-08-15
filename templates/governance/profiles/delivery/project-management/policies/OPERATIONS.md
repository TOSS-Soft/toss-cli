# Operations Policy

## Data Classification

Classify data before access or mutation and apply the protections appropriate
to its recorded class.

## Datafix Authority

Production data mutation requires explicit verified CEO approval unless the
applicable governance already records narrower pre-authorized recovery
authority. That exception MUST name the exact scope, trigger, executor, stop
conditions, and recovery procedure, and it MUST NOT authorize unrelated
mutation or new product intent. Technical access alone is not authority.

Production-data mutation authority is distinct from code review, merge,
deployment, rollout, incident coordination, containment, and recovery
execution; none may be inferred from another.

## Dry Run

Perform and record a dry run when feasible before a datafix.

## Backup/Recovery

Identify backup, recovery procedure, owner, and verification before mutation.

## Incident Definition and Severity

An incident is an event requiring coordinated response to protect users,
services, data, or commitments. Record the severity, impact, and basis.

## Containment

Contain harm first while preserving evidence and recording actions taken.

## Evidence Preservation

Preserve relevant logs, timelines, artifacts, and decisions without altering
their provenance.

## Stabilization vs Resolution

Stabilization restores acceptable operation; resolution addresses the cause.
Record them separately.

## Post-Incident Review

After closure, review the incident record, evidence, decisions, and remaining
risks.

## Corrective Work

Track corrective work with ownership, acceptance conditions, and follow-up
evidence.
