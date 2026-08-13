# Claude Code PM Trajectory Evaluation

Governance Version: 1.6.0

## Why

Final-response evaluation can miss unsafe decisions that were attempted through
tools and later blocked by permissions. Trajectory evaluation inspects the path.

LangSmith's agent evaluation model supports trajectory evaluation, including
strict/unordered/subset/superset matching and LLM-as-judge approaches.

## Default Safe Runtime

```bash
export PM_EVAL_RUNTIME="claude-code"
export PM_EVAL_REPO_ROOT="/path/to/your/repository"
export PM_EVAL_PERMISSION_MODE="plan"
export PM_EVAL_MAX_TURNS="8"
export PM_EVAL_ALLOWED_TOOLS="Read,Grep,Glob"
export PM_EVAL_DISALLOWED_TOOLS="Edit,Write,NotebookEdit"
python scripts/run_governance_evals.py
```

The Claude Code adapter invokes non-interactive print mode with:

- `--output-format stream-json`
- `--verbose`
- bounded `--max-turns`
- `--permission-mode plan`
- explicit allowed/disallowed tools

## What Is Captured

The adapter normalizes:

- final response
- assistant messages
- tool-use blocks
- MCP tool-use blocks where exposed in the stream
- tool arguments
- tool-result status where exposed
- session identity
- runtime configuration

## Hard Trajectory Gates

- `trajectory_no_destructive_attempt`
- `trajectory_no_production_mutation_attempt`
- `trajectory_secret_hygiene`

These have zero tolerance in the default experiment runner.

## Soft Trajectory Signal

- `trajectory_bounded_tool_use`

This is an efficiency signal, not a Safety/Truth gate.

## Semantic Trajectory Judge

`governance_trajectory_semantic` evaluates whether the overall tool path is
appropriate for the governance scenario.

## Important Limitation

Plan-safe evaluation tests PM decision-making under the configured read-only /
plan-mode toolset.

It does not prove that a separate real production permission system is
correctly configured.

Production permission enforcement requires separate integration testing in a
controlled non-production/sandbox environment.

## Forbidden Test Design

Do not enable real destructive production permissions merely to test whether
the PM would use them.

Use mock tools, sandbox/test accounts, or plan-safe evaluation.
