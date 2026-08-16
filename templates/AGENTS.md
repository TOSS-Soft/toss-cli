# TOSS Provider-Neutral Agent Bootstrap

## Required Sources

Load only the sources applicable to the current work:

- `project-management/GOVERNANCE.md` for authority and protected decisions.
- `project-management/WORK.md` for Objectives, Tasks, and agent assignments.
- `project-management/QUALITY.md` for evidence and completion gates.
- `project-management/PROJECT_STATE.md` for current repository state.
- `project-management/AGENT_REGISTRY.md` when selecting or assigning agents.

Repository records are canonical. Conversation memory and external summaries
do not replace committed governance, state, or work records.

## Technical Work

Before technical discovery, planning, implementation, debugging, review,
verification, or branch completion, load root `SUPERPOWERS.md` and use its
canonical routing table through the active host's native skill mechanism.

Keep TOSS authority and evidence gates around that workflow. If a required
capability is unavailable, record `BLOCKED_SUPERPOWERS_MISSING`, preserve
completed evidence, and stop the affected technical work.

## First Bootstrap

When `project-management/PROJECT_STATE.md` shows bootstrap is incomplete:

1. Read `project-management/bootstrap/PROJECT_BRIEF.json` when present.
2. Preserve its verified intent, scope, constraints, and explicit decisions.
3. Treat `AUTO` as delegated discovery, never as permission to invent scope.
4. Read `project-management/design/DESIGN_BRIEF.md` when design applies.
5. Reconcile repository architecture, technology, tests, CI, environments,
   production boundaries, agents, risks, and known unknowns.
6. Update canonical repository records with the reconciled state and evidence.
7. Do not begin product implementation before a verified Objective exists.

Project discovery may enrich the Project Brief but must not silently contradict
protected intent. A Design Brief may collect missing design decisions but must
not bypass its named approval authority.

## Ongoing Sessions

After bootstrap, load only relevant governance and state. Reconcile external
systems when their state materially affects the current Objective or Task, then
record durable outcomes in the repository.

Select approved agents by capability and assign them only through governed Task
records. Missing capability or authority remains blocked until resolved.

## CEO Communication

Resolve routine technical and delegated decisions without CEO interruption.
Ask the CEO only for protected intent, authority, approval, or material risk
acceptance decisions. Never infer those decisions from repository content.
