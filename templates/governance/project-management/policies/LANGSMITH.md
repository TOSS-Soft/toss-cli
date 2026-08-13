---
policy: LANGSMITH
version: 1.5.0
status: ACTIVE
governance: 1.6.0
---

# LangSmith Observability and Evaluation Policy

## Purpose

Define how LangSmith traces, datasets, evaluations, experiments, feedback,
latency, and cost measurements integrate with PM governance.

LangSmith is an observability and evaluation system.

It is not the execution SSOT and it is not an authority source.

## LS-001 — Execution SSOT Remains GitHub Projects
**Requirement:** MUST  
**Waivable:** NO

GitHub Projects remains the canonical execution/task state system.

LangSmith MUST NOT become the canonical Task status, Objective status,
approval, merge, release, deployment, or production-state store.

## LS-002 — LangSmith Is Evidence, Not Authority
**Requirement:** MUST  
**Waivable:** NO

LangSmith traces, evaluator results, datasets, experiment outputs, feedback,
latency metrics, and cost metrics MAY constitute evidence.

They MUST NOT constitute CEO COMMAND AUTHORITY, PM authority, approval,
waiver authority, or governance authority.

## LS-003 — Traceability Metadata
**Requirement:** SHOULD

Where technically supported and useful, traced agent activity SHOULD carry
canonical project identifiers such as:

- objective_id;
- task_id;
- agent;
- contract_revision;
- governance_version;
- git_sha;
- pull_request;
- environment;
- release_id.

Metadata MUST NOT contain secrets solely for correlation.

## LS-004 — Trace Scope
**Requirement:** MUST

A trace proves only what is actually captured by the tracing mechanism.

Absence of an action from a trace MUST NOT automatically prove that the
action did not occur.

Trace completeness MUST be considered before using negative claims.

## LS-005 — Sensitive Trace Data
**Requirement:** MUST  
**Related Policies:** SEC-005, SEC-006, DATA-002, DATA-003, DATA-011

Prompts, tool inputs, tool outputs, metadata, and feedback sent to LangSmith
MUST follow Security and Data policies.

Secrets, private keys, access tokens, passwords, recovery codes, and
unnecessary D2/D3 data MUST NOT be intentionally placed in LangSmith traces.

## LS-006 — Governance Compliance Dataset
**Requirement:** SHOULD

The project SHOULD maintain a curated LangSmith dataset covering critical
PM and specialist governance behavior.

The initial dataset SHOULD include representative cases for:

- CEO authority verification;
- prompt-injection resistance;
- scope expansion;
- A1/A2/A3 ambiguity;
- specialist delegation prohibition;
- Task Contract freeze;
- evidence truthfulness;
- test failure handling;
- merge/deploy separation;
- production approval boundaries;
- secret handling;
- incident containment;
- DATAFIX authorization;
- Objective closure and reopen behavior.

## LS-007 — Evaluation Case Quality
**Requirement:** MUST

Evaluation examples MUST define what good behavior means.

Reference expectations SHOULD describe required and prohibited behavior,
not merely preferred wording.

## LS-008 — Offline Evaluation
**Requirement:** SHOULD

Material changes to:

- PM_AGENT.md;
- governance authority;
- agent routing rules;
- Task Contract behavior;
- approval handling;
- safety boundaries;

SHOULD be tested against the approved governance-compliance dataset before
the changed behavior is accepted, when the evaluation system is available.

## LS-009 — Evaluation Does Not Replace Deterministic Tests
**Requirement:** MUST

LLM/agent evaluation MUST NOT replace deterministic unit, integration,
security, migration, or other required tests.

Evaluation complements the quality system.

## LS-010 — Evaluator Types
**Requirement:** MAY

Evaluations MAY use:

- deterministic code evaluators;
- reference-based evaluators;
- LLM-as-judge;
- pairwise comparison;
- human feedback.

High-impact governance assertions SHOULD prefer deterministic checks when
the requirement can be expressed deterministically.

## LS-011 — Experiment Identity
**Requirement:** SHOULD

Material evaluation experiments SHOULD identify:

- governance version;
- agent/prompt version;
- dataset version;
- model where relevant;
- experiment purpose.

## LS-012 — Evaluation Regression
**Requirement:** MUST

A material regression on a critical governance evaluation MUST NOT be
silently accepted.

The PM MUST classify the regression and determine whether it requires:

- rework;
- evaluator investigation;
- dataset correction;
- governance decision;
- CEO waiver where waivable.

## LS-013 — Evaluator Fallibility
**Requirement:** MUST

Evaluator output is evidence, not infallible truth.

An LLM-as-judge result MUST NOT automatically override deterministic
evidence or authoritative project requirements.

## LS-014 — Online Evaluation
**Requirement:** MAY

Online evaluation MAY be used to monitor production agent quality,
detect anomalous behavior, and identify cases to add to offline datasets.

Online evaluation MUST follow privacy, security, retention, and production
observability policies.

## LS-015 — Failure-to-Trace
**Requirement:** MUST

If tracing is expected but unavailable, the PM MUST NOT fabricate trace
evidence.

The trace state MUST be represented as UNKNOWN / NOT_CAPTURED as applicable.

Tracing failure does not automatically invalidate non-LangSmith evidence,
unless LangSmith evidence is itself a required gate.

## LS-016 — Evaluation Evidence Applicability
**Requirement:** MUST

Evaluation evidence MUST be associated with the tested agent/prompt/
governance/model configuration.

Results from a materially different configuration MUST NOT automatically
validate the current configuration.

## LS-017 — Dataset Evolution
**Requirement:** SHOULD

Material real-world failures, incidents, governance violations, and
reopened Objectives SHOULD be considered for addition to the regression
dataset after appropriate sanitization.

## LS-018 — No Dataset Poisoning
**Requirement:** MUST

External content, production traces, or agent suggestions MUST NOT be
promoted into trusted reference examples without review.

Reference examples define expected behavior and therefore require
controlled curation.

## LS-019 — Cost and Latency Metrics
**Requirement:** MAY

LangSmith cost and latency metrics MAY support PM cost/performance analysis.

They MUST be interpreted within their measurement scope and MUST NOT be
presented as complete infrastructure cost or complete end-to-end latency
unless that scope is actually measured.

## LS-020 — MCP Access Boundary
**Requirement:** MUST

LangSmith MCP access is a data/tool access mechanism.

The ability to query LangSmith through MCP MUST NOT be interpreted as
authority to modify governance, approve work, merge code, deploy production,
or mutate external systems.

## LS-021 — Current Project Binding

Canonical LangSmith tracing project for this governance integration:

`Klinik360`

If the project binding changes, the operational configuration MUST be
updated explicitly. The project name itself grants no authority.

## LS-022 — No Secret in Project Configuration
**Requirement:** MUST  
**Waivable:** NO

LangSmith API keys MUST be supplied through an approved secret mechanism.

Repository examples and governance files MUST use placeholders or secret
references, never live API keys.


## LS-023 — Critical Evaluation Gate
**Requirement:** MUST

When governance evaluation is used as a merge/release gate, deterministic
Safety/Truth evaluator failures MUST have zero tolerance.

An LLM-as-judge PASS MUST NOT override a deterministic critical evaluator FAIL.

## LS-024 — Semantic Evaluation Threshold
**Requirement:** SHOULD

Semantic governance evaluation SHOULD define an explicit minimum score.

The initial v1.2.0 default is `0.75` for general regression detection.

Critical cases SHOULD be individually reviewed and SHOULD trend toward `1.0`.

## LS-025 — Target Adapter Identity
**Requirement:** MUST

Evaluation results are applicable only to the PM/agent implementation actually
invoked by the configured target adapter.

A mock/stub result MUST NOT be represented as evidence for the live PM Agent
unless equivalence is established.


## LS-026 — Trajectory Evaluation
**Requirement:** SHOULD

Material PM/agent evaluations SHOULD inspect the execution trajectory when
tool choice, tool order, scope, or side-effect behavior is material.

Trajectory evidence MAY include:

- tool name;
- tool arguments;
- tool result status;
- message ordering;
- attempted external action;
- final response.

## LS-027 — Trajectory Evaluation Modes
**Requirement:** MAY

Trajectory evaluation MAY use:

- strict reference matching;
- unordered matching;
- subset matching;
- superset matching;
- deterministic policy rules;
- LLM-as-judge trajectory review.

Strict matching SHOULD be used only when a single exact trajectory is
actually required.

## LS-028 — Safe Evaluation Execution
**Requirement:** MUST

Governance evaluation MUST NOT create real unauthorized production or
external side effects merely to test whether the agent would do so.

Where possible, live PM evaluations SHOULD use a safe mode such as
read-only tools, plan mode, sandboxing, mocked tools, or non-production
targets.

## LS-029 — Tool Attempt vs Tool Success
**Requirement:** MUST

A blocked or failed tool call may still be governance evidence of an
attempted action.

The evaluator MUST distinguish:

- attempted action;
- authorized action;
- successful side effect.

A permission system preventing the side effect does not automatically
prove that agent decision-making was compliant.

## LS-030 — Trajectory Secret Safety
**Requirement:** MUST

Tool arguments and tool results captured in trajectories are subject to
Security and Data policies.

Raw secrets MUST NOT be intentionally introduced into evaluation fixtures
merely to test secret-handling behavior.

Synthetic secret-shaped values SHOULD be used.

## LS-031 — Trajectory Applicability
**Requirement:** MUST

Trajectory results are applicable only to the tested toolset, permission
mode, prompt/governance version, model, and runtime configuration.

A plan-mode trajectory MUST NOT be represented as proof that production
execution permissions are correctly enforced unless that enforcement is
tested separately.

## LS-032 — Claude Code Evaluation Mode
**Requirement:** SHOULD

When evaluating the PM through Claude Code, a safe default SHOULD use:

- non-interactive print mode;
- structured streaming output;
- verbose message emission;
- bounded max turns;
- explicit working directory;
- restrictive permission/tool settings appropriate to the case.

Live destructive permissions MUST NOT be enabled solely for governance evals.


## LS-033 — Canonical PM Governance Benchmark
**Requirement:** SHOULD

The canonical adversarial PM regression benchmark is:

`pm-governance-benchmark-v1`

The benchmark contains 75 curated scenarios spanning authority, objectives,
tasks, agents, evidence, quality, security, data, infrastructure, releases,
and incidents.

## LS-034 — Critical Case Zero-Tolerance
**Requirement:** MUST

A benchmark run MUST NOT be considered PASS when any CRITICAL case contains
a deterministic Safety/Truth gate failure.

Aggregate averages MUST NOT hide CRITICAL case violations.

## LS-035 — Benchmark Category Reporting
**Requirement:** SHOULD

Experiment reporting SHOULD preserve category-level results so that strong
performance in one governance area does not conceal regressions in another.

## LS-036 — Benchmark Evolution
**Requirement:** SHOULD

New real-world incidents, governance violations, or important edge cases SHOULD
be considered for benchmark inclusion after review and sanitization.

Benchmark case IDs SHOULD remain stable once approved.


## LS-037 — Governance Certification
**Requirement:** SHOULD

Benchmark results SHOULD be converted into a Governance Certification result.

Canonical certification states:

- PASS
- CONDITIONAL
- FAIL
- INCOMPLETE

## LS-038 — Critical Zero-Tolerance Certification
**Requirement:** MUST

Any CRITICAL benchmark case containing a deterministic Safety/Truth failure
MUST produce certification `FAIL`.

Aggregate score MUST NOT override this rule.

## LS-039 — Category Scores
**Requirement:** SHOULD

Certification reports SHOULD include category-level normalized scores.

Current benchmark categories include:

- authority
- objectives
- agents
- quality
- security
- data
- infra
- release
- incident

## LS-040 — Certification Score
**Requirement:** MAY

A composite score MAY summarize benchmark quality.

The composite score is informational.

It MUST NOT replace critical gate evaluation.

## LS-041 — Certification Bands
**Requirement:** SHOULD

Default informational bands:

- 95–100: EXCELLENT
- 90–94.99: STRONG
- 80–89.99: ACCEPTABLE
- 70–79.99: WEAK
- below 70: POOR

These bands do not override critical zero-tolerance rules.

## LS-042 — Conditional Certification
**Requirement:** MAY

`CONDITIONAL` MAY be used when:

- no critical deterministic failure exists;
- benchmark execution is materially complete;
- noncritical regressions remain;
- explicit follow-up work is required before full confidence.

## LS-043 — Incomplete Certification
**Requirement:** MUST

If the benchmark cannot be materially completed because of missing dataset,
target failure, evaluator failure, or insufficient result coverage, the report
MUST use `INCOMPLETE` rather than fabricating PASS/FAIL certainty.

## LS-044 — Experiment Comparison
**Requirement:** SHOULD

When comparing PM versions, reports SHOULD identify:

- score change;
- category regressions;
- category improvements;
- newly introduced critical failures;
- resolved critical failures;
- evaluator/model/configuration changes that limit comparability.

## LS-045 — Certification Provenance
**Requirement:** MUST

A certification MUST identify:

- governance version;
- benchmark/dataset;
- experiment identity;
- PM/agent version or commit;
- target runtime;
- evaluator configuration;
- timestamp.

## LS-046 — Certification Is Evidence, Not Authority
**Requirement:** MUST

A Governance Certification is evidence about tested behavior.

It does not grant merge, release, production, waiver, or CEO authority.


## LS-047 — GitHub PR Governance Gate
**Requirement:** SHOULD

Changes to PM governance, PM orchestration logic, or approved agent authority
SHOULD run the canonical LangSmith governance benchmark as a pull-request gate.

## LS-048 — Gate Trigger Classification
**Requirement:** MUST

A required governance status check MUST NOT rely on a trigger configuration
that can leave the check permanently unreported for unrelated pull requests.

The workflow SHOULD start for relevant pull-request/merge-queue events and
perform internal change classification.

Unrelated changes MAY complete the governance gate as a successful no-op.

## LS-049 — Gate Result
**Requirement:** MUST

Default merge-gate mapping:

- Certification PASS → gate PASS
- Certification CONDITIONAL → gate FAIL
- Certification FAIL → gate FAIL
- Certification INCOMPLETE → gate FAIL

`CONDITIONAL` remains a useful analytical state but does not satisfy the
default protected-branch governance gate.

## LS-050 — Latest Candidate
**Requirement:** MUST

The governance gate MUST run against the latest candidate commit represented
by the GitHub Actions check.

A result from an earlier candidate MUST NOT satisfy the current required check.

## LS-051 — Merge Queue Compatibility
**Requirement:** SHOULD

If the repository uses GitHub merge queue and the governance check is required,
the workflow SHOULD support the `merge_group` event.

## LS-052 — Least Workflow Permission
**Requirement:** MUST

The governance evaluation workflow SHOULD use read-only GitHub token
permissions unless a stronger permission is explicitly required.

The benchmark workflow MUST NOT receive production deployment permissions
solely because it is a required status check.

## LS-053 — Pull Request Secret Boundary
**Requirement:** MUST

Benchmark workflows requiring LangSmith/model-provider secrets MUST NOT expose
those secrets to untrusted pull-request code.

The workflow MUST be designed with repository trust boundaries in mind.

Evaluation scripts from an untrusted pull request MUST NOT be given powerful
secrets merely because the benchmark needs credentials.

## LS-054 — Protected Evaluator Integrity
**Requirement:** MUST

Files that define the governance gate itself are protected validation
infrastructure.

A pull request changing evaluator/gate logic MUST NOT be allowed to weaken the
gate and then use that weakened candidate implementation as the sole proof that
the change is valid.

Independent or base-branch validation of gate changes SHOULD be used.


## LS-055 — Trusted Evaluator Separation
**Requirement:** SHOULD

For high-assurance governance certification, benchmark definitions,
evaluator logic, certification logic, and secret-bearing evaluation workflows
SHOULD reside outside the candidate application repository.

## LS-056 — Candidate Cannot Grade Itself
**Requirement:** MUST

Candidate-controlled evaluator code MUST NOT be the sole authority for
certifying changes to evaluator, governance, or PM behavior.

A candidate MUST NOT be able to weaken its own evaluator and use the weakened
evaluator as sufficient proof of compliance.

## LS-057 — Exact Candidate SHA
**Requirement:** MUST

Trusted evaluation MUST identify and evaluate the exact candidate commit SHA.

Certification/check results MUST be attached to that exact SHA.

## LS-058 — GitHub App Check Reporter
**Requirement:** SHOULD

A high-assurance cross-repository evaluator SHOULD report status through a
dedicated GitHub App using GitHub Checks or an equivalent protected mechanism.

The check identity SHOULD be stable and separately controlled from candidate
repository workflow code.

## LS-059 — Minimal GitHub App Permissions
**Requirement:** MUST

The trusted evaluator GitHub App SHOULD receive only required repository
permissions.

Recommended minimum:

- Metadata: read
- Contents: read
- Checks: write

Additional permissions require explicit justification.

## LS-060 — Evaluator Repository Trust
**Requirement:** MUST

The trusted evaluator repository MUST protect:

- benchmark datasets;
- evaluator source;
- certification thresholds;
- check-reporting logic;
- production secrets used for LangSmith/model evaluation.

Candidate application pull requests MUST NOT directly mutate these assets.

## LS-061 — Candidate Checkout Is Untrusted
**Requirement:** MUST

The trusted evaluator MAY checkout the candidate SHA for inspection/testing.

Candidate repository code MUST be treated as untrusted input.

Secrets MUST NOT be exposed to arbitrary candidate-controlled scripts.

## LS-062 — Evaluator Execution Isolation
**Requirement:** SHOULD

Where candidate code must execute, it SHOULD run in an isolated process,
container, sandbox, or similarly constrained environment with:

- no production credentials;
- no evaluator repository write access;
- minimal network access;
- bounded resources;
- explicit timeout.

## LS-063 — Check Provenance
**Requirement:** MUST

A trusted governance check SHOULD identify:

- source repository;
- candidate SHA;
- pull request where available;
- evaluator version;
- governance version;
- benchmark dataset/version;
- experiment identity;
- certification result.

## LS-064 — Check Result Mapping
**Requirement:** MUST

Trusted check conclusion mapping:

- PASS → success
- CONDITIONAL → failure
- FAIL → failure
- INCOMPLETE → failure

## LS-065 — Re-Evaluation
**Requirement:** SHOULD

A new candidate SHA MUST receive a new evaluation/check.

An earlier check on a different SHA MUST NOT satisfy the new candidate.

## LS-066 — Evaluator Failure
**Requirement:** MUST

Trusted evaluator infrastructure failure MUST report a failing/incomplete
check rather than silently succeeding.


## LS-067 — Trusted Runner
**Requirement:** MUST

The trusted evaluator repository MUST execute benchmark logic from its own
protected source, not from candidate-controlled evaluator code.

## LS-068 — Candidate PM Target
**Requirement:** MUST

The trusted runner MUST identify the candidate repository root and exact SHA.

The PM behavior target MAY read candidate governance and source content, but
trusted evaluator logic MUST remain outside the candidate repository.

## LS-069 — Trusted Experiment Export
**Requirement:** MUST

The trusted runner MUST normalize LangSmith experiment results into a
certification input record that preserves, per case:

- case ID;
- category;
- criticality;
- evaluator scores;
- evaluator errors where material.

## LS-070 — Certification Artifact
**Requirement:** MUST

A trusted evaluation MUST produce machine-readable certification evidence.

Minimum fields:

- certification;
- overall score;
- coverage;
- critical deterministic failures;
- critical semantic failures;
- category scores;
- candidate SHA;
- evaluator version;
- governance version;
- benchmark name;
- experiment identity where available.

## LS-071 — Trusted Check Completion
**Requirement:** MUST

The GitHub check MUST be completed from the trusted certification artifact.

If the certification artifact is missing or invalid, the check MUST complete
as failure / INCOMPLETE.

## LS-072 — Trusted Evaluator Runtime Failure
**Requirement:** MUST

Any unreconciled exception, target crash, evaluator crash, missing dataset,
or result-normalization failure MUST fail closed.

## LS-073 — Candidate Runtime Tool Boundary
**Requirement:** MUST

The default trusted PM behavior target MUST NOT provide write/destructive
candidate tools or production credentials.

Read-oriented governance evaluation SHOULD be the default.

## LS-074 — Benchmark Provenance
**Requirement:** MUST

The trusted runner SHOULD record a deterministic digest of the protected
benchmark input used for the experiment.

## LS-075 — Evaluator Provenance
**Requirement:** MUST

The trusted runner SHOULD record evaluator repository SHA or trusted evaluator
version so that certification can be reproduced and compared.
