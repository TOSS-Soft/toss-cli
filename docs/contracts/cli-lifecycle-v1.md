# TOSS CLI Lifecycle Contract v1

## Status and Scope

This document is the normative `cli-lifecycle-v1` contract for the TOSS
v2.1 lifecycle command surface. The key words **MUST**, **MUST NOT**,
**SHOULD**, and **MAY** are to be interpreted as requirements.

This contract declares command grammar, option applicability, safety class,
interaction behavior, output streams, exit codes, machine results, help, and
completion vocabulary. Later command-handler issues implement domain behavior
behind this boundary. A declared command without a handler MUST fail with
`NOT_IMPLEMENTED`; it MUST NOT infer success or mutate project or external
state.

The established `init`, `create`, fast-scaffold, and raw `trace` interfaces are
compatibility interfaces. Their output MUST NOT be silently changed to a
`command-result.v1` envelope.

## Grammar and Command Matrix

Options use the exact long names in this document. Options MAY follow
positional arguments. Every option MAY occur at most once. Values for
`--from` and `--project` MUST be separate, non-empty arguments; `--name=value`
syntax is not part of v1. Extra positional arguments, missing positional
arguments, unknown options, and unknown commands are usage failures.

| Command | Required positional arguments | Allowed options | Safety | Prompt-capable |
| --- | --- | --- | --- | --- |
| `project create` | none | `--from`, `--non-interactive`, `--json`, `--project` | mutating | yes |
| `project analyze` | none | `--from`, `--non-interactive`, `--json`, `--continue`, `--project` | mutating | yes |
| `project prepare` | none | `--from`, `--non-interactive`, `--json`, `--continue`, `--project` | mutating | yes |
| `project status` | none | `--json`, `--project` | read-only | no |
| `project resume` | none | `--non-interactive`, `--json`, `--continue`, `--project` | mutating | yes |
| `feature add` | none | `--from`, `--non-interactive`, `--json`, `--project` | mutating | yes |
| `feature analyze` | none | `--from`, `--non-interactive`, `--json`, `--continue`, `--project` | mutating | yes |
| `feature prepare` | none | `--from`, `--non-interactive`, `--json`, `--continue`, `--project` | mutating | yes |
| `feature status` | none | `--json`, `--project` | read-only | no |
| `decisions list` | none | `--json`, `--project` | read-only | no |
| `decisions answer` | `<QUESTION-ID>` | `--from`, `--non-interactive`, `--json`, `--project` | mutating | yes |
| `architecture review` | none | `--non-interactive`, `--json`, `--continue`, `--project` | mutating | yes |
| `architecture approve` | `<ADR-ID>` | `--from`, `--non-interactive`, `--json`, `--project` | mutating | yes |
| `plan show` | none | `--json`, `--project` | read-only | no |
| `audit run` | none | `--json`, `--continue`, `--project` | mutating | no |
| `readiness check` | none | `--json`, `--project` | read-only | no |
| `issues preview` | none | `--json`, `--project` | read-only | no |
| `issues publish` | none | `--from`, `--non-interactive`, `--json`, `--project`, `--apply` | read-only unless `--apply`; mutating with `--apply` | yes |
| `trace` | `<ENTITY-ID>` | `--json`, `--project` at the lifecycle dispatch boundary; raw compatibility syntax is specified below | read-only | no |
| `artifacts list` | none | `--json`, `--project` | read-only | no |
| `artifacts inspect` | `<ARTIFACT-ID>` | `--json`, `--project` | read-only | no |
| `validate` | `<FILE>` | `--json`, `--project` | read-only | no |

"Read-only" means that the command MUST NOT write project artifacts, local
state, repositories, or external services. "Mutating" means the eventual
handler MAY perform the documented local mutation after its domain gates pass;
classification is not permission to perform unrelated mutation. In
particular, `issues publish` without `--apply` is a dry-run and MUST remain
read-only. Only `issues publish --apply` may reach a GitHub mutation adapter.

## Shared Option Semantics

- `--from <FILE>` supplies JSON or YAML input to commands that declare it.
  Parsing the file and domain validation belong to the handler. The router
  MUST NOT read the file.
- `--non-interactive` disables prompts. If required input, a decision, an
  approval, or authority evidence is missing, the handler MUST fail closed
  with `INVALID_INPUT` or `BLOCKED`; it MUST NOT select a default silently.
- `--json` selects the machine stream contract below.
- `--continue` asks the handler to continue from the last independently
  verified revision. It MUST NOT mean "skip validation". `--continue` and
  `--from` are mutually exclusive in v1 because one resumes verified input and
  the other supplies fresh input.
- `--project <PATH>` selects an explicit project root. It MUST NOT weaken path,
  artifact-store, or symlink validation.
- `--apply` is valid only for `issues publish`. On every other command it is an
  invalid option. It does not bypass readiness, audit, source-revision, design,
  or authority gates.

An option used on a command that does not list it in the matrix is invalid.
For example, `project prepare --apply` and `project status --from input.yaml`
MUST fail with `USAGE` before a handler or store is called.

Prompt-capable commands operate interactively by default. With
`--non-interactive`, their parsed `interactive` property is `false` and a
handler MUST return a closed nonzero outcome instead of prompting for missing input.
Commands not marked prompt-capable reject `--non-interactive`; callers do not
need to restate non-interactivity for commands that never prompt.

## Stable Exit Codes

| Symbol | Code | Meaning |
| --- | ---: | --- |
| `SUCCESS` | 0 | The requested operation completed successfully. |
| `USAGE` | 2 | Command, argument, option, duplicate, or combination is invalid. |
| `INVALID_INPUT` | 3 | Supplied file or domain input is missing, malformed, or unacceptable. |
| `BLOCKED` | 4 | A required decision, approval, gate, or legal transition blocks progress. |
| `VALIDATION_FAILED` | 5 | Deterministic contract or audit validation completed with failure. |
| `CONFLICT` | 6 | Verified current state conflicts with the requested operation. |
| `NOT_IMPLEMENTED` | 69 | Command is declared but no handler is installed in this build. |
| `INTERNAL` | 70 | An unexpected internal handler failure occurred. |

Exit codes are stable for lifecycle contract v1. A handler MAY define more
specific machine `error.code` values, but it MUST map them to one of these
process exit codes. Unknown command, unknown option, and invalid option
combination MUST use exit 2 deterministically.

Lifecycle trace dispatch maps `TRACE_ARGUMENT_INVALID`, `TRACE_INPUT_INVALID`,
`TRACE_INPUT_MISSING`, `TRACE_INPUT_AMBIGUOUS`, and
`TRACE_ENTITY_NOT_FOUND` to `INVALID_INPUT` (3). `TRACE_STORE_INVALID` maps to
`VALIDATION_FAILED` (5). An unknown trace or handler failure remains
`INTERNAL` (70); callers MUST NOT relabel an unclassified internal failure as
bad input.

## Stdout and Stderr

### Human mode

Without `--json`, successful lifecycle output is written to stdout. Actionable
usage, validation, conflict, unavailable, and internal errors are written to
stderr. Structured project/feature blocked-data outcomes are written to stdout
so their package or findings are retained, while still exiting 4. A command
MUST NOT claim success text when its exit code is non-zero.

### JSON mode

With `--json`, a routed lifecycle command writes exactly one
`command-result.v1` JSON document to stdout for both success and failure.
Routed JSON failures leave stderr empty so automation has one deterministic
machine stream and use a non-zero process exit. Failures that occur before the
lifecycle boundary can be loaded, such as a JavaScript runtime or package
installation failure, are outside that guarantee.

## `command-result.v1`

The JSON envelope is defined by
`contracts/pipeline/command-result.v1.schema.json` and has exactly these
top-level properties:

```json
{
  "schema_version": "command-result.v1",
  "document_type": "command-result",
  "ok": true,
  "data": {},
  "error": null
}
```

On success, `ok` is `true`, `data` is any canonical JSON value, and `error` is
`null`. On failure, `ok` is `false`, `data` is `null`, and `error` is the closed
object `{ "code": "STABLE_CODE", "message": "Actionable message" }`.
Envelope and error objects reject additional properties.

Lifecycle orchestration has scoped nonzero data outcomes when an exact
decision/ADR package, feature findings, readiness evidence, or completed audit
findings must remain machine-visible. They use the existing data branch
(`ok: true`, `error: null`) with `blocked: true` and a closed
`command_exit_code` of 4, 5, or 6. The dispatcher and process preserve that
code. Other values are ignored and successful data exits 0. This is an
operational gate, validation, or conflict outcome, not a claim that the
requested preparation or publication completed. Interactive stops may retain
the same canonical package/findings without `command_exit_code`.

`successResult(data)` and `failureResult(error)` cross a canonical JSON
boundary and recursively freeze their result. They MUST reject `undefined`,
non-finite numbers, bigint, functions, symbols, cycles, sparse or named
arrays, exotic prototypes, symbol keys, non-enumerable JSON properties, and
accessor-bearing contract data without invoking getters. `failureResult`
accepts a trusted native `Error` only after a guarded platform-native identity
check and then reads own data descriptors for `message`, optional `code`, and
optional `exitCode`; diagnostic `stack` accessors are ignored and never
invoked. A non-Error is accepted only when canonical validation proves it is
an exact plain own enumerable `{code,message}` object. Proxies, Error-shaped
duck types, exotic prototypes, accessors, and extra diagnostic or exit fields
are not trusted as errors.

## Programmatic Parser and Dispatcher

`parseCommand(argv)` accepts a dense canonical JSON array of strings. It
returns a recursively frozen closed command:

```json
{
  "name": "project.status",
  "args": [],
  "options": {
    "from": null,
    "nonInteractive": false,
    "json": false,
    "continue": false,
    "project": null,
    "apply": false
  },
  "readOnly": true,
  "interactive": false
}
```

`dispatchCommand(command, context)` independently validates that normalized
shape and safety metadata. Context, service, and injected handler entries MUST
be own, enumerable data properties. The dispatcher captures those descriptors
once into null-prototype maps and never resolves inherited context values. A
handler MUST be an own enumerable data-function under its exact dotted command
name. Inherited entries are absent; accessors, symbols, non-enumerable entries,
unknown keys, and non-function handlers are rejected without invoking getters
or inherited values.

The dispatch return is the frozen pair `{exitCode, result}` where `result` is
a `command-result.v1`. A missing handler returns exit 69 and
`COMMAND_NOT_IMPLEMENTED`; it does not call a service or mutate state.

The programmatic `trace` dispatch lazily calls the existing trace command and
wraps its unmodified closed `trace-result.v1` as `command-result.v1.data`.
It requires exactly one explicit own data source, either `context.artifacts`
or `context.artifactStore`. With neither source it returns
`TRACE_INPUT_MISSING`/`INVALID_INPUT`; with both it returns the closed
`TRACE_INPUT_AMBIGUOUS`/`INVALID_INPUT` result. Neither invalid source count may
inspect an artifact source, infer a store from the current directory or
`--project`, read the filesystem, or create a project directory. The raw CLI
compatibility path may continue constructing its established current-directory
store.
Trace and artifact-store modules, including their Ajv validator dependency,
MUST NOT be eagerly loaded merely to parse, display help, or report an
unimplemented lifecycle command.

## Help Tree

Root `toss --help` MUST display this lifecycle tree:

```text
toss project <create|analyze|prepare|status|resume>
toss feature <add|analyze|prepare|status>
toss decisions <list|answer>
toss architecture <review|approve>
toss plan show
toss audit run
toss readiness check
toss issues <preview|publish>
toss trace <ENTITY-ID>
toss artifacts <list|inspect>
toss validate <FILE>
```

It MUST also list shared options and the compatibility commands `init`,
`create`, raw `trace`, and fast scaffold. Root help and version accept only the
exact one-token forms `--help`, `-h`, `--version`, and `-v`. A lifecycle help
path must identify a complete declared command (for example, `project create
--help` or `trace --help`); an unknown command, an incomplete family such as
`project --help`, an unknown trailing option, or extra input after a root help
or version token is a deterministic `USAGE` failure.

## Shell-Completion Vocabulary

A v1 completion implementation MUST derive candidates from this closed
vocabulary and narrow them using the command option matrix:

```text
project create analyze prepare status resume
feature add decisions list answer architecture review approve
plan show audit run readiness check issues preview publish
trace artifacts inspect validate init
--from --non-interactive --json --continue --project --apply
--help -h --version -v
```

Completion MUST NOT imply that every option is valid for every command.
`--apply`, for example, is offered only after `issues publish`.

## Compatibility and Deprecation

The following interfaces remain compatible in v2.1:

- `toss init [project-brief.yaml]` retains its existing human output and file
  creation behavior.
- `toss create <project-brief.yaml> [--force]` retains its existing scaffold
  behavior and human output.
- `toss trace <ENTITY-ID> [--json]` retains the raw trace API. Its JSON success
  is a bare `trace-result.v1`, and its JSON failure retains the legacy
  `{error:{code,message}}` shape on stderr. It is not silently wrapped. Code
  that wants the lifecycle envelope uses `dispatchCommand`.
- Fast scaffold remains available as `toss "Project Name" [legacy options]`.
  A multiword/capitalized name, an unambiguous non-alphabetic one-token name
  such as `my-project`, or any established scaffold option selects that legacy
  path. An explicit scaffold option selects compatibility routing even when
  the project name is a lifecycle family, for example
  `toss project --slug project --no-git`. Without an explicit scaffold option,
  a recognized lifecycle command continues to win.

There is an unavoidable ambiguity between a bare lowercase alphabetic
one-token project name and a future top-level command. In v2.1, an unadorned
lowercase command-like token is treated as an unknown command and exits 2.
Existing one-token scaffold automation MUST add an already-supported legacy
option such as `--slug <slug>` or migrate to the lifecycle `project create`
interface. Fast scaffold is deprecated for new automation, but it is not
removed in v2.1. A future major version MAY remove it only with a separately
published migration contract.

Legacy compatibility output is deliberately not `command-result.v1`.
Consumers MUST NOT infer the new envelope from the presence of `--json` on the
raw trace path, and this contract does not invent machine output for `init`,
`create`, or fast scaffold.
