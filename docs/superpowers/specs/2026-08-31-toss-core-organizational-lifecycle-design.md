# TOSS Core Organizational Lifecycle Design

- **Date:** 2026-08-31
- **Status:** Approved for implementation planning
- **Cutover boundary:** TOSS CLI v2.1.2
- **Owning package:** `@toss-software/cli`
- **New executable:** `toss-core`

## Executive Decision

TOSS will add `toss-core` as a second executable in the existing
`@toss-software/cli` package. It will govern the organization-level TOSS OS
program across `toss-cli`, `toss-agent-runtime`, `toss-console`, and future
registered repositories.

GitHub remains the operational source of truth for Project items, issues,
milestones, branches, pull requests, reviews, checks, and native issue state. A
new private `TOSS-Soft/toss-os-control` repository stores the organization
registry, policies, release-program manifests, command intents, immutable
receipts, and migration snapshots. No always-on TOSS service or separate
database is introduced in this release.

The lifecycle hierarchy is:

```text
issue branch -> epic branch -> repository release branch -> main
```

A bounded production bug may bypass an epic:

```text
bug branch -> patch release branch -> main
```

Every issue belongs to the TOSS OS GitHub Project and receives a reserved branch
identity when it is recorded. The physical remote branch is created only when
the issue becomes ready to start. GitHub Project status and gate fields are
machine-owned and reconciled from authoritative lifecycle evidence.

## Context and Current Gaps

At the time of design:

- `TOSS-Soft/toss-cli` `main` is tagged `v2.1.1`.
- the organization Project is `TOSS OS`, Project number 2;
- the Project already contains items from `toss-cli`, `toss-agent-runtime`, and
  `toss-console`;
- repository releases are represented by GitHub milestones, but future backlog
  has been assigned versions far in advance;
- issue branches exist by convention, but pull requests generally target
  `main` rather than an epic and release branch hierarchy;
- older epics often model their children as body checklists rather than native
  GitHub parent/sub-issue relationships;
- pull request bodies may contain ad hoc review summaries, but review freshness,
  exact reviewed revision, and a standard managed review section are not
  enforced;
- the Project `Status` field currently provides only broad Todo, In progress,
  and Done states and is not derived from branch, PR, review, dependency, or
  release evidence;
- no neutral, durable organization-level repository owns the cross-repository
  registry or release-program manifests.

The user will manage v2.1.2 as the final pre-cutover TOSS CLI release. Future
release scope and SemVer selection become TOSS Core responsibilities after that
release completes.

## Goals

1. Provide one organization-level command surface for all registered TOSS OS
   repositories.
2. Record every feature request as a GitHub Epic in the TOSS OS Project without
   prematurely assigning a release version.
3. Decompose approved epics into native sub-issues with explicit acceptance
   criteria and an acyclic dependency graph.
4. Give every issue a branch identity and enforce the correct PR base branch.
5. Introduce repository-scoped release branches and coordinated TOSS OS release
   programs without forcing lockstep versions across products.
6. Keep GitHub issue and Project status current enough that an operator can see
   the exact lifecycle phase and gate directly in GitHub.
7. Make review results visible in the PR body, bind them to an exact revision,
   and invalidate them after a new push.
8. Apply SemVer consistently: breaking change is major, backward-compatible
   feature is minor, and a fix to an already released product is patch.
9. Prepare the next release-program draft after the current program completes.
10. Rebaseline preassigned future backlog after v2.1.2 without deleting issues
    or rewriting completed or active release history.

## Non-Goals

- Building a continuously running central orchestration service.
- Giving all TOSS repositories the same version number.
- Allowing one repository to merge a PR into another repository's branch.
- Automatically publishing a release without an explicit release approval.
- Rewriting completed milestones, tags, releases, or merged pull requests.
- Creating epics automatically for bounded bugs. The user remains the source of
  new product epics.
- Treating every bug found in unreleased feature work as a separate patch
  release.
- Writing test fixtures into the production TOSS OS Project.

## System Boundary and Source of Truth

### Executable ownership

`package.json` will expose both executables from the same package:

```json
{
  "bin": {
    "toss": "bin/toss.js",
    "toss-core": "bin/toss-core.js"
  }
}
```

The existing `toss` lifecycle remains backward compatible. `toss-core` reuses
the existing command-result envelope, exit-code classes, schema validation,
GitHub adapter patterns, and fail-closed authority boundaries where applicable.

### Operational state: GitHub

GitHub is authoritative for:

- TOSS OS Project membership and visible fields;
- native issue open/closed state;
- native parent/sub-issue relationships;
- milestones;
- branches and their heads;
- pull request base/head/revision and draft state;
- GitHub review state and required checks;
- merge, tag, release, and publication evidence.

### Durable intent and audit: `toss-os-control`

The private control repository is authoritative for:

- registered repositories and their default branches;
- Project identity and required field identifiers;
- lifecycle and release policy revisions;
- release-program and repository-release manifests;
- operation intents written before remote mutation;
- immutable operation, approval, review, reconciliation, and release receipts;
- cutover snapshots and rebaseline reports.

The initial logical layout is:

```text
config/organization.yaml
config/repositories/<repository>.yaml
policies/lifecycle.yaml
policies/release.yaml
programs/<program-id>/manifest.yaml
intents/<year>/<month>/<intent-id>.json
receipts/<year>/<month>/<receipt-id>.json
migrations/<migration-id>/snapshot.json
migrations/<migration-id>/result.json
```

No credentials or secrets are committed to this repository.

## Core Components

### Command router

Parses the `toss-core` grammar, applies common option rules, classifies command
safety, and returns one human or JSON result.

### Lifecycle reconciler

Derives Project status and gate from GitHub plus control-repository evidence.
The same pure rules are used by interactive commands, non-interactive CLI
automation, event-triggered GitHub Actions, and scheduled drift checks.

### Epic decomposer

Transforms a user-provided epic into a proposed set of native child issues,
acceptance criteria, repository ownership, and dependency edges. It blocks on
unresolved ambiguity instead of inventing product intent.

### Dependency graph

Validates issue, epic, repository, and release-program dependencies. It rejects
self-reference, missing nodes, cycles, cross-repository branch targets, and a
release plan whose prerequisites cannot complete in the same or an earlier
program stage.

### SemVer release planner

Builds an explainable program plan from approved, unversioned epics. It assigns
versions separately per repository, records the reason for every selected epic
and version, and never versions the entire backlog by default.

### Branch and PR manager

Reserves deterministic branch identities, creates physical branches from the
correct base, creates or updates idempotent PRs, verifies exact base/head
relationships, and blocks direct work-item PRs to `main`.

### Review recorder

Validates an independently produced review result, binds it to the current PR
head SHA, updates the managed PR-body section, updates formal GitHub review
state, and records immutable review history.

### GitHub adapter

Provides typed, testable operations for organization Projects, issues,
sub-issues, milestones, branches, PRs, reviews, checks, tags, releases, and
publication evidence. It accepts explicit repository and Project identities;
it does not infer authority from repository files.

### Control-repository store

Commits versioned policy, program, intent, and receipt documents. It rejects
untracked revision changes, duplicate immutable identities, and receipt writes
that do not bind the source intent and observed GitHub revision.

## Entities and Identifiers

### Feature and epic

A `feature add` request creates exactly one GitHub Epic issue. It is initially
unversioned. Its stable identity combines repository and issue number; the
human-readable title does not carry a planned release version.

Epic identity is established by a required `epic` label and a managed TOSS Core
body marker. When the organization exposes a native GitHub Epic issue type, the
adapter sets and verifies it as well, but lifecycle authority never depends on
that optional platform capability.

### Child issue

An issue produced by epic preparation has:

- a native parent Epic;
- one repository owner;
- explicit acceptance criteria;
- zero or more dependency edges;
- a reserved branch identity;
- a derived Project status and gate;
- no milestone until its parent epic is assigned to an active release.

### Bounded bug/fix issue

A bounded fix may be created without an epic. It must still belong to the TOSS
OS Project, identify an affected released version, have a reserved branch, and
belong to a patch release before implementation starts. If analysis expands it
into multiple independently deliverable issues, TOSS Core blocks with
`EPIC_REQUIRED` and asks the user for an epic rather than inventing one.

### Dependency edge

An edge has a stable source, target, kind, rationale, and provenance. `requires`
means the target must complete before the source can become Ready. Cross-
repository edges affect scheduling only; they never create Git branch or PR
relationships across repositories.

### Repository release

A repository release owns one SemVer, milestone, release branch, draft release
PR, selected epics or patch issues, and gate state. At most one repository
release is Active at a time. A paused feature release may keep its physical
branch while an urgent production patch is the only Active release.

### TOSS OS release program

A program is an organization-level coordination record such as
`TOSS-OS-R0001`. It contains zero or one repository release track per included
repository and explicit cross-repository ordering. It does not impose a common
version.

### Intent and receipt

Every remote mutation is preceded by a deterministic intent document containing
the source snapshot, exact operations, authority, and idempotency key. A receipt
records succeeded, skipped, failed, and compensating operations plus the final
observed GitHub state.

## GitHub Project Fields and State

### Visible fields

Every governed issue exposes at least:

- `Status`;
- `Gate`;
- repository;
- native parent issue where applicable;
- milestone where planned;
- branch identity;
- base branch identity;
- last reconciled time.

The existing Project fields are reused where their semantics match. Missing
machine-owned fields are created during `toss-core init`.

### Status values

| Status | Meaning |
|---|---|
| `Backlog` | Recorded but not ready for implementation. |
| `Ready` | Release is active, dependencies are complete, and the physical branch may be created. |
| `In progress` | Implementation or a draft PR is active. |
| `In review` | A ready PR, checks, or current review is in progress. |
| `Blocked` | A named dependency, authority, review, conflict, or reconciliation gate prevents progress. |
| `Done` | The governing PR merged and the native issue closed. |

### Gate values

The first contract supports these exact gates:

- `NONE`;
- `EPIC_PREPARATION_REQUIRED`;
- `EPIC_APPROVAL_REQUIRED`;
- `EPIC_REQUIRED`;
- `RELEASE_PLANNING`;
- `DEPENDENCY_REQUIRED`;
- `REVIEW_REQUIRED`;
- `CHANGES_REQUESTED`;
- `EPIC_ACCEPTANCE_REQUIRED`;
- `RELEASE_APPROVAL_REQUIRED`;
- `RECONCILE_REQUIRED`.

The gate provides the reason and next command; `Status=Blocked` alone is not a
sufficient operator explanation.

### Machine ownership

Project Status, Gate, branch, base branch, and last-reconciled fields are
machine-owned. Manual GitHub edits are treated as drift and corrected at the
next reconciliation. Native issue state is Open until the governing PR actually
merges; an approval alone never closes the issue.

### Reconciliation triggers

Status is reconciled:

- in the same operation that runs a `toss-core` mutation;
- after issue, branch, PR, review, check, milestone, and merge GitHub events;
- on an explicit `toss-core sync`;
- on a scheduled drift check.

If a status update fails after another operation succeeds, the entity becomes
`Blocked / RECONCILE_REQUIRED`; the command does not report complete success.

## Branch and Pull Request Model

### Naming

```text
release/v<major>.<minor>.<patch>
epic/<issue-number>-<slug>
issue/<issue-number>-<slug>
bug/<issue-number>-<slug>
```

Branch names are repository-scoped and deterministic. Re-running the command
must resolve the same name or report a conflict.

### Reservation and physical creation

Every epic and issue receives its branch identity when recorded. The remote
branch is not created while the item is unversioned backlog. It is created when
the entity becomes Ready:

- an epic branch is created from its active release branch;
- an epic child issue branch is created from the epic branch;
- a release-owned production bug branch is created from the patch release
  branch;
- a release branch is created from the verified current `main` head at release
  activation.

### Merge hierarchy

```text
issue/<n>-<slug>
  PR base -> epic/<epic-n>-<slug>

epic/<epic-n>-<slug>
  PR base -> release/vX.Y.Z

release/vX.Y.Z
  PR base -> main
```

For a bounded patch:

```text
bug/<n>-<slug>
  PR base -> release/vX.Y.Z

release/vX.Y.Z
  PR base -> main
```

No issue or epic PR may target `main`. No cross-repository PR base is valid.

### Review and merge freshness

Approval is bound to the exact PR head SHA. Any new push marks the review stale,
sets `Gate=REVIEW_REQUIRED`, and prevents merge until a new current review is
recorded. Required checks are evaluated at the same head SHA.

## Epic Lifecycle and Authority

Epic authority deliberately uses two distinct gates:

1. `epic approve` approves the proposed scope, children, acceptance criteria,
   and dependency graph. It makes the epic eligible for release planning.
2. `epic accept` accepts the implemented epic after every child issue is Done,
   the epic PR review is current, and required checks pass. It authorizes merge
   into the release branch.

An epic follows:

```text
feature add
  -> Backlog / EPIC_PREPARATION_REQUIRED
epic prepare
  -> Backlog / EPIC_APPROVAL_REQUIRED
epic approve
  -> Backlog / RELEASE_PLANNING
release activate
  -> Ready or Blocked / dependency gate
issue work and merges
  -> epic In progress
epic submit
  -> In review / review or acceptance gate
epic accept
  -> PR merged, epic Done
```

`epic approve`, `epic accept`, and `release approve` require an authority record
bound to the current plan or revision. The record is validated independently of
the source artifact. Release approval cannot waive stale review, required
checks, dependency completion, or repository rules.

## Review Result Contract

The current review result is written inside markers in the PR body so human
content outside the markers is preserved:

```md
<!-- toss-core:review-results:start -->
## Review results

- Verdict: APPROVED | CHANGES_REQUESTED | BLOCKED
- Reviewed revision: <exact commit SHA>
- Reviewer: <identity and independent-review role>
- Reviewed at: <timestamp>
- Freshness: CURRENT | STALE

### Findings
- Critical: <count>
- Important: <count>
- Minor: <count>

### Unresolved
- <finding or None>

### Verification evidence
- <check or evidence reference>

### Follow-up issues
- <TOSS OS Project issue references>
<!-- toss-core:review-results:end -->
```

Rules:

- the reviewer must be independent of the implementation identity;
- Critical or Important findings block merge;
- a deferred Minor finding must create or reference a follow-up issue in the
  TOSS OS Project;
- the PR body contains the current result, while immutable review history lives
  in `toss-os-control`;
- formal GitHub review state is updated as well; a comment alone is not accepted
  as a review result;
- marker corruption, duplicate marker blocks, or a reviewed SHA different from
  the current head blocks recording or merging.

## Command Surface

### Common behavior

All commands support human output and `--json`. Read-only commands never mutate
GitHub or the control repository. A remote-mutating command first produces an
exact operation preview:

- interactive use requests an exact confirmation before apply;
- non-interactive use requires `--apply --non-interactive`;
- `--dry-run` forbids writes and returns the same operation plan that apply
  would validate;
- stale previews are rejected rather than silently recalculated and applied;
- authority-gated commands require `--from <authority-record>`.

Commands return the existing stable result and exit-code classes. In particular:

- `4`: blocked gate;
- `5`: validation or invariant failure;
- `6`: conflict or stale source;
- `69`: required implementation or integration unavailable;
- `70`: internal failure.

### Bootstrap and registry

| Command | Responsibility |
|---|---|
| `toss-core init` | Validate or initialize the control repository, organization Project fields, policies, and sync workflow contract through the explicit bootstrap transaction. |
| `toss-core repo add` | Register a repository and validate default branch, permissions, rules, release workflow, and Project access. |
| `toss-core repo list` | Show registered repositories and onboarding health. |

### Feature and epic

| Command | Responsibility |
|---|---|
| `toss-core feature add` | Create one unversioned Epic and TOSS OS Project item with a reserved branch identity. |
| `toss-core feature status` | Show intake, preparation, approval, release eligibility, and next command. |
| `toss-core epic prepare` | Create or reconcile native sub-issues, acceptance criteria, and dependency edges. |
| `toss-core epic status` | Show child progress, dependency graph, branch, PR, gate, and release assignment. |
| `toss-core epic approve` | Approve scope and dependency plan for release eligibility. |
| `toss-core epic submit` | Open or update the epic PR to its release branch after children complete. |
| `toss-core epic accept` | Authorize current reviewed epic revision to merge into the release branch. |

### Issue and dependency

| Command | Responsibility |
|---|---|
| `toss-core issue add` | Create a bounded bug/fix issue; block with `EPIC_REQUIRED` when decomposition is necessary. |
| `toss-core issue start` | Verify readiness and create the physical branch from the exact parent head. |
| `toss-core issue submit` | Open or update the PR against the required parent branch. |
| `toss-core issue status` | Show Project status, gate, dependencies, branch, PR, review, and next command. |
| `toss-core dependency add` | Add a validated, provenance-bearing edge. |
| `toss-core dependency remove` | Remove an edge with an auditable reason and revision binding. |
| `toss-core dependency graph` | Render the issue, epic, repository, or program dependency graph. |
| `toss-core dependency check` | Reject cycles, missing references, unsatisfied stage ordering, and cross-repository Git targets. |

### Review

| Command | Responsibility |
|---|---|
| `toss-core review record` | Validate and write the current revision-bound review result to PR details and immutable history. |
| `toss-core review status` | Show freshness, findings, formal GitHub review state, checks, and merge eligibility. |

### Release and program

| Command | Responsibility |
|---|---|
| `toss-core release plan` | Select approved unversioned scope, dependency stages, repository versions, and rationale in a Draft program manifest. |
| `toss-core release activate` | Create milestone, release branch, release-PR intent, assignments, and ready epic branches. |
| `toss-core release status` | Show repository release phase, scope, gates, checks, paused patch state, and next command. |
| `toss-core release approve` | Authorize the current ready release PR to merge and start tag/publication verification. |
| `toss-core program status` | Aggregate all repository tracks and cross-repository dependencies in the active or draft program. |

`release activate` records the Draft release-PR intent. If the new release
branch already differs materially from `main`, it also opens the Draft PR. When
the branch initially has no diff, the reconciler opens the Draft PR immediately
after the first epic, bug, or release-metadata change makes GitHub accept it. The
PR is then kept current and becomes eligible for release approval only after all
selected scope is Done and the release review/check evidence is current. A
separate `release submit` command is therefore unnecessary.

### Operations and migration

| Command | Responsibility |
|---|---|
| `toss-core sync` | Reconcile GitHub and control-repository state and correct machine-owned Project fields. |
| `toss-core audit` | Read-only invariant and drift audit across Project, issue, branch, PR, review, and release relationships. |
| `toss-core doctor` | Validate authentication, permissions, Project schema, repository rules, Actions, and control-repository health. |
| `toss-core migrate rebaseline --cutover v2.1.2` | Snapshot and remove approved future version assignments while preserving active and completed releases. |

## Release Planning and SemVer

### Coordinated program, independent product versions

One TOSS OS program may coordinate releases from multiple repositories. Each
repository retains its own version, milestone, branch, tag, package, and release
evidence. The program records ordering and compatibility; it is not a product
version.

### Eligibility and scope selection

`release plan` considers only epics that are:

- explicitly approved;
- unversioned;
- owned by a registered repository;
- sufficiently decomposed to validate dependency closure;
- not already active in another plan.

The planner selects a coherent, explainable scope using priority, dependency
closure, risk, compatibility, and deliverable outcome. It records selected and
deferred epics plus rationale. Mandatory dependencies must be in an earlier
completed program or an earlier compatible track in the same program. No future
milestone is created merely because an epic exists in backlog.

### Version selection

- A breaking public CLI, contract, schema, protocol, authority, or compatibility
  boundary requires a major version.
- At least one backward-compatible feature epic requires a minor version.
- A repository release containing only fixes to an already published version
  receives the next patch version.
- A bug found only in unreleased feature code remains in that feature release
  and does not create an extra patch release.

### Concurrency

Each repository has at most one Active release. Different repositories may
have Active releases in the same program. A Draft next release does not own a
milestone or branch.

### Production patch interruption

When a bug affects the latest published version while a feature release is
Active:

1. the feature release becomes Paused but keeps its physical branch;
2. a patch release becomes the only Active repository release and branches from
   current verified `main`;
3. the patch issue branches from the patch release branch;
4. after patch publication, the patch merge is incorporated into the paused
   feature release branch;
5. affected reviews become stale and checks rerun;
6. the feature release resumes only after reconciliation succeeds.

### Completion and next program

Release approval authorizes merge, tag, and publication workflow initiation; it
does not declare success. The release becomes Released only after exact tag,
package, GitHub Release, and required evidence verification succeeds. After the
entire active program completes, TOSS Core prepares the next Draft. If no epic
is eligible, the program remains `WAITING_FOR_EPIC` and creates no empty
milestone or branch.

## Command Data Flow and Failure Handling

Every mutating command follows:

1. read a verified GitHub and control-repository snapshot;
2. validate Project membership, registry, policy revision, authority,
   dependencies, and current remote revisions;
3. calculate a deterministic operation plan and idempotency key;
4. present the plan and obtain the required apply confirmation;
5. commit the intent document before remote mutation;
6. apply GitHub operations in dependency order;
7. reconcile native state and Project fields;
8. commit a final or partial receipt;
9. return the observed final state and next command.

`toss-core init` is the one bootstrap exception because the control repository
does not exist before its first successful run. It produces a local immutable
preview hash, requires the same explicit apply authority, creates the private
repository, and makes its first commit contain the organization configuration,
policy baseline, bootstrap intent, and bootstrap receipt together. If repository
creation succeeds but the first commit fails, initialization is incomplete and
must be reconciled; no other mutating command may run.

GitHub cannot provide an atomic transaction across all surfaces. Therefore:

- a partial operation never reports full success;
- succeeded operations are recorded and not repeated;
- the affected entity becomes `Blocked / RECONCILE_REQUIRED`;
- `sync` resumes or safely compensates from the receipt;
- a GitHub revision that changed after preview causes a conflict exit;
- permission and Project-schema checks occur before the first remote write;
- duplicate issue, branch, milestone, PR, review, tag, or receipt creation is
  prevented by stable markers and idempotency keys.

## v2.1.2 Cutover and Backlog Rebaseline

### Timing

No rebaseline mutation occurs before TOSS CLI v2.1.2 is fully released and its
milestone is closed. The cutover begins from a fresh organization inventory and
records the exact revision and counts observed at apply time.

### Planning snapshot

The 2026-08-31 analysis found 69 open future assignments proposed for
rebaseline:

- 36 `toss-cli` issues across seven future milestones;
- 12 `toss-agent-runtime` issues across future v1.1.0, v1.2.0, and v2.0.0
  milestones;
- 21 `toss-console` issues in a v1.0.0 milestone with no release branch.

This count is evidence for the design, not an apply-time assertion. Migration
must recompute the inventory and block for review if it has drifted materially.

### Preserved releases

- completed TOSS CLI releases are untouched;
- v2.1.2 remains the final user-managed TOSS CLI cutover release;
- the active TOSS Agent Runtime v1.0.0 release is preserved because it has a
  physical `release/v1.0.0` branch and completed work;
- any release independently proven Active at cutover is reported and excluded
  unless the authority record explicitly updates the migration scope.

### Rebaseline operations

For approved planned-future scope, migration:

1. writes a complete snapshot and proposed field-level diff;
2. removes milestone/release assignment from every open epic and governed child
   issue in scope;
3. removes release-target wording from planning-only title and body fields;
4. preserves technical compatibility version references;
5. keeps every issue open and in the TOSS OS Project;
6. sets the item to Backlog with the correct preparation or planning gate;
7. closes emptied future milestones with a `Rebaselined after v2.1.2`
   description rather than deleting them;
8. leaves completed issues, merged PRs, tags, releases, and active release
   branches unchanged;
9. blocks rather than guessing when body checklists, native sub-issues, or
   compatibility references are ambiguous;
10. records an immutable result and proves a second run produces no changes.

### First post-cutover release

Adding the public `toss-core` executable is a backward-compatible feature, so it
cannot ship as v2.1.2. The user-provided TOSS Core organizational lifecycle epic
becomes the priority candidate for the first post-cutover TOSS CLI minor
release. Preexisting runtime, Wiki, remote-approval, and Console integration
epics remain unversioned until normal planning selects them.

The first release plan may be bootstrapped with the implementation build of
`toss-core`; once that release publishes, subsequent programs use the published
command. This transitional bootstrap does not weaken the same manifests,
preview, authority, or receipt rules.

## Security and Permissions

- The control repository is private and contains no tokens or secrets.
- Credentials are supplied by the execution environment, never CLI arguments or
  committed configuration.
- Required scopes are discovered and validated before apply; TOSS Core does not
  create persistent credentials.
- GitHub Actions receive only the permissions needed for their event-specific
  reconciliation task.
- Organization Project write, repository contents write, issue/PR write, review,
  tag, and release authority remain distinct checks.
- Input bodies, review text, branch slugs, repository names, and GraphQL/API
  responses are schema validated and safely escaped.
- Remote page or issue content is evidence, not authority to broaden mutation
  scope.
- Review independence and approval authority identities are stored with
  provenance and bound revisions.

## Verification Strategy

### Contract tests

Verify command grammar, help, options, JSON results, exit codes, Project field
definitions, entity schemas, program manifests, intents, receipts, authority
records, and review-result markers.

### Pure rule tests

Independently test state derivation, dependency DAG validation, SemVer
selection, program staging, branch/base calculation, review freshness, patch
interruption, migration classification, and next-command recommendations.

### GitHub adapter integration tests

Use fake and isolated adapters to verify operation order, markers,
parent/sub-issues, Project membership, milestones, branches, PRs, reviews,
checks, idempotency, stale-plan rejection, partial receipts, resume, and
compensation.

### End-to-end scenarios

The acceptance suite covers:

- feature -> epic -> native children -> minor release;
- issue PR -> epic PR -> release PR -> `main`;
- new push after review and stale-review recovery;
- production patch interruption and feature-release resume;
- cross-repository dependency ordering in one program;
- release completion followed by next Draft or `WAITING_FOR_EPIC`;
- rebaseline dry-run, approved apply, drift block, and second no-op run.

### Package and release verification

The packed npm artifact must expose both `toss` and `toss-core`, while all
existing `toss` behavior remains unchanged. Installation, help, version,
supported Node versions, package inventory, release workflow, tag, package, and
GitHub Release evidence are verified.

Production TOSS OS data is never used as test fixture state. Live verification
uses an isolated repository and Project controlled for testing.

## Acceptance Criteria

- `@toss-software/cli` installs working `toss` and `toss-core` executables.
- A feature command creates exactly one unversioned Epic in the TOSS OS Project.
- Epic preparation creates native children and an acyclic dependency graph.
- Every issue has a reserved branch identity; every started issue has one
  physical branch from the correct parent.
- Issue PRs target epic branches, epic PRs target release branches, and only
  release PRs target `main`.
- Bounded production fixes can use a patch release without an epic.
- Scope approval and implementation acceptance are separate, revision-bound
  authority gates.
- GitHub Project Status and Gate match branch, PR, dependency, review, and merge
  evidence after every command and event reconciliation.
- PR details show the current exact-SHA review result, and a new push makes it
  stale.
- Each repository retains independent SemVer under a coordinated TOSS OS
  program.
- No repository has more than one Active release at a time.
- Release publication requires explicit release approval plus current checks
  and reviews.
- Program completion prepares the next Draft without creating empty milestones
  or branches.
- Rebaseline preserves active and completed work, removes approved future
  assignments, creates no duplicate or deleted issues, and is idempotent.
- All contract, unit, integration, end-to-end, package, and release tests pass.

## Rollout Order

1. Land schemas, control-store contracts, pure state rules, and the second
   executable without touching production Project state.
2. Implement fake-adapter integration and isolated GitHub end-to-end tests.
3. Create and validate the private control repository and required Project
   fields through an explicit bootstrap preview and approval.
4. Complete and close the user-managed v2.1.2 release.
5. Generate and review the fresh rebaseline snapshot.
6. Apply rebaseline and reconcile all governed Project items.
7. Create `TOSS-OS-R0001` and bootstrap the first post-cutover TOSS CLI minor
   release for the TOSS Core epic.
8. Publish and verify the release, then use the published `toss-core` for future
   release programs.

## Design Summary

The design adds an organization control plane without creating a new runtime
service or abandoning GitHub as the operator view. Its key invariant is that
intent, branches, PR bases, review freshness, release scope, and visible issue
status describe the same revision at every accepted transition. When they do
not, TOSS Core stops, records the mismatch, and exposes the exact reconciliation
work instead of advancing silently.
