# Authority and Severity Mapping

**Version:** `decision-package.v1`

**Status:** Normative

This contract maps operational question severity to the existing TOSS A1/A2/A3
authority model. It makes a question's routing and continuation effect
deterministic; it does not grant authority or turn a recorded status into
verified evidence.

## Normative mapping

| Severity | Authority | Decision owner | Pipeline effect | Required record |
| --- | --- | --- | --- | --- |
| `P0` | `A3` | `USER` | Hard stop while unresolved | Verified-authority decision record; verification is supplied by the authority-answer stage, never inferred here |
| `P1` | `A2` | `ARCHITECT` | Stops while unresolved | Specialist/Architect evidence |
| `P1` with `business_input_missing: true` | `A3` | `USER` | Stops while unresolved | Product/business input from verified authority |
| `P2` | `A3` | `USER` | Stops while unresolved | Product authority decision |
| `P3` | `A1` | `PM` | May continue as a documented assumption | Provenance, material impact, and reversibility |
| `P4` | `A1` | `PM` | May continue as a documented assumption | Provenance, material impact, and reversibility |

`P0`, `P1`, and `P2` are blocking only when their package status is
`unresolved`. A resolved blocking item does not block the continuation gate.
`P3` and `P4` are never user escalations: they remain visible assumptions and
may proceed only when their evidence fields are complete.

`business_input_missing` is a structured boolean accepted only for `P1`. It is
the sole route by which a technical preference may be escalated directly to
`USER`. `P0` and `P2` technical preferences are invalid and fail closed;
`P3` and `P4` technical preferences remain A1 documented assumptions.

## Decision package boundary

`decision-package.v1` is a standalone pipeline result rather than an ACP
immutable revision envelope. It is deliberately not added to
`contracts/registry.json`, whose rows declare ACP `acp.v1` artifacts and their
revision producers. A future persisted decision artifact must introduce its
own ACP envelope and registry row rather than changing this result's meaning.

The closed schema lives at
`contracts/pipeline/decision-package.v1.schema.json`. Every canonical question
in a package includes:

- normalized decision meaning, source question text, severity, authority,
  owner, and resolution status;
- context, material impact, options, recommendation, rationale, affected
  entity identifiers, and provenance;
- dependency identifiers, source identifiers, and the complete merged source
  evidence set; and
- `reversibility` for `P3` and `P4` assumptions.

The package gate contains `can_continue`, a `CLEAR` or `BLOCKED` status, and
the exact unresolved blocking and assumption question IDs. Consumers MUST
recompute it from the canonical questions; they MUST NOT trust a supplied gate
value.

## Determinism and safety

`buildDecisionPackage(questions)` first analyzes every question, then groups
duplicates by normalized meaning and the sorted affected-entity set. The
lexicographically smallest source ID becomes the canonical ID. Severity is
merged toward the most blocking value, source evidence is retained, and every
dependency is rewritten to a canonical ID.

The resulting dependency graph MUST have no dangling references, self edges,
or cycles. Questions are emitted in deterministic topological order, with
canonical ID as the tie breaker. Conflicting duplicate IDs, option labels, or
classification declarations fail closed.

`classifyQuestion`, `buildDecisionPackage`, and `evaluateDecisionGate` accept
only canonical JSON values, never mutate inputs, return deeply frozen values,
and perform no persistence, network, terminal, or provider operation.
