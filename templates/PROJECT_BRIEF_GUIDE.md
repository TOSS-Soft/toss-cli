# Project Brief Guide

The Project Brief is CEO-authored bootstrap input.

## Required

- `project.name`
- `project.description`
- `business.problem`
- `business.primary_goal`

## Recommended

- target users
- MVP scope
- out-of-scope items
- known platform requirements
- known technology decisions
- security/data sensitivity
- constraints

## AUTO

Use `AUTO` when the decision is intentionally delegated to PM/architecture
discovery.

`AUTO` does not authorize arbitrary scope. If resolving an AUTO field creates
a genuine A3/product/authority ambiguity, PM escalates it.

## Initial Objective

If `initial_objective.title` and `initial_objective.outcome` are populated,
they are treated as CEO-authored Objective input after bootstrap reconciliation.

If empty, PM waits for the first CEO Objective.

## Authority

The brief defines initial intent and constraints. It does not override
governance, merge/deploy approval, production authority, or evidence.
