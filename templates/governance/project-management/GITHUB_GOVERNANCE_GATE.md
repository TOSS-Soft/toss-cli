# GitHub Governance Gate Hardening

Governance Version: 1.6.0

## Required Check

Recommended protected-branch check name:

`governance-certification`

GitHub branch protection / ruleset should require this check for `main`.

GitHub required checks apply to the latest candidate commit. Do not accept an
older governance certification as evidence for a newer PR HEAD.

## Why the Workflow Does Not Use `paths:` on the Trigger

The workflow runs for all PRs targeting `main`, then classifies changed files
inside the job.

This avoids a required status check being left waiting because GitHub skipped
the entire workflow due to path filtering.

Unrelated PRs get a successful no-op governance check.

## Merge Queue

If merge queue is used, keep:

```yaml
on:
  pull_request:
  merge_group:
```

A required Actions check must run for `merge_group` to work correctly with the
merge queue.

## Default Gate Mapping

| Certification | Required Check |
|---|---|
| PASS | Success |
| CONDITIONAL | Failure |
| FAIL | Failure |
| INCOMPLETE | Failure |

`CONDITIONAL` is intentionally merge-blocking by default.

## Secret Trust Boundary

LangSmith and model-provider API keys are secrets.

Do not run candidate-controlled code with those secrets for arbitrary fork PRs.

The supplied workflow fails closed for governance-sensitive fork PRs rather
than exposing secrets.

## Stronger Production Configuration

For high assurance, split the benchmark into two repositories/workflows:

1. candidate repository emits a governance-change request/artifact;
2. trusted evaluator repository checks out the exact candidate SHA read-only;
3. evaluator logic comes from protected/base evaluator code;
4. secrets exist only in trusted evaluator context;
5. result is returned as a GitHub Check/status.

This prevents a PR from modifying `evaluators/**` to weaken its own gate.

## Protected Validation Files

Treat as protected infrastructure:

- `.github/workflows/pm-governance-certification.yml`
- `evaluators/**`
- `scripts/run_governance_evals.py`
- `scripts/generate_governance_certification.py`
- benchmark reference dataset definitions
- governance policy controlling certification

Changes to these files require independent validation.

## Repository Variables

Expected variables:

- `PM_EVAL_RUNTIME`
- `PM_EVAL_TARGET` or `PM_EVAL_COMMAND`

Example:

```text
PM_EVAL_RUNTIME=claude-code
```

## Repository Secrets

Expected:

- `LANGSMITH_API_KEY`
- model-provider key used by `GOVERNANCE_JUDGE_MODEL`

The sample workflow uses:

- `OPENAI_API_KEY`

## Permissions

The supplied workflow uses:

```yaml
permissions:
  contents: read
```

Do not grant `contents: write`, `pull-requests: write`, deployment, or
production environment authority to the benchmark job unless a future,
separately approved design requires it.

## Recommended GitHub Ruleset

For `main`:

- require pull request;
- disable force push;
- require `governance-certification`;
- require normal CI/security checks;
- require explicit CEO merge authorization under project governance;
- optionally require branch to be up to date;
- support merge queue only after required workflows support `merge_group`.

GitHub branch protection is technical enforcement. It does not replace
PM governance authority.
