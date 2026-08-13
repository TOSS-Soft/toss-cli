# Trusted Evaluator Architecture

Governance Version: 1.6.0

## Goal

Prevent the candidate application repository from modifying or weakening the
governance benchmark that certifies it.

## Recommended Repository Split

### Application Repository

Example:

`toss-software/application`

Contains:

- application source;
- `/project-management/PM_AGENT.md`;
- operational governance references;
- specialist definitions;
- normal CI;
- pull requests.

Does NOT own the authoritative governance evaluator.

### Trusted Evaluator Repository

Recommended:

`toss-software/governance-evaluator`

Contains:

- 75-case benchmark;
- deterministic evaluators;
- semantic/trajectory evaluators;
- certification engine;
- LangSmith integration;
- GitHub App check reporter;
- evaluator deployment/runtime;
- evaluator tests.

The application repository cannot modify these assets through its own PR.

## GitHub App

Recommended app name:

`TOSS Governance Evaluator`

Recommended repository permissions:

- Metadata: Read
- Contents: Read
- Checks: Write

No application write, deployment, administration, issues write, or
pull-request write permission is required for basic certification.

## Evaluation Flow

```text
APPLICATION PR / CANDIDATE SHA
             │
             ▼
GitHub App / trusted evaluator trigger
             │
             ▼
Create governance-certification check
status = in_progress
head_sha = EXACT CANDIDATE SHA
             │
             ▼
Trusted Evaluator Repository
             │
             ├─ Load protected benchmark
             ├─ Load protected evaluators
             ├─ Read candidate governance/PM files
             ├─ Run PM behavior benchmark
             ├─ Run LangSmith experiment
             └─ Generate certification
             │
             ▼
Certification:
PASS / CONDITIONAL / FAIL / INCOMPLETE
             │
             ▼
GitHub App updates exact SHA check
             │
             ▼
Branch Ruleset requires:
governance-certification
```

## Why a GitHub App

The evaluator must report a stable check identity against the application
repository's exact commit while remaining controlled outside candidate code.

The GitHub App owns the check-reporting credential.

## Trigger Models

### Preferred — GitHub App Webhook

The GitHub App receives relevant repository events and starts evaluation.

Suitable events may include:

- pull request synchronization;
- check suite request;
- explicit re-request.

The app determines exact repository and candidate SHA.

### Alternative — Thin Application Workflow

A tiny protected workflow in the application repository requests evaluation
from trusted infrastructure.

This is simpler initially but weaker if candidate PRs can alter the trigger.

For highest assurance, prefer the GitHub App webhook model.

## Candidate Data Boundary

The evaluator may read candidate repository files at the exact SHA.

Candidate code is untrusted.

Never allow candidate scripts to inherit:

- LangSmith secret unless strictly necessary;
- model-provider secret unless strictly necessary;
- GitHub App private key;
- production credentials;
- evaluator repository credentials.

## Evaluation Modes

### Static Governance Inspection

Safe.

Read:

- PM_AGENT.md
- GOVERNANCE.md
- policy files
- agent definitions
- workflow configuration

No candidate code execution required.

### PM Behavioral Evaluation

Run PM runtime in a sandboxed/read-oriented environment.

Provide synthetic benchmark scenarios.

Capture LangSmith traces and tool trajectories.

### Candidate Code Execution

Only if a benchmark genuinely requires it.

Run in constrained sandbox with no production authority.

## Check Lifecycle

Create check:

```text
name: governance-certification
head_sha: <exact candidate SHA>
status: in_progress
```

Complete check:

```text
conclusion:
success | failure

output:
Certification: PASS/FAIL/...
Overall Score: ...
Critical Failures: ...
Experiment: ...
Evaluator Version: ...
```

## Branch Protection

Application repository ruleset should require the check:

`governance-certification`

The trusted app/check identity should be the expected source where GitHub
ruleset configuration supports selecting the provider.

## Fail-Closed Rules

Report failure when:

- candidate SHA cannot be fetched;
- benchmark dataset cannot be loaded;
- LangSmith experiment fails materially;
- evaluator throws unreconciled error;
- certification is CONDITIONAL;
- certification is FAIL;
- certification is INCOMPLETE;
- exact SHA cannot be proven.

## Promotion Flow

```text
PM/Governance PR
    ↓
Trusted evaluation
    ↓
PASS
    ↓
Required check success
    ↓
CEO merge authorization
    ↓
Main merge
```

Governance certification does not replace CEO merge authorization.

## Evaluator Repository Governance

Changes to `governance-evaluator` itself require:

- PR;
- independent review;
- evaluator self-tests;
- benchmark integrity checks;
- CEO approval for governance/authority changes;
- version bump when semantics change.

## Recommended Initial Deployment

Phase 1:
- separate evaluator repository;
- GitHub App;
- evaluator runs on GitHub Actions in evaluator repo;
- LangSmith dataset/experiments;
- Checks API reporting.

Phase 2:
- isolated evaluator runner/sandbox;
- signed evaluator releases;
- immutable benchmark version tags;
- evaluator release provenance.

Phase 3:
- organization-wide installation;
- multiple application repositories;
- central governance certification history.
