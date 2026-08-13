# Trusted Evaluator Operations Runbook

Governance Version: 1.6.0

## One-Time Setup

1. Create repository:
   `toss-software/governance-evaluator`

2. Copy contents of:
   `trusted-evaluator-repo/`

3. Create GitHub App:
   `TOSS Governance Evaluator`

4. Install App on target application repository/repositories.

5. Add trusted evaluator repository secrets:
   - GITHUB_APP_ID
   - GITHUB_APP_PRIVATE_KEY
   - LANGSMITH_API_KEY
   - OPENAI_API_KEY

6. Ensure trusted runner has authenticated Claude Code CLI.

7. Bootstrap LangSmith benchmark once:

```bash
python scripts/bootstrap_dataset.py
```

## Manual End-to-End Test

Dispatch:

`Trusted Governance Evaluation`

Inputs:

- source_owner
- source_repo
- candidate_sha
- pull_request (optional)

Expected:

1. GitHub App creates `governance-certification` check on exact SHA.
2. Candidate exact SHA is checked out read-only.
3. Trusted benchmark runs.
4. LangSmith experiment is created.
5. Certification artifacts are generated.
6. Check completes success only on PASS.
7. Application branch ruleset blocks merge otherwise.

## Trusted Runner Verification

```bash
python scripts/validate_trusted_evaluator.py
```

## Failure Modes

### Candidate SHA mismatch

Certification:
INCOMPLETE / check failure.

### Dataset missing

Certification:
INCOMPLETE / check failure.

### Claude Code unavailable

Certification:
INCOMPLETE / check failure.

### Evaluator/model API failure

Certification:
INCOMPLETE / check failure.

### Critical deterministic governance violation

Certification:
FAIL / check failure.

### Critical semantic violation

Certification:
FAIL / check failure.

### Aggregate score below PASS threshold

CONDITIONAL or FAIL / check failure.

## Candidate Isolation

Do not execute arbitrary candidate shell scripts with trusted secrets.

If later benchmark cases require candidate application execution, add a
separate sandboxed worker with:

- no GitHub App private key;
- no evaluator repository credentials;
- no production credentials;
- minimal egress;
- resource/time limits.

## Required Check

Application ruleset:

`governance-certification`

The status check is evidence for the candidate SHA.

It does not replace explicit CEO merge authorization.
