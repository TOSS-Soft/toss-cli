# Analysis State Machine Contract

## Scope

This contract defines the resumable PM → Architecture/ADR → PM Finalization →
Spec Audit pipeline. It owns state validation, interruption outcomes, immutable
transition evidence, and deterministic resume. It does not own CLI lifecycle
results, `command-result.v1`, GitHub publication, or issue publication.

`transition(state, event, context)` is the pure, fail-closed transition
function. `runNextStage(context)` validates an explicit event or derives the
next event from already-produced pipeline artifacts, then appends one
`transition-event` revision. `resumeAnalysis(store, sourceRevision)` reads only
the artifact store's public `list` and `verify` interfaces.

All inputs used by these interfaces must be canonical JSON. Returned state,
resume, and artifact values are canonical copies and are recursively frozen.

## States

The normative states are:

- `ANALYZING`
- `QUESTIONS_PENDING`
- `USER_DECISION`
- `ARCHITECTURE_PENDING`
- `ADR_PENDING_APPROVAL`
- `PM_FINALIZATION`
- `SPEC_AUDIT`
- `READY_FOR_ISSUES`
- `BLOCKED`
- `FAILED_RETRYABLE`
- `FAILED_TERMINAL`

`READY_FOR_ISSUES` and `FAILED_TERMINAL` are terminal. `BLOCKED` may resume
after its named owner supplies the required evidence. `FAILED_RETRYABLE` may
retry from the recorded recovery state. A retry does not reinterpret or mutate
an earlier event.

## Declared transitions and guards

| From | Event | To | Required evidence and guard |
| --- | --- | --- | --- |
| `ANALYZING` | `SOURCE_RESTARTED` | `ANALYZING` | Auto-derived only after verified history proves a new source identity; exact prior source and historically consumed stale revisions are bound in both event content and envelope inputs |
| `ANALYZING` | `QUESTIONS_FOUND` | `QUESTIONS_PENDING` | Exact PM analysis and a canonical blocked `decision-package.v1` |
| `ANALYZING` | `ANALYSIS_COMPLETED` | `ARCHITECTURE_PENDING` | Exact validated PM analysis |
| `QUESTIONS_PENDING` | `DECISION_STARTED` | `USER_DECISION` | Exact PM analysis and the same blocked decision package |
| `USER_DECISION` | `DECISIONS_RESOLVED` | `ARCHITECTURE_PENDING` | Exact PM analysis; decision package gate is exactly `CLEAR` and `can_continue=true` |
| `ARCHITECTURE_PENDING` | `ADR_APPROVAL_REQUIRED` | `ADR_PENDING_APPROVAL` | Exact PM, architecture, and ADR revisions plus a USER-owned package containing exactly the pending ADR revisions |
| `ARCHITECTURE_PENDING` | `ARCHITECTURE_COMPLETED` | `PM_FINALIZATION` | Exact PM, architecture, and ADR revisions; architecture validation is complete |
| `ADR_PENDING_APPROVAL` | `ADR_APPROVED` | `PM_FINALIZATION` | Exact PM, architecture, and ADR revisions; architecture validation is complete, approvals are current, and the persisted approval package exactly matches the pending predecessor |
| `PM_FINALIZATION` | `FINALIZATION_COMPLETED` | `SPEC_AUDIT` | Exact PM, architecture, ADR, and issue-plan revisions; issue-plan validation is complete |
| `SPEC_AUDIT` | `AUDIT_PASSED` | `READY_FOR_ISSUES` | Exact PM, architecture, ADR, issue-plan, and spec-audit revisions; audit says ready |
| `SPEC_AUDIT` | `AUDIT_BLOCKED` | `BLOCKED` | Exact PM, architecture, ADR, issue-plan, and deterministically reproduced spec-audit revisions; remediation owner is the first blocking finding's actual owner |
| `BLOCKED` | `RESUME` | recorded recovery state | Recovery state is active and non-terminal |
| `FAILED_RETRYABLE` | `RETRY` | recorded recovery state | Recovery state is active and non-terminal |

Any non-terminal active state may emit `BLOCK`, `FAIL_RETRYABLE`, or
`FAIL_TERMINAL`. `BLOCK` requires a named next action and owner.
`FAIL_RETRYABLE` and `FAIL_TERMINAL` require a non-empty failure code and
message. Retryable failures record the state to retry; terminal failures do not
permit another transition.

Every other state/event pair is illegal. Existing history may be read and
verified first to establish append continuity, but an illegal transition is
always rejected before append, so it produces no event or other artifact.

## Decision ownership

`QUESTIONS_PENDING` exposes the exact `decision-package.v1` and the owner of
its unresolved blocking questions. If the package contains a USER-owned
question, USER is the blocking owner.

`ADR_PENDING_APPROVAL` always exposes `owner: USER`. Its embedded
`adr-approval-package.v1` is a closed package of exact immutable ADR references
whose approval state is not `approved`. Already-approved ADRs remain pipeline
inputs but are not repeated as pending decisions. A missing, extra, stale, or
hash-mismatched ADR reference rejects the transition.

The exact pending decision package is immutable history, not merely caller
state. Replay compares `QUESTIONS_PENDING → DECISION_STARTED` and
`ADR_PENDING_APPROVAL → ADR_APPROVED` package content with the verified
predecessor. A replaced or omitted package invalidates the event chain even if
each event independently satisfies its schema.

Spec-audit remediation preserves the owner of the first deterministically
ordered blocking finding. The complete finding-owner set is `PM`, `ARCHITECT`,
`PM_FINALIZATION`, and `USER`; the findings-only Spec Auditor is never assigned
remediation work. Both automatic derivation and an explicit `AUDIT_BLOCKED`
event enforce the same exact action and owner.

Every required artifact is canonical JSON, valid under the registered schema
for its exact document type, content-hash valid, bound to the current source,
and linked to its exact immutable upstream input set. A property name or a
`ready_for_github` boolean is not evidence. Spec-audit content must equal a
fresh deterministic audit over the supplied immutable graph.

## Transition-event revisions

Each successful transition is appended as a `transition-event` ACP artifact:

- the event stream's `artifact_id` is the analysis ID;
- the producer role is `orchestrator`;
- revision 1 has no parent;
- each later revision has exactly one parent: the immediately previous verified
  transition-event revision;
- `inputs` contains the canonical, sorted, exact references required by that
  transition;
- decision-wait events embed the exact closed package used for later
  predecessor-continuity checks;
- provenance `source_revision` and `source_sha256` exactly match the event
  content and current source descriptor; and
- the closed `transition-event.v1` schema is validated before append.

The artifact store assigns or checks immutable content-addressed storage. No
successful event edits an earlier revision.

## Stage orchestration

When `runNextStage` receives an explicit event, it applies the same guards as
the pure transition function. When the event is omitted, it derives the next
event from the current state's existing stage artifacts:

- PM analysis uses `validatePmAnalysis`; an unresolved blocking decision
  package enters `QUESTIONS_PENDING`.
- Architecture and ADRs use `validateArchitecture`; complete evidence enters
  PM finalization, pending ADRs enter USER approval, and other incomplete
  evidence becomes blocked with the responsible owner.
- PM finalization uses `validateIssuePlan`; incomplete evidence becomes
  PM-owned blocked work.
- Spec audit consumes the immutable `spec-audit` artifact; ready evidence enters
  `READY_FOR_ISSUES`, otherwise the audit findings name the blocking action.

Stage agents remain the owners of their artifacts. The orchestrator validates
and sequences those artifacts; it does not mutate or impersonate them.

## Resume and source changes

Resume performs these steps in order:

1. Call `store.list()`; no filesystem path or artifact filename is inspected.
2. Select transition events for the requested analysis ID and order them by
   immutable revision.
3. Verify every event and referenced input through `store.verify()`. Revalidate
   the contiguous revision/parent chain, legal `(previous_state, event, state)`
   tuple, predecessor-state continuity, content/envelope source and input
   equality, schema, content hash, and source/input lineage before selecting a
   checkpoint.
4. If the latest verified event's provenance matches the requested source revision and hash, resume
   from its recorded state. Otherwise resume at `ANALYZING` while retaining the
   last verified event reference as audit evidence.
   Retryable and blocked checkpoints also expose their recorded
   `recovery_state` so the caller does not infer it from ambient state.
5. Report every PM, architecture, ADR, issue-plan, and spec-audit artifact whose
   source revision or source hash differs. Sort stale references by document
   type, artifact ID, and revision.

When the requested source differs from the latest verified transition,
`resumeAnalysis` returns `ANALYZING`. The next `runNextStage` call may create a
new generation in the same analysis stream only when all of these conditions
hold:

- verified history exists and the supplied source identity has never appeared
  in that stream;
- the caller uses `state: ANALYZING` and does not supply an event or
  `source_boundary`;
- the orchestrator auto-derives exactly
  `ANALYZING + SOURCE_RESTARTED → ANALYZING`;
- revision remains contiguous and the parent is the exact latest transition
  from the prior generation; and
- `source_boundary` records the exact prior source plus the canonical set of
  stale artifact revisions consumed by earlier transition history. That exact
  set is also the event's `input_artifacts` and envelope `inputs`.

Replay permits a source change only at that boundary and recomputes its stale
relationship from verified historical inputs. A missing stale reference,
wrong tuple, repeated source identity, caller-injected boundary, mid-stream
source switch, or broken parent/revision chain fails closed. Once the boundary
is appended, ordinary same-source state and package continuity resumes. The
broader `resumeAnalysis.stale_artifacts` result continues to report every
downstream artifact in the store whose source differs, including artifacts not
previously consumed by an event.

Any integrity error from `list` or `verify` fails closed. Resume never falls
back to raw filesystem scanning and never treats an unverified revision as a
checkpoint. Source changes do not delete old artifacts; they deterministically
identify them as stale so new downstream revisions can be produced.
