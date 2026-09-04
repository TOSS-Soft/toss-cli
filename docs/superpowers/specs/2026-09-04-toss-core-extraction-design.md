# TOSS Core Repository Extraction Design

**Date:** 2026-09-04

**Status:** Approved design

**Source baseline:** `TOSS-Soft/toss-cli` v2.1.2
**Target repository:** `TOSS-Soft/toss-core`

## 1. Context

The organizational lifecycle engine currently ships inside the product-oriented
`@toss-software/cli` package. That package exposes both `toss` and `toss-core`
executables even though the two programs have different responsibilities:

- `toss` bootstraps and governs an individual software project.
- `toss-core` governs work and release lifecycles across the TOSS Software
  organization.

TOSS Software currently owns at least these product repositories:

- `TOSS-Soft/toss-cli`
- `TOSS-Soft/toss-agent-runtime`
- `TOSS-Soft/toss-console`

The repository set is expected to grow. An organization-wide controller cannot
remain owned, versioned, or deployed as part of one of the products it governs.

The existing `TOSS-Soft/toss-core` repository is private and empty. It will
become the independent home of the control plane.

## 2. Decision Summary

1. `toss-core` becomes a standalone organization-level control CLI.
2. Product repositories do not contain Core source code, configuration files,
   SDK dependencies, or embedded runtime components.
3. The package is private `@toss-software/core`; its executable remains
   `toss-core`.
4. The package is distributed through GitHub Packages.
5. Core runs from a central CI workflow or an authorized operator machine.
6. GitHub access uses a least-privilege GitHub App and short-lived installation
   tokens, not persistent personal tokens.
7. Application code lives in `TOSS-Soft/toss-core`; immutable organizational
   state lives separately in `TOSS-Soft/toss-os-control`.
8. Relevant Git history is preserved during extraction.
9. `toss-cli` removes the embedded Core implementation immediately in v2.1.3;
   it does not retain a compatibility shim.
10. `toss-cli` is the first pilot repository. Existing open work is not adopted;
    Core ownership starts at an explicit cutover point.

## 3. Goals

- Give Core one repository, package, release cadence, and security boundary.
- Govern an arbitrary and increasing number of product repositories through
  data-driven registration.
- Preserve the reviewed domain, contract, intent, receipt, concurrency, and
  release-program behavior created in `toss-cli` v2.1.2.
- Add a production GitHub App adapter without coupling it to a product.
- Keep product repositories independent of Core implementation details.
- Preserve fail-closed preview, authority, revision, and receipt guarantees.
- Make extraction and product cleanup independently verifiable and reversible
  before publication.

## 4. Non-goals

- No shared Core SDK is added to product repositories.
- No `.toss-core.yml` or equivalent product-local configuration is introduced.
- No existing open issue, branch, pull request, review, or release program is
  automatically claimed during the pilot.
- No rewrite of the existing lifecycle model is included in extraction.
- No multi-repository hosted service is required for the first release; the
  first runtime is the CLI plus central CI.
- No compatibility wrapper remains in `@toss-software/cli` after v2.1.3.

## 5. Repository Responsibilities

### 5.1 `TOSS-Soft/toss-core`

Owns:

- Core command grammar and CLI rendering
- Work, dependency, review, and release state machines
- Operation planning, ordering, authority binding, and execution
- Control-store interfaces and Git-backed implementation
- GitHub port and GitHub App adapter
- Core JSON schemas and semantic validators
- Unit, contract, integration, and end-to-end tests
- Package and release workflows for `@toss-software/core`

Does not own:

- Product source code
- Product build or feature logic
- Organization ledger data
- Long-lived credentials

### 5.2 `TOSS-Soft/toss-os-control`

Remains the only source of truth for:

- Organization and Project identity
- Registered repository configuration
- Lifecycle and release policies
- Release-program manifests
- Immutable operation intents
- Completed and failed operation receipts

Application source and control ledger history must never share one repository.

### 5.3 Product repositories

`toss-cli`, `toss-agent-runtime`, `toss-console`, and future product repositories
own only their product code and ordinary GitHub resources. They do not contain
Core packages, Core adapters, Core policy files, or Core-specific repository
configuration.

Registration is performed centrally:

```text
toss-core repo add OWNER/REPO --from repository.json
```

Adding another product changes control data, not Core application code.

## 6. Target Architecture

```text
Authorized operator or central CI
                |
                v
          toss-core CLI
                |
        application commands
                |
     pure domain and projectors
                |
       ports / trust boundaries
          /             \
 GitHub App adapter   Git control-store adapter
          |             |
 Product GitHub data  toss-os-control
```

### 6.1 Domain layer

Contains pure rules for:

- Work identity, branching, state, and Project projection
- Dependency graph validation and readiness
- Review evidence and independence
- Semantic version selection
- Release programs, patch interruption, approval, and publication

It performs no network, filesystem, environment, or credential access.

### 6.2 Application layer

Implements the `init`, `repo`, `feature`, `issue`, `dependency`, `review`,
`epic`, `release`, and `program` command families. Commands request closed
snapshots through ports, call pure domain functions, and produce deterministic
operation plans.

### 6.3 Ports

Defines closed interfaces for:

- GitHub snapshot, inspect, and apply
- Control-state reads and compare-and-swap commits
- Authority lookup and verification
- Clock and deterministic identity generation
- Interactive confirmation and structured input

No product package is a port dependency.

### 6.4 Adapters

The initial adapters are:

- Production GitHub App adapter
- Git-backed `toss-os-control` adapter
- Stateful deterministic fake for tests
- Local CLI composition layer

The GitHub App adapter must conform to the same contract suite as the stateful
fake. A permissive fake cannot define production behavior.

### 6.5 CLI layer

Owns only argument parsing, preview/apply selection, interactive confirmation,
JSON/human rendering, and process exit mapping. Business rules remain below the
CLI boundary.

## 7. Initial Target Layout

```text
toss-core/
├── bin/
│   └── toss-core.js
├── contracts/
├── src/
│   ├── adapters/
│   │   ├── control-git/
│   │   └── github-app/
│   ├── commands/
│   ├── control/
│   ├── domain/
│   ├── operations/
│   ├── release/
│   ├── review/
│   ├── runtime/
│   └── work/
├── test/
├── scripts/
├── docs/
├── package.json
└── .github/workflows/
```

Canonical JSON, schema validation, YAML projection, and command-result rendering
are copied into Core-owned modules during extraction. `toss-core` must not import
`@toss-software/cli` or reach into the `toss-cli` repository.

## 8. History-preserving Extraction

The extraction starts from the exact `toss-cli` v2.1.2 commit. A temporary clone
is filtered to retain Core-owned paths and their relevant history:

- `bin/toss-core.js`
- `src/core/**`
- `contracts/core/**`
- Core test files and fixtures
- Core-owned test-manifest entries and boundary checks
- Minimal shared primitives required by Core
- This approved design and subsequent migration documentation

The filtered result is inspected before it is pushed to the empty target
repository. Shared primitives are then moved into Core-owned paths in a normal,
reviewable follow-up commit.

The extraction must not mutate or rewrite the history of the source
`TOSS-Soft/toss-cli` repository.

## 9. Package and Versioning

The independent package uses:

```json
{
  "name": "@toss-software/core",
  "bin": {
    "toss-core": "bin/toss-core.js"
  },
  "publishConfig": {
    "registry": "https://npm.pkg.github.com"
  }
}
```

Versioning policy:

- Extraction and adapter development use `0.x` versions.
- `1.0.0` requires the production GitHub App adapter and successful `toss-cli`
  pilot acceptance.
- `toss-cli` removes its Core files and executable in v2.1.3, as an explicitly
  approved correction to an incorrectly placed v2.1.2 feature.

The v2.1.3 release notes must state that `toss-core` moved to the private
`@toss-software/core` package and is no longer included in
`@toss-software/cli`.

## 10. GitHub App Security Model

One organization GitHub App supplies production repository access. It is
installed only on repositories managed by Core and uses short-lived
installation tokens.

Minimum permission families are:

- Repository metadata: read
- Contents and branches: read/write where lifecycle operations require it
- Issues: read/write
- Pull requests and reviews: read/write
- Checks and Actions: read
- GitHub Projects: read/write
- Releases and workflows: restricted operations needed by publication

Exact permissions must be justified by adapter operations and verified in an
installation preflight. The App must not request organization-wide write access
when repository-scoped access is sufficient.

Security rules:

- Tokens and private keys are never persisted in `toss-os-control`.
- CI secrets are accessed only while producing an installation token.
- A GitHub identity does not replace signed Core authority.
- Authority remains command-, target-, policy-, and revision-bound.
- Read and dry-run paths cannot call mutation endpoints.
- Repository identity is checked at every snapshot and operation boundary.

## 11. Transaction and Failure Model

Every mutation follows this order:

1. Load one atomic control-state revision.
2. Read a closed, revision-bound GitHub snapshot.
3. Produce a deterministic operation intent and preview.
4. Obtain confirmation and authority where required.
5. Re-inspect every precondition before the first mutation.
6. Persist or reserve the intent and receipt identity as required.
7. Apply remote operations in semantic order.
8. Persist an immutable completed or failed receipt.
9. Atomically advance manifests with the receipt where required.

Any stale or malformed evidence fails closed. A partial remote result must be
recorded and must block an unsafe retry until reconciled. Evidence from one
repository, Project, release, or authority scope cannot be reused for another.

## 12. Product-repository Registration

Repository configuration is stored only in `toss-os-control`. The registration
input includes:

```json
{
  "default_branch": "main",
  "project_owner": "TOSS-Soft",
  "project_number": 7,
  "publication": {
    "package_name": "@toss-software/example",
    "workflow": "publish.yml",
    "required_assets": []
  }
}
```

Registration preflight verifies:

- Canonical repository identity
- GitHub App installation and required permissions
- Default branch identity and protection
- Organization Project identity and required fields
- Publication workflow and policy identity
- Absence of conflicting active ownership

## 13. Migration Phases

### Phase 1: Extract without behavior changes

- Filter the Core history from v2.1.2.
- Push it to a review branch in `TOSS-Soft/toss-core`.
- Restore the complete Core test matrix.
- Internalize shared primitives and remove all `toss-cli` imports.
- Publish no stable package.

### Phase 2: Remove Core from `toss-cli`

- Delete the embedded Core source, contracts, tests, and binary.
- Remove the `toss-core` package bin entry.
- Remove Core-only scripts and manifest ownership.
- Prove the remaining `toss` CLI package and release artifact are complete.
- Publish the correction as `@toss-software/cli@2.1.3`.

Phase 2 begins only after the extracted Core branch independently passes all
tests. The two repositories use separate commits and pull requests.

### Phase 3: Add the production adapter

- Create and configure the GitHub App.
- Implement snapshot, inspect, and apply through explicit ports.
- Add adapter contract and hostile-boundary tests.
- Add central CI preview and apply workflows.
- Publish private prerelease versions of `@toss-software/core`.

### Phase 4: Pilot `toss-cli`

- Select an explicit cutover timestamp and exact default-branch commit.
- Allow pre-cutover open work to finish outside Core ownership.
- Register `TOSS-Soft/toss-cli` in `toss-os-control`.
- Run repository status and release planning in dry-run mode.
- Create and complete one new Core-managed feature lifecycle.
- Complete one release lifecycle and verify all receipts.

### Phase 5: Expand the registry

After pilot acceptance:

- Register `TOSS-Soft/toss-agent-runtime`.
- Register `TOSS-Soft/toss-console`.
- Publish `@toss-software/core@1.0.0`.
- Onboard future repositories through the same registration operation.

## 14. Cutover Rules

- The pilot cutover is forward-only.
- Core does not add ownership markers to pre-cutover work.
- Existing open issues and pull requests continue under their current process.
- New work created after cutover must use Core commands.
- Existing published versions are read as the lower bound for future SemVer
  selection.
- Any ambiguous pre-existing branch, milestone, release, or Project identity
  blocks mutation and requires an explicit operator decision.

## 15. Verification Strategy

### Extracted Core acceptance

- Every migrated Core test passes in `toss-core`.
- Test ownership and manifest inventory are closed and unique.
- The package contains only Core files and both human/JSON CLI paths work.
- No production import references `toss-cli`.
- Import graph is cycle-free.
- Package version and executable metadata are consistent.

### `toss-cli` v2.1.3 acceptance

- No `src/core`, `contracts/core`, or `bin/toss-core.js` remains.
- Package metadata exposes only the intended `toss` executable.
- Packed-artifact tests prove Core files are absent.
- Existing non-Core fast, integration, package, release, and full lanes pass.
- Release notes explain the correction and the new package location.

### Adapter acceptance

- Fake and GitHub App adapters pass one shared contract suite.
- Preview and dry-run make zero remote writes.
- Stale revisions make zero later writes.
- Partial failures persist exact observations and block unsafe replay.
- Restarted processes can replay serialized intents without memory-only state.
- Cross-repository, Project, release, and authority substitutions fail closed.

### Pilot acceptance

- `repo add` is idempotent for the exact registered identity.
- `repo list`, work status, release status, and program status are read-only.
- One feature-to-release lifecycle completes through the GitHub App.
- Control intents, receipts, manifests, and GitHub state reconcile exactly.
- No pre-cutover work is modified.

## 16. Rollback

Before package publication, rollback is deletion of the target review branch and
no source repository is changed.

After `toss-cli` v2.1.3 but before pilot ownership, rollback means installing a
known `@toss-software/cli@2.1.2` artifact for historical access; Core data has not
claimed product work.

After pilot ownership begins, rollback cannot erase intents or receipts. The
safe path is to stop new mutations, reconcile any partial transaction, and
disable the GitHub App installation only after the ledger is consistent.

## 17. Success Criteria

The migration is complete when:

1. `TOSS-Soft/toss-core` independently builds, tests, packages, and releases
   `@toss-software/core`.
2. `@toss-software/cli@2.1.3` contains no Core implementation or executable.
3. `toss-os-control` remains the single organizational state ledger.
4. The GitHub App can safely preview and execute the complete Core lifecycle.
5. `toss-cli` completes the pilot without altering pre-cutover work.
6. `toss-agent-runtime` and `toss-console` can be registered without changing
   Core application code.
