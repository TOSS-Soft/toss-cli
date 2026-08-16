# Remediation Iteration 2 Report — Final Atomicity and Overlay Integrity

**Date:** 2026-08-15

**Branch:** `agent/modular-governance-v2-design`

**Required base:** `a2a1f43e4a3c033f324925e3da3d218eaf519d3a`

**Implementation commit:** `ed8feb3b06bc5277ece25af831f8230d7c2bc494`

## Outcome

All three Important findings in `remediation-2-brief.md` are resolved with
regression-first coverage. The implementation keeps the approved Core and
optional Delivery architecture, provider-neutral Superpowers boundary, and
version `2.0.0` unchanged. It does not add Assurance.

Every CLI-generated local file is now written through the descriptor-based
contained/no-follow writer. The final initial bytes for `project.json`,
`PROJECT_STATE.md`, the main-ruleset payload, and Project Brief context are
built and serialized before destination creation or overwrite. Cyclic Project
Brief data therefore fails before mutation. Same-profile `--force` rejects the
complete historical set of no-longer-generated governance paths, narrowly
fingerprinted legacy configuration, legacy state, and retained legacy Project
Brief context while still accepting a clean same-profile refresh.

An independent review of the final implementation reported 0 Critical,
0 Important, and 0 Minor findings and assessed the change ready to commit.

No product tag, publish, push, pull request, or release was performed.

## Scope and Files

The focused implementation commit changes only:

- `src/cli.js`
- `src/profile-assets.js`
- `scripts/create-atomicity-test.js`
- `scripts/overlay-safety-test.js`
- `scripts/project-state-hydration-test.js`
- `package.json` (adds the atomicity regression to the existing test chain)

No governance template, manifest, package version, lockfile version, release
metadata, or Assurance implementation changed.

## Finding 1 — Every post-copy local write is contained

### Root cause

The profile/runtime copy used `writeContainedFiles()`, but later code returned
to pathname-based reads and writes for governance profile state, bootstrap
state, hydrated `PROJECT_STATE.md`, the ruleset, and Project Brief context. A
target swapped to a symlink after initial preflight could therefore receive a
later write outside the destination.

### RED

The regression was added before the production change and run with:

```text
node --test --test-name-pattern="post-preflight project.json symlink swap" ./scripts/create-atomicity-test.js
```

It exited 1. The deterministic import hook swapped the descriptor-written
`project.json` for a symlink before the next target open. The unremediated CLI
exited 0, printed `PROJECT BOOTSTRAP COMPLETE`, and changed the outside JSON
sentinel by writing profile/bootstrap state through the symlink.

### GREEN

- `createFromConfig()` now builds one unique initial asset batch containing
  profile assets, rendered runtime assets, final initial `project.json`, final
  initial `PROJECT_STATE.md`, ruleset JSON, and Project Brief context JSON.
- Initial output, `toss init`, and every later remote-state update use
  `writeContainedFiles()`; direct pathname-based CLI output writers were
  removed.
- `writeContainedFiles()` postflights all written targets, so a target swapped
  after its descriptor write is detected before success is reported.
- Repository, GitHub Project, and ruleset results are persisted separately
  after each successful external operation. Each persistence reopens and
  revalidates `project.json` and `PROJECT_STATE.md` through the same contained
  writer.

The same command then exited 0 with one passing test. In the complete
standalone matrix, the symlink swap occurred, the outside sentinel remained
byte-identical, the CLI exited nonzero, and no completion banner was present.

Source audit:

```text
rg -n "writeFileSync" src
```

Only the descriptor-based write in `src/profile-assets.js` remains; there are
no direct file writes in `src/cli.js`.

## Finding 2 — Non-serializable Project Briefs fail before mutation

### Root cause

The YAML parser accepts recursive aliases and returns a cyclic JavaScript
object. Project Brief context was first JSON-stringified only after governance
files, runtime files, state, ruleset data, and potentially Git state had been
created. Under `--force`, the same late exception occurred after existing
targets had already changed.

### RED

Fresh destination:

```text
node --test --test-name-pattern="rejected before creating" ./scripts/create-atomicity-test.js
```

It exited 1. A brief containing:

```yaml
constraints: &loop
  - *loop
```

created the destination and reached a circular-structure `JSON.stringify`
failure only after output and Git mutation.

Same-profile force:

```text
node --test --test-name-pattern="preserves same-profile force targets" ./scripts/create-atomicity-test.js
```

It exited 1 because at least `project.json` differed from its pre-command byte
snapshot after the cyclic input was rejected.

### GREEN

- `buildBriefContext()`, `buildRulesetPayload()`, project-state hydration, and
  Project Brief state application are pure in-memory derivations.
- `serializeJson()` validates and finalizes Project Brief, project-state JSON,
  and ruleset bytes before destination validation that can create anything.
- A cyclic brief reports the concise error
  `Project Brief is not JSON-serializable.`
- The fresh destination remains absent.
- Under same-profile `--force`, `project.json`, `PROJECT_STATE.md`,
  `main-ruleset.json`, and `PROJECT_BRIEF.json` remain byte-for-byte unchanged.

Both targeted commands then exited 0. The complete atomicity file reports four
passing tests and no failures.

## Finding 3 — Exhaustive retired governance/Assurance force refusal

### Root cause

The old force guard named only seven legacy markers. Historical tree and CLI
output inspection established that v1 generated 44 paths that v2 no longer
generates: 40 under `project-management/**`, two governance workflows, and two
plausibly user-owned configuration examples. As a result, a same-profile force
refresh accepted retained Trusted Evaluator, LangSmith, benchmark,
certification, policy, record, and bootstrap assets.

### RED

The table-driven regression was added before expanding the validator:

```text
node ./scripts/overlay-safety-test.js
```

It exited 1 at the first reproduced path:

```text
same-profile retired residue project-management/TRUSTED_EVALUATOR_ARCHITECTURE.md unexpectedly succeeded
```

The CLI returned status 0 and retained the retired file.

### GREEN

- The validator uses an explicit, anchored inventory of all 42 safe
  existence-level blockers: 40 former `project-management/**` outputs and the
  two former governance workflows.
- `.env.example` is rejected only when it carries the old generated
  `LANGSMITH_PROJECT` plus secret-store-comment fingerprint.
- `.claude/settings.local.json.example` is parsed without following the final
  path and rejected only for the v1-specific `TRACE_TO_LANGSMITH` and
  `CC_LANGSMITH_*` environment-key combination.
- Legacy `project.json` own-state markers are rejected, including top-level
  `governance_version`/`langsmith`, Trusted Evaluator state, LangSmith state,
  and Assurance fields/profile state.
- The reused `project-management/bootstrap/PROJECT_BRIEF.json` is read through
  a no-follow descriptor and rejected when it retains the v1 top-level
  `langsmith` object.
- Refusals identify the offending path/state and direct the operator to the
  manual v2 migration guide before any output write.
- Negative controls prove an ordinary application `.env.example`, unrelated
  Claude settings, and a clean same-profile Core refresh remain supported.

The completed overlay matrix independently exercises every one of the 42
exact paths, both content fingerprints, all seven legacy `project.json`
markers, the reused Project Brief context marker, profile-transition refusals,
clean same-profile force, and runtime-target symlink refusal. It exits 0 with
`Force overlay safety test: PASS`.

The inventory deliberately does not reject never-shipped evaluator scripts or
an uncorroborated `governance-certification` ruleset context: those may belong
to a real external evaluator, which the migration contract explicitly allows.

## Review-Discovered Same-Scope Regressions

The independent review found three additional edges inside the remediation
boundary. Each was verified rather than accepted on assertion.

### Typed JSON metadata

RED:

```text
node --test --test-name-pattern="JSON-significant metadata" ./scripts/create-atomicity-test.js
```

The unremediated path exited 1 with
`Expected ',' or '}' after property value in JSON at position 68` for valid
quoted/newline/backslash metadata and also allowed a user value containing a
later placeholder to be substituted a second time.

GREEN: `templates/project.json` is parsed before user-data assignment; name,
slug, description, owner, and visibility are assigned as JavaScript values and
serialized once. The test exits 0 and proves all values survive literally.

### Durable partial remote recovery state

RED:

```text
node ./scripts/project-state-hydration-test.js
```

With repository creation succeeding and the following GitHub Project call
injected to fail, the assertion observed `PENDING` instead of the expected
`CREATED` repository state.

GREEN: each successful remote action is persisted immediately through the
contained writer. The injected later failure leaves repository state
`CREATED`, GitHub Project state `PENDING`, and the canonical repository URL in
`PROJECT_STATE.md`. The successful fixture also exercises repository, GitHub
Project, and ruleset success and asserts `ruleset: APPLIED`.

### Reused Project Brief legacy context

RED: the overlay matrix added a top-level v1 `langsmith` object to a clean v2
`PROJECT_BRIEF.json`; same-profile force exited 0 and overwrote it.

GREEN: force preflight now detects that structured legacy marker using a
no-follow read, rejects with the exact path and manual-migration direction,
and preserves both Project Brief context and `project.json` bytes.

## Verification Evidence

### Complete source and packed-artifact chain

```text
node --run test
```

Exit 0:

```text
Governance configuration test: PASS
Profile assets test: PASS
TOSS CLI smoke test: PASS
Generated reference integrity test: PASS
create atomicity: tests 4, pass 4, fail 0
Force overlay safety test: PASS
Project state hydration test: PASS
governance contract: tests 4, pass 4, fail 0
Packed artifact execution test: PASS
```

The artifact test uses npm's installed `libnpmpack`, inspects and extracts the
actual tarball, supplies the declared `yaml` runtime dependency, executes both
structured Core+Delivery creation and fast scaffolding from the extracted
package, and validates both generated projects with the packed validator. It
also removes a required runtime template from an extracted copy and proves the
damaged package fails without creating its destination.

### Standalone adversarial and artifact matrix

```text
node --test ./scripts/create-atomicity-test.js && \
node ./scripts/overlay-safety-test.js && \
node ./scripts/project-state-hydration-test.js && \
node ./scripts/package-artifact-test.js
```

Exit 0:

```text
create atomicity: tests 4, pass 4, fail 0
Force overlay safety test: PASS
Project state hydration test: PASS
Packed artifact execution test: PASS
```

This directly covers the required post-preflight symlink swap, recursive YAML
fresh and force modes, exhaustive retired-residue refusal, clean force refresh,
partial remote failure recovery, ruleset success, packed structured creation,
and packed fast scaffolding.

### Static and repository checks

All exited 0:

```text
node --check src/cli.js
node --check src/profile-assets.js
node --check scripts/create-atomicity-test.js
node --check scripts/overlay-safety-test.js
node --check scripts/project-state-hydration-test.js
git diff --check a2a1f43e4a3c033f324925e3da3d218eaf519d3a..ed8feb3b06bc5277ece25af831f8230d7c2bc494
```

`git tag --points-at ed8feb3b06bc5277ece25af831f8230d7c2bc494`
produced no output. Package, lockfile, Core manifest, Delivery manifest, and CLI
governance version remain `2.0.0`. The implementation tree was clean before
the report-only commit.

## Independent Review

The final reviewer examined the live diff and reran the complete test chain,
syntax checks, and diff check. Final assessment:

```text
Critical: 0
Important: 0
Minor: 0
Ready to commit: Yes
```

The review specifically confirmed contained initial and remote-state writes,
pre-mutation serialization, typed JSON metadata, atomic cyclic-YAML failure,
the retired-residue inventory and false-positive controls, per-step remote
recovery persistence, successful ruleset persistence, unchanged version, and
unchanged product/release scope.

## Self-Review and Concerns

No blocking concerns remain.

- The residue validator is intentionally explicit rather than a broad keyword
  or directory scan. This avoids rejecting ordinary application code, custom
  CI, or a real external evaluator while covering every historically generated
  retired path and high-confidence structured legacy state.
- Common user-owned examples are content-gated instead of rejected merely for
  existing. This is a deliberate false-positive boundary.
- Filesystem batches are not a general multi-file transaction. The writer
  preflights the entire target set and protects every open/write with
  containment, no-follow, and identity checks; an adversarial race therefore
  cannot redirect a write outside the project or produce a success result in
  the reproduced case. Deterministic input failures, including cyclic YAML,
  occur before the first destination mutation.
- Remote APIs are inherently non-transactional. Persisting each completed
  external stage immediately provides truthful recovery state if a later stage
  fails.
- No architectural expansion, Assurance implementation, version change, tag,
  publication, push, pull request, or release was performed.
