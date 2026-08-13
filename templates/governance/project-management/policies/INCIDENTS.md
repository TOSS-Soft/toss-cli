---
policy: INCIDENTS
version: 1.0.0
status: ACTIVE
governance: 1.6.0
---

# Incident Management Policy

## INC-001 — Incident Definition
An Incident is an active operational event materially affecting/threatening production availability, security, data integrity, financial integrity, or critical user functionality.

## INC-002 — Severity
Use:
- SEV-1 CRITICAL
- SEV-2 HIGH
- SEV-3 MEDIUM
- SEV-4 LOW

## INC-003 — SEV-1
SEV-1 includes major outage, active security compromise, material data loss/corruption, severe ongoing financial risk, or widespread critical-user impact. Immediate CEO notification required.

## INC-004 — SEV-2
SEV-2 represents substantial production degradation/high impact without SEV-1 severity. PM MUST begin coordination immediately and provide timely CEO visibility.

## INC-005 — SEV-3 / SEV-4
SEV-3/4 MAY be handled through normal PM exception-based reporting unless another approval gate applies.

## INC-006 — PM Incident Coordinator
PM becomes Incident Coordinator unless governance explicitly assigns another coordinator. PM coordinates specialists and MUST NOT perform specialist implementation.

## INC-007 — Incident Priority
1. protect security/data/financial integrity
2. stop/limit ongoing harm
3. restore safe service
4. verify recovery
5. determine root cause
6. implement permanent correction
7. complete post-incident review

## INC-008 — Incident Lifecycle
`DETECTED → TRIAGED → MITIGATING → STABILIZED → MONITORING → RESOLVED → POST_INCIDENT_REVIEW → CLOSED`

## INC-009 — STABILIZED Is Not RESOLVED
Containment or temporary mitigation MUST NOT be represented as permanent resolution.

## INC-010 — Recovery Verification
Incident MUST NOT be RESOLVED until required recovery evidence is VERIFIED.

## INC-011 — Emergency Containment Authority
PM MAY coordinate limited Emergency Containment only when:
1. active/imminent critical harm exists;
2. waiting for normal approval materially increases harm;
3. action is containment, not new product development;
4. action is least-destructive reasonable option;
5. evidence is preserved where possible;
6. action remains within Emergency Deny List.

## INC-012 — Emergency Containment Examples
Permitted examples may include disabling affected feature, approved kill switch, approved failover, verified rollback, compromised credential revocation, approved read-only/safe mode. Examples are non-normative.

## INC-013 — Emergency Deny List
Emergency Containment MUST NOT independently authorize:
- production database DROP;
- backup deletion;
- audit-log destruction;
- destructive Git history rewrite;
- main force push;
- treasury/mainnet fund transfer to arbitrary wallet;
- unreviewed production DATAFIX;
- unknown/untested destructive scripts;
- permanent removal of required security controls.

## INC-014 — Evidence Preservation
Responders SHOULD preserve relevant logs, timestamps, artifacts, configuration state, deployment identity, and security evidence where preservation does not materially worsen harm.

## INC-015 — CEO Communication
SEV-1 communication MUST be immediate and concise. Initial report SHOULD include impact, severity, containment, known/unknown cause, and material CEO decision required.

## INC-016 — Public Communication
Incident findings do not authorize public company statements. Public/customer-facing statements remain subject to external-communication authority.

## INC-017 — Bug Relationship
A Bug represents a defect. An Incident represents active operational event. They are not interchangeable.

## INC-018 — Corrective Work
Temporary containment SHOULD produce traceable permanent corrective work when root cause remains unresolved.

## INC-019 — Mandatory Review
SEV-1 and SEV-2 MUST receive Post-Incident Review.

## INC-020 — Non-Blaming Review
Review SHOULD focus on system/process improvement while preserving factual accountability.

## INC-021 — Governance Gap
Incident may produce `GOV-xxx` proposal. Incident itself MUST NOT silently modify governance.

## INC-022 — Production Data Mutation During Incident
Incident does not automatically authorize ad-hoc production data mutation. Pre-approved verified recovery runbook MAY be used when conditions apply.
