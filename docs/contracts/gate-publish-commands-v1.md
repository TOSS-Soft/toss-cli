# Gate and Publish Commands v1

## Scope

This contract defines the lifecycle handlers for decisions, architecture,
plans, specification audits, project readiness, and GitHub issue publication.
It extends the authority, state-machine, audit, readiness, and GitHub-writer
contracts without changing ownership of PM, architecture, or issue-plan
artifacts.

All handlers accept a closed own-data service object and an injected artifact
store exposing required `append`, `get`, `list`, and `verify` methods and the
optional public `recover` method. They reject
accessors without invoking them, inherited values, proxies, exotic
prototypes, symbols, unknown service fields, malformed list filters,
out-of-filter rows, duplicate revision identities, discontinuous history,
retargeted references, and append/verify contradictions. A command uses one
verified catalog generation at a time and refreshes it after a successful
append. It never scans the project directory for artifacts.

## Mutation and remote boundary

| Command | Local artifact mutation | GitHub writer | GitHub adapter mutation |
| --- | --- | --- | --- |
| `decisions list` | none | unavailable | none |
| `decisions answer` | append or reuse one immutable `decision-answer` | unavailable | none |
| `architecture review` | none | unavailable | none |
| `architecture approve` | append or reuse one immutable `adr-approval` | unavailable | none |
| `plan show` | none | unavailable | none |
| `audit run` | append or reuse the exact deterministic `spec-audit` | unavailable | none |
| `readiness check` | none | unavailable | none |
| `issues preview` | none | `preview` only | none |
| `issues publish` | none | `preview` only | none |
| `issues publish --apply` | publication history owned by the writer | `publish` once per invocation | allowed only after every writer gate passes |

Preview and default publication are deterministic dry runs. They return the
writer's create, update, and skip operations with a summary, but the writer
preview contract forbids artifact-store and adapter calls. No handler other
than `issues publish --apply` can receive or invoke a GitHub writer.

## Decision answers

`decisions list` derives the pending package from the current verified
transition. `decisions answer` accepts exactly one selected offered option or
one nonblank custom answer. It requires an authority registry injected
independently from answer input and reuses the decision authority's Ed25519
attestation verification. It does not accept a caller-supplied registry inside
the answer.

The resulting `decision-answer.v1` ACP artifact contains the exact question
ID, answer discrimination, source transition reference, complete source
decision package and its canonical SHA-256, complete source-question snapshot,
one verified authority resolution for every retained source question,
authority-registry hash, and deterministically rebuilt resolved package.
Complete verified answer histories reduce into one effective decision package
without rewriting the PM artifact. Answer revisions are monotonic immutable
records parented to the prior answer generation. A stale source, different
answer for the same question, conflicting immutable row, or reused authority
record for another question fails with a nonzero conflict outcome.

## ADR approvals

`architecture review` validates the complete architecture aggregate and
reports every pending ADR without appending or modifying any artifact.
`architecture approve` requires an independently injected authority registry
and an Ed25519-signed approval. The approval must bind the exact current ADR
artifact ID, revision, and content hash, the complete pending approval package,
the current transition, source revision/hash, actor route, and authority
record. It appends or reuses a separate `adr-approval.v1` record; it never
rewrites the ADR or any PM-owned artifact. Stale targets, replayed authority
records, and conflicting approval history fail closed before append. Complete
verified approval histories reduce into an effective architecture aggregate;
later source generations create parented approval revisions rather than
colliding with revision 1.

## Plan, audit, and readiness views

`plan show` validates the verified issue plan against its exact PM and
architecture inputs. Its view includes issue-plan status and coverage plus
epic, issue, dependency, required-ADR, source-requirement, and acceptance-
criterion summaries. Caller-supplied summaries are not a service input.

`audit run` passes the complete verified PM/architecture/ADR/issue-plan
aggregate to `auditSpecification`. A failing specification is still a
completed deterministic audit: the exact schema-valid audit artifact is
appended or reused, verified, returned with every finding, and routed with
exit 5. Trace construction is not a prerequisite for running a failed audit.

`readiness check` requires an independently injected authority registry and
passes it only as the evaluator trust context. It never trusts a supplied PDoR
summary and never appends. Every failure and warning retains the evaluator's
exact evidence and adds the fixed next command and owner for its PDoR rule. A
not-ready result is structured blocked data with exit 4.

## Publication gates and recovery

`issues publish --apply` obtains approval input, resolves the current verified
READY transition and its exact plan/audit/state aggregate, constructs the
trace graph, and delegates to the configured GitHub writer. The writer remains
the authority for readiness, state, audit, plan, repository, marker,
cryptographic publication approval, trusted publication registry, immutable
mapping, idempotency, duplicate-remote, and partial-recovery checks.

Unresolved P0-P2 decisions, pending ADRs, failed or stale audits, failed PDoR,
missing/invalid/stale/replayed publication approval, store conflicts, and
remote marker duplicates return a stable nonzero exit and do not mutate
GitHub. Retryable partial publication returns the writer's immutable partial
result; a later invocation reconciles markers and history before continuing.
Rerunning a complete publication does not create duplicate issues.

The standalone executable always composes the local verified artifact store
for these command families. It does not discover trust registries, repository
identities, adapters, or writers from project files. Commands needing those
external capabilities fail closed until the host injects them independently;
store-only views continue to work locally.

Closed structured blocked/validation/conflict data uses `command_exit_code`
4, 5, or 6 respectively. The dispatcher preserves only those three values
when `blocked` is exactly `true`; other successful data exits 0. Thrown handler
errors continue through the standard `command-result.v1` failure mapping.
