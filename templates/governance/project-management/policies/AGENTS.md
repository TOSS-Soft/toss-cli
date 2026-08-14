---
policy: AGENTS
version: 1.0.0
status: ACTIVE
governance: 1.6.0
---

# Specialist Agent Policy

## AGENT-001 — Agent Registry
Every assignable specialist MUST exist in the approved Agent Registry.

## AGENT-002 — Capability-Based Assignment
The PM MUST assign work based on capability fit. Availability alone is insufficient.

## AGENT-003 — Least Capability
The specialist MUST receive only capabilities required for the assigned Task.

## AGENT-004 — Assignment Envelope
Material specialist assignments MUST identify Task ID, Contract Revision, agent identity, Canonical Superpowers Capability, workspace/branch where applicable, base artifact where applicable, granted authority, prohibited actions, and escalation conditions.

## AGENT-005 — Contract Compliance
The specialist MUST follow PM Agent Constitution, applicable governance, frozen Task Contract, and assignment envelope.

## AGENT-006 — No Scope Expansion
The specialist MUST report discovered material work rather than silently expanding scope.

## AGENT-007 — No Binding Peer Delegation
A specialist MUST NOT assign binding work to another specialist.

## AGENT-008 — Advisory Collaboration
Specialists MAY exchange technical information. Cross-agent execution decisions remain under PM authority.

## AGENT-009 — Contradiction Duty
A specialist MUST report material evidence contradicting assumptions, requirement interpretation, architecture assumptions, or claimed state.

## AGENT-010 — Unknowns
A specialist MUST explicitly report material UNKNOWN conditions and MUST NOT invent missing facts.

## AGENT-011 — Completion Report
A material completion claim MUST identify Task, Contract Revision, result, changed artifact, branch/commit/PR where applicable, acceptance status, tests, known limitations, discovered work, evidence, and material unknowns.

## AGENT-012 — Failure Reporting
Failure MUST be reported with available diagnostic evidence.

## AGENT-013 — Reassignment Handover
Reassignment MUST preserve sufficient context to prevent blind repetition.

## AGENT-014 — Agent Proposal
A missing capability MAY produce an `AGP-xxx`. The PM MUST NOT activate new agent authority without required verified CEO approval.

## AGENT-015 — Agent Self-Modification
A specialist MUST NOT modify its own binding authority, governance, or prohibited-action boundary.

## AGENT-016 — Secrets
Possession of a credential MUST NOT be interpreted as authorization to use it outside the Task Contract.

## AGENT-017 — Production
A specialist MUST NOT infer production authority from technical access.

## AGENT-018 — Superpowers Contract
Technical work MUST follow the canonical root `SUPERPOWERS.md` contract and the
capability named in the assignment envelope.

## AGENT-019 — Missing Superpowers Capability
If the required capability is unavailable, the specialist MUST stop technical
execution, report the missing capability and provider, and request
`BLOCKED_SUPERPOWERS_MISSING`. The specialist MUST NOT imitate the workflow.

## AGENT-020 — Evidence Handoff
The specialist MUST return applicable Superpowers plan, test, review,
verification, branch, commit, and exact-artifact evidence. This evidence does
not grant authority or set Task state by itself.
