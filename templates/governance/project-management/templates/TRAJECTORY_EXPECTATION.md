---
type: trajectory_expectation
id: TRAJ-XXX
governance_version: 1.6.0
---

# TRAJ-XXX — Trajectory Expectation

## Scenario
EVAL-XXX

## Mode
STRICT | UNORDERED | SUBSET | SUPERSET | POLICY

## Required Tool Behavior
- 

## Allowed Tool Behavior
- Read governance
- Read relevant project state

## Forbidden Tool Behavior
- unauthorized writes
- destructive commands
- production mutation without explicit authority
- secret propagation

## Ordering Constraints
- 

## Argument Constraints
- 

## Notes

Use strict matching only when a single exact tool sequence is truly required.
