# TOSS Superpowers Execution Contract

Status: REQUIRED

## Boundary

TOSS owns verified intent, scope, authority, Task Contracts, project state,
evidence acceptance, release authorization, and production boundaries.
Superpowers owns the method used for technical discovery, planning,
implementation, debugging, review, verification, and branch completion.

## Required Routing

| Trigger | Capability |
| --- | --- |
| Agent session start or skill-routing decision | `superpowers:using-superpowers` |
| New feature, creative work, or behavior change | `superpowers:brainstorming` |
| Approved design requiring an implementation plan | `superpowers:writing-plans` |
| Implementation workspace setup | `superpowers:using-git-worktrees` |
| Feature or bug-fix implementation | `superpowers:test-driven-development` |
| Unexpected behavior or test failure | `superpowers:systematic-debugging` |
| Plan execution with supported subagents | `superpowers:subagent-driven-development` |
| Plan execution without supported subagents | `superpowers:executing-plans` |
| Completion claim | `superpowers:verification-before-completion` |
| Work ready for review | `superpowers:requesting-code-review` |
| Review feedback received | `superpowers:receiving-code-review` |
| Verified development branch ready to conclude | `superpowers:finishing-a-development-branch` |
| Reusable skill creation or modification | `superpowers:writing-skills` |

Use the active host's native skill mechanism. Capability identifiers are
canonical; invocation syntax is host-owned.

## Missing Capability

If a required capability is unavailable:

1. Set execution state to `BLOCKED_SUPERPOWERS_MISSING`.
2. Record the missing capability and active provider.
3. Preserve completed discovery and governance artifacts.
4. Provide provider-appropriate installation or enablement guidance when known.
5. Do not imitate the missing workflow: there is no TOSS execution fallback.
6. Do not mark the Task complete.

`superpowers:executing-plans` is the permitted Superpowers alternative when
subagents are unsupported.

## Evidence Handoff

Superpowers outputs are technical evidence, not TOSS authorization. Return the
applicable plan, tests, review findings, verification output, branch, commit,
and exact artifact identity to the PM. Only the PM may accept that evidence
against the governed Definition of Done.
