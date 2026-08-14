# Provider-Neutral Superpowers Workflow Design

**Status:** APPROVED FOR PLANNING
**Date:** 2026-08-14
**Target:** TOSS CLI after v1.1.0

## Purpose

TOSS will stop defining its own software-development method. It will keep the
company, product, authority, evidence, and project-state layer while delegating
software-development execution to Superpowers.

The generated project must use one provider-neutral Superpowers contract. Host
bootstrap files may make that contract discoverable, but they must not contain
independent copies of the workflow.

## Decisions

1. Superpowers is a required execution dependency for product implementation,
   bug fixes, technical planning, review, verification, and branch completion.
2. TOSS does not provide a legacy development-process fallback.
3. Project discovery, Project Brief work, Design Brief work, governance, and
   CEO decision capture may continue when Superpowers is unavailable.
4. Product implementation and release work must enter
   `BLOCKED_SUPERPOWERS_MISSING` when the required Superpowers capability cannot
   be invoked.
5. The workflow is provider-neutral. The canonical rules must not depend on
   Claude Code, Codex, or another host's invocation syntax.
6. `CLAUDE.md` is retained only as a Claude Code discovery bridge. It imports
   `AGENTS.md` and contains no independent TOSS or Superpowers workflow.
7. `AGENTS.md` is the shared host bootstrap. It directs the active agent to the
   canonical `SUPERPOWERS.md` contract and the TOSS governance sources.
8. `SUPERPOWERS.md` is the single canonical software-development lifecycle
   contract generated at the project root.

## Responsibility Boundary

### TOSS owns

- verified CEO intent and protected decisions;
- Project Brief and Design Brief state;
- objectives, scope, constraints, and acceptance criteria;
- authority classification and approval gates;
- Task Contracts and specialist capability selection;
- project, risk, decision, incident, evidence, and release records;
- determining whether evidence satisfies the governed Definition of Done;
- production, rollout, and data-mutation authorization.

### Superpowers owns

- requirements discovery for creative or behavioral changes;
- implementation design and planning;
- isolated development workspace selection;
- test-driven implementation;
- systematic debugging;
- plan execution and supported subagent execution;
- code-review preparation and review-feedback processing;
- verification before completion claims;
- development-branch completion choices.

TOSS defines what must be authorized and proven. Superpowers defines how the
technical work is performed and how its evidence is produced.

## Canonical Skill Routing

| Trigger | Required Superpowers capability |
| --- | --- |
| Start of an agent session or skill-routing decision | `superpowers:using-superpowers` |
| New feature, creative work, or behavior change | `superpowers:brainstorming` |
| Approved design requiring an implementation plan | `superpowers:writing-plans` |
| Implementation workspace setup | `superpowers:using-git-worktrees` |
| Feature or bug-fix implementation | `superpowers:test-driven-development` |
| Unexpected behavior or test failure | `superpowers:systematic-debugging` |
| Approved plan execution with independent tasks | `superpowers:subagent-driven-development` |
| Approved plan execution without supported subagents | `superpowers:executing-plans` |
| Completion claim | `superpowers:verification-before-completion` |
| Work ready for review | `superpowers:requesting-code-review` |
| Review feedback received | `superpowers:receiving-code-review` |
| Verified development branch ready to conclude | `superpowers:finishing-a-development-branch` |
| Creating or changing reusable skills | `superpowers:writing-skills` |

`executing-plans` is the permitted Superpowers alternative when the active host
cannot run `subagent-driven-development`. It is not a TOSS process fallback.

## Generated Bootstrap Files

### `SUPERPOWERS.md`

This file is the canonical execution contract. It contains:

- the TOSS/Superpowers responsibility boundary;
- the required capability routing table;
- the no-fallback rule;
- the missing-capability block behavior;
- evidence handoff requirements;
- provider-neutral capability identifiers rather than slash, dollar, or UI
  invocation syntax.

### `AGENTS.md`

This file is a concise shared bootstrap. It instructs an agent to:

1. load the listed TOSS governance sources required for the task;
2. load `SUPERPOWERS.md` before technical execution;
3. invoke the applicable Superpowers capability using the active host's native
   skill mechanism;
4. preserve TOSS authority and evidence gates around the Superpowers work;
5. block execution when a required capability is unavailable.

It must not reproduce the lifecycle routing table or detailed governance text.

### `CLAUDE.md`

This file contains only the Claude Code import bridge:

```markdown
@AGENTS.md
```

There are no Claude-specific TOSS rules. Removing Claude support in a future
release requires deleting only this bridge, not changing the canonical process.

## Governance Document Changes

The existing governance system remains authoritative, but overlapping method
instructions are replaced by delegation boundaries:

- `PM_AGENT.md` routes technical lifecycle work to Superpowers and continues to
  own intent, authority, assignment, evidence acceptance, and closure.
- `policies/AGENTS.md` requires assigned specialists to follow the canonical
  Superpowers contract within their Task Contract.
- `policies/TASKS.md` retains readiness, contract, evidence, and Definition of
  Done rules. It does not prescribe a parallel planning or implementation
  method.
- `policies/QUALITY.md` defines required outcomes and evidence. TDD, debugging,
  review, and verification procedures are delegated to the corresponding
  Superpowers capabilities.
- `policies/RELEASES.md` retains release authority, exact-artifact identity,
  manifest, deployment, rollout, and production gates. Development-branch
  completion is delegated to Superpowers.
- Design governance continues to own design intent, approved Design System
  versions, and UI implementation locks. Creative discovery uses
  `superpowers:brainstorming`; visual production remains assigned to an
  approved design specialist.

Governance references to plan, review, or verification remain only when they
describe an authority gate, required evidence, or state transition. They must
not restate the execution procedure.

## Runtime Flow

1. The host automatically discovers `AGENTS.md`, directly or through the
   one-line `CLAUDE.md` bridge.
2. The PM authenticates and classifies incoming intent under TOSS governance.
3. TOSS captures or updates the Objective, constraints, acceptance criteria,
   authority, and Task Contract.
4. Before technical work, the assigned agent loads `SUPERPOWERS.md` and invokes
   the capability matching the current trigger.
5. Superpowers controls the technical workflow and produces plans, tests,
   reviews, verification output, and artifact identities as applicable.
6. Those outputs return to TOSS as evidence. A Superpowers completion result is
   not itself a TOSS authorization or Task closure.
7. The PM verifies governed acceptance criteria and records the resulting state.
8. Release and production actions continue through TOSS release authority and
   exact-artifact gates.

## Missing Capability Behavior

Before implementation, debugging, review, verification, or branch completion,
the assigned agent must confirm that the required Superpowers capability is
available through the active host.

If unavailable:

- set the execution state to `BLOCKED_SUPERPOWERS_MISSING`;
- name the missing canonical capability;
- identify the active host;
- provide host-appropriate installation or enablement guidance when known;
- preserve completed discovery and governance artifacts;
- do not imitate the missing workflow using TOSS instructions;
- do not broaden scope or mark the Task complete.

If `subagent-driven-development` alone is unavailable but
`executing-plans` is available, the PM may select `executing-plans` without
entering the blocked state.

## Project State

Generated project state gains a Superpowers section with these fields:

- requirement: `REQUIRED`;
- provider: active host name or `UNKNOWN`;
- availability: `PENDING_VERIFICATION`, `AVAILABLE`, or `MISSING`;
- active capability: canonical capability identifier or `NONE`;
- execution state: `READY`, `ACTIVE`, or `BLOCKED_SUPERPOWERS_MISSING`;
- evidence references: plan, test, review, verification, branch, and commit
  identifiers when applicable.

Initial bootstrap records `PENDING_VERIFICATION`; runtime verification changes
the state. The CLI does not claim that a host plugin is installed merely because
the project templates were generated.

## CLI Changes

The CLI will:

- generate `SUPERPOWERS.md` and `AGENTS.md` at the project root;
- generate the one-line `CLAUDE.md` bridge;
- initialize the Superpowers project-state fields without claiming runtime
  availability;
- keep the existing Project Brief, Design Brief, agent catalog, governance,
  GitHub, and LangSmith outputs;
- document Superpowers as a required host capability rather than an npm runtime
  dependency;
- never install or enable a host plugin without explicit user action.

## Validation

The smoke test must prove that:

1. generated projects contain `SUPERPOWERS.md`, `AGENTS.md`, and `CLAUDE.md`;
2. `CLAUDE.md` contains exactly the shared bootstrap import and no duplicated
   lifecycle rules;
3. `AGENTS.md` points to `SUPERPOWERS.md` and the canonical governance sources;
4. `SUPERPOWERS.md` contains every required canonical capability identifier;
5. the missing-capability state and no-fallback rule are present;
6. generated state starts at `PENDING_VERIFICATION`, not `AVAILABLE`;
7. existing Project Brief and Design Brief scenarios continue to pass;
8. deprecated parallel TOSS development procedures do not remain in the files
   modified by this feature;
9. package and CLI version behavior remains unchanged until a separate release
   change is intentionally made.

## Out of Scope

- bundling or redistributing Superpowers itself;
- automatically installing provider plugins or skills;
- changing CEO or production authority rules;
- replacing TOSS Project Brief, Design Brief, governance, or project state;
- adding provider-specific development behavior;
- changing npm publication, package scope, or release version in this feature;
- migrating projects already generated by older TOSS CLI versions.

## Success Criteria

The design is complete when a newly generated project has one canonical,
provider-neutral Superpowers lifecycle; Claude Code and Codex can discover it
without duplicated process rules; TOSS continues to govern intent, authority,
state, evidence, and release decisions; and technical execution blocks safely
when Superpowers is unavailable.
