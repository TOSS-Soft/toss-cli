# Modular Governance v2 Final Fix Report

**Date:** 2026-08-15

**Branch:** `agent/modular-governance-v2-design`

**Final-review base:** `2b680f6d6bbb0ee8bbc7a4371ff7a7328bb152a3`

**Implementation commit:** `8f81bc85aba970ed4900312d69c8e95833e15d12`
**Scope:** one Critical, seven Important, and two Minor findings from
`final-branch-review.md`, plus the atomicity defects found during the final
independent rerun.

## Outcome

All ten review findings are resolved. Both supported creation modes execute
from a freshly built npm tarball. Generated Core and Delivery projects now have
truthful profile/recovery state, contained source and destination handling,
non-hybrid overwrite behavior, complete authority and security contracts,
valid assignment records, and reference-integrity-valid bootstrap context.

No Minor exception was necessary. Provider neutrality is preserved, no
Assurance implementation was added, and no product-repository tag, publish,
push, pull request, or release was performed.

## Finding-by-Finding Resolution

### Critical 1 — Packed `2.0.0` generation and partial mutation

Resolution:

- Renamed the runtime source from `templates/.gitignore` to the pack-safe
  `templates/gitignore.template` while retaining `.gitignore` as the generated
  destination.
- Replaced the open-ended root copy/render walk with an explicit runtime asset
  inventory.
- Loaded and validated every runtime and profile source before destination
  mutation.
- Added a real tarball test built with npm's installed `libnpmpack`, extracted
  it with npm's installed tar implementation, installed the declared `yaml`
  dependency into the extracted fixture, and executed both `toss create` and
  the fast scaffold from the packed tree.
- Added a damaged-package probe proving a missing runtime source fails without
  creating the destination.

RED evidence: the first packed execution regression reported
`packed CLI partially created a destination... true !== false`; the tarball
omitted `templates/.gitignore` and generation had already written files.

GREEN evidence: `node scripts/package-artifact-test.js` prints
`Packed artifact execution test: PASS`; both packed entry points complete and
their generated projects pass reference validation.

### Important 1 — Profile source/destination symlink containment

Resolution:

- Profile roots, manifests, source ancestors, source files, destination roots,
  destination ancestors, and destination files are inspected with `lstat`.
- Source files are opened with no-follow semantics, checked with `fstat`,
  canonical containment, and device/inode identity, then read through the
  validated descriptor.
- All profile content is buffered before destination writes.
- Destination targets use canonical containment, no-follow descriptor opens,
  identity checks, and descriptor-based truncation/writes.
- The complete Core + optional Delivery + runtime target set is preflighted
  together before any file write.
- Target preflight is read-only: it plans missing paths without creating them,
  rejects all existing unsafe targets, and only then creates parents. Targets
  are re-inspected after parent creation and before writes.
- Runtime-template sources and destinations use the same containment model,
  closing the equivalent non-profile escape found during final review.

RED evidence:

- A source-file symlink was initially accepted instead of throwing.
- A destination ancestor symlink redirected output outside the project.
- A later unsafe target allowed an earlier profile file to be overwritten.
- A generated `README.md` symlink initially produced exit 0 and overwrote an
  outside sentinel.
- The final read-only-preflight regression initially failed with
  `target preflight created an earlier missing directory before refusal`.

GREEN evidence: `node scripts/profile-assets-test.js` and
`node scripts/overlay-safety-test.js` pass. Outside sentinels remain unchanged,
earlier files remain unchanged on late refusal, and missing earlier directories
are not created.

### Important 2 — Hydrated Delivery and durable recovery state

Resolution:

- `PROJECT_STATE.md` now has a profile-state placeholder hydrated from the
  exact resolved profile object (`INSTALLED` or `NOT_SELECTED`).
- Added an explicit durable Decision Summary with active, protected, and
  last-updated fields.
- Added a canonical `GitHub Project` recovery-state field.
- Core and Delivery smoke fixtures assert the state/profile agreement.

RED evidence: fresh Delivery output retained `Status: NOT_SELECTED`, and the
canonical state had no durable Decision Summary or GitHub Project slot.

GREEN evidence: `node scripts/smoke-test.js` asserts exact Core and Delivery
states; `node scripts/project-state-hydration-test.js` passes against a
temporary local Git/GitHub-CLI fixture.

### Important 3 — Ambiguous `--force` overlays

Resolution:

- `--force` recognizes only a non-empty, internally consistent governance v2
  project with a regular `project.json`.
- It rejects Core-to-Delivery and Delivery-to-Core transitions.
- It rejects v1/legacy markers and legacy state instead of creating a hybrid.
- It rejects Delivery file presence that contradicts declared profile state,
  including dangling symlink entries.
- Same-profile refresh remains supported and is covered by regression tests.

RED evidence: the new overlay matrix reproduced acceptance/generic overwrite
behavior instead of a profile-aware refusal and demonstrated the hybrid-output
risk.

GREEN evidence: `node scripts/overlay-safety-test.js` passes all Core-to-
Delivery, Delivery-to-Core, v1-to-v2, same-profile, and runtime-symlink cases;
refused projects retain their original state and policy contents.

### Important 4 — Verified-CEO production authority

Resolution:

- Restored explicit verified-CEO authorization for main-branch merge,
  production deployment, and production-data mutation.
- Preserved only a narrow, exact, previously recorded recovery exception for
  the applicable recovery action; recovery never grants merge authority.
- Explicitly separated technical review, code review, merge authorization,
  release approval, deployment authorization, rollout authority,
  production-data authority, recovery authority, and technical execution.
- Split Release and Datafix record sections so distinct authorities cannot be
  collapsed into a generic approval field.

RED evidence: the initial authority semantic regression failed because the v2
documents only required unspecified recorded authority and lacked distinct
record fields.

GREEN evidence: the authority case in
`node --test scripts/governance-contract-test.js` passes, including explicit
negative language for review-to-merge inference and recovery-to-merge
inference.

### Important 5 — Core and Delivery security ownership

Resolution:

- Core `QUALITY.md` now requires dependency/build-input review for necessity,
  provenance, integrity, known vulnerabilities, install/build behavior, and
  lockfile consistency; material or unknown risk blocks Done absent a scoped
  evidence-backed waiver.
- Delivery `DELIVERY.md` now requires risk-based review depth and independent
  security review for HIGH/CRITICAL security-impact candidates, with a
  qualified reviewer independent of implementation and disposition of every
  material finding.

RED evidence: the security ownership semantic regression initially found
neither contract.

GREEN evidence: the Core/Delivery ownership case in
`scripts/governance-contract-test.js` passes against an actually generated
Delivery project.

### Important 6 — Complete Task assignment boundary

Resolution: added `Workspace`, `Environment`, `Allowed Actions`, and
`Escalation Conditions` to `TASK.md`, retaining the existing authority,
prohibited-action, scope, evidence, and closure fields.

RED evidence: the Task semantic regression initially failed on all four
missing fields.

GREEN evidence: the Task assignment-boundary case in
`scripts/governance-contract-test.js` passes.

### Important 7 — Reference integrity and fast scaffold

Resolution:

- Fast scaffold now writes a truthful
  `project-management/bootstrap/PROJECT_BRIEF.json` with
  `input_mode: FAST_SCAFFOLD_ARGUMENTS`, only known fast-path inputs, Core
  profile state, and `design.required: AUTO`.
- It also installs `PROJECT_BRIEF_GUIDE.md` and records
  `bootstrap_state.project_brief: FAST_SCAFFOLD_ARGUMENTS`.
- Reference validation now covers the fast path.
- Added typed validation for the known path-bearing JSON fields
  `project.json.governance.root` (directory) and
  `project.json.governance.global_agent_catalog` (file), including lexical and
  canonical containment, existence, and expected type.

RED evidence:

- The fast scaffold failed validation on the missing Project Brief reference.
- Mutating `global_agent_catalog` to a nonexistent path did not throw.

GREEN evidence: `node scripts/reference-integrity-test.js` passes Core,
Delivery, fast scaffold, missing JSON paths, and symlink-escape cases. The
packed test validates both packed outputs with the packed validator.

### Minor 1 — GitHub Project URL hydration

Resolution: restored `GitHub Project: NONE` in canonical state and persist the
returned project URL after project creation.

RED evidence: the URL replacement target did not exist and the URL was
discarded.

GREEN evidence: `node scripts/project-state-hydration-test.js` verifies both
the repository URL and `https://github.com/orgs/example-owner/projects/42` in
`PROJECT_STATE.md`, plus the two `CREATED` bootstrap flags.

### Minor 2 — Agent Registry status vocabulary

Resolution: removed the synthetic `NONE` data row and represented the initial
registry as explicitly empty, leaving only declared statuses for actual rows.

RED evidence: the registry semantic regression found the undeclared `NONE`
status.

GREEN evidence: the registry case in
`scripts/governance-contract-test.js` passes and rejects recurrence of the old
row.

## Additional Failure-Atomicity Regressions

The first independent fix review found three blockers beyond the original
finding probes:

1. a same-profile runtime `README.md` symlink could overwrite an outside file;
2. a late unsafe profile target could be discovered after earlier governance
   files were overwritten;
3. `--github-project` or `--ruleset` without repository creation failed only
   after writing a partial project.

The second review found that the target-validation pass itself created an
earlier missing directory before refusing a later symlink. All four now have
regressions. Runtime/profile targets are combined and inspected before writes,
preflight inspection is non-mutating, and deterministic remote/git option and
tool/authentication requirements run before destination creation.

The independent final rerun reported no Critical, Important, or Minor findings
and returned **READY**.

## Verification Evidence

### Complete source and artifact chain

`node --run test` — PASS:

- `Governance configuration test: PASS`
- `Profile assets test: PASS`
- `TOSS CLI smoke test: PASS`
- `Generated reference integrity test: PASS`
- `Force overlay safety test: PASS`
- `Project state hydration test: PASS`
- four of four governance semantic tests pass
- `Packed artifact execution test: PASS`

### Packed artifact matrix

`node scripts/package-artifact-test.js` — PASS.

The test builds a fresh `2.0.0` tarball through npm's installed packing
implementation, checks `package/templates/gitignore.template`, extracts the
artifact, and executes:

- packed `toss create` with Delivery enabled;
- packed fast scaffold with Core only;
- packed damaged-source failure with no partial destination;
- reference validation from the packed validator for both successful outputs.

The shell-level `npm pack --dry-run --ignore-scripts` command was attempted but
the execution environment stopped it before npm ran with
`network approval was cancelled before a decision was returned`. This does not
replace or weaken the artifact test: the test directly invokes npm's installed
`libnpmpack` against the working tree and executes the resulting tarball.

### Adversarial probes

The following direct chain passes:

```text
node scripts/reference-integrity-test.js
node scripts/overlay-safety-test.js
node scripts/profile-assets-test.js
node scripts/governance-config-test.js
```

It covers source-file and ancestor symlinks, destination-root/file/ancestor
symlinks, ordered late-target failure atomicity, runtime target symlinks,
ambiguous profile/legacy overlays, invalid remote flag combinations, fast
references, missing structured paths, and canonical-path escapes.

### Version, forbidden, ownership, and scope checks

- Package, root lock entry, Core manifest, Delivery manifest, and CLI
  governance versions are `2.0.0`.
- Generated templates contain none of: LangSmith, Klinik360, o3-mini, Claude
  Code Trajectory, Trusted Evaluator, or governance-certification.
- `templates/governance` contains no `superpowers:*` capability ownership
  token, provider name, or Assurance implementation.
- `git diff --check 2b680f6d6bbb0ee8bbc7a4371ff7a7328bb152a3`
  passes.
- `git diff --check c899211e05e7d8aa14a0bd286de371e661e20387`
  passes.
- No tag points at the implementation commit.

## Self-Review

- Reviewed the complete 24-file implementation diff against the final-review
  base and ran `git diff --check` both before staging and on the staged diff.
- Confirmed the gitignore change is a 100% rename with an explicit source-to-
  destination mapping, not a content change.
- Confirmed manifests remain the source of profile membership while runtime
  assets are explicit and finite.
- Confirmed Core and Delivery source bytes are buffered before any file write,
  and target inspection covers both profiles plus every later CLI-authored
  file.
- Confirmed same-profile refresh is still available while profile transitions,
  legacy overlays, contradictory state, symlink roots, and unrecognized
  destinations are refused.
- Confirmed generated governance stays provider-neutral and that no Assurance
  runtime, evaluator, workflow, or fallback was introduced.
- Confirmed test-only Git/GitHub behavior is isolated to temporary local bare
  repositories and a fake `gh`; the product repository was not pushed.

## Concerns and Exceptions

No known blocking concern or finding exception remains.

External GitHub operations cannot be transactionally rolled back across local
and remote systems. The CLI now validates every deterministic option/tool/auth
precondition before local mutation; a later provider/network rejection remains
an external operational failure and is not represented as a successful
bootstrap.

The only verification-environment limitation was the intercepted shell-level
`npm pack --dry-run` invocation described above. Fresh npm tarball construction,
inspection, extraction, and execution completed successfully through the
installed npm packing libraries.
