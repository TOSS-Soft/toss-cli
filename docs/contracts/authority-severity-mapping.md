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
| `P0` | `A3` | `USER` | Hard stop while unresolved | A3 verified-authority resolution record |
| `P1` | `A2` | `ARCHITECT` | Stops while unresolved | A2 Architect authority-resolution record |
| `P1` with `business_input_missing: true` | `A3` | `USER` | Stops while unresolved | A3 User authority-resolution record |
| `P2` | `A3` | `USER` | Stops while unresolved | A3 User authority-resolution record |
| `P3` | `A1` | `PM` | May continue as a documented assumption | Provenance, material impact, and reversibility |
| `P4` | `A1` | `PM` | May continue as a documented assumption | Provenance, material impact, and reversibility |

`P0`, `P1`, and `P2` are blocking only when their package status is
`unresolved`. A resolved blocking item does not block the continuation gate,
but `status: resolved` is not a claim that a consumer may trust. Every
retained source evidence record for a resolved blocking decision MUST carry a
closed `authority_resolution` record with non-blank `decision` and `rationale`,
the exact authority and owner derived for that source by `classifyQuestion`,
full `provenance.v1` provenance, and a closed, decision-bound
`authority_attestation`. Generic provenance records the source trail only; it
MUST NOT by itself establish an actor's authority. A package preserves those
records as `authority_resolutions`, keyed by source ID.

An authority attestation MUST identify the actual `actor_id` and `actor_role`,
its route-specific `verification_kind`, an immutable authority-record reference
(`record_id`, positive `record_revision`, and `record_sha256`), an RFC3339
`timestamp`, and a canonical base64 Ed25519 `signature`. The signature is
verified against a separate trusted authority registry; neither an attestation
nor a decision package may embed or select a public key. The registry is a
closed canonical-JSON context supplied independently to build and gate
evaluation, with this shape:

```json
{
  "actors": [
    {
      "actor_id": "verified-ceo",
      "actor_role": "CEO",
      "public_key": "<Ed25519 PEM public key>",
      "allowed_routes": [
        {
          "authority": "A3",
          "verification_kind": "A3_VERIFIED_CEO_OR_USER_AUTHORITY"
        }
      ]
    }
  ]
}
```

Actor IDs and allowed routes are unique; unknown fields, duplicate actor IDs,
duplicate or contradictory routes, malformed keys, and non-Ed25519 keys fail
closed. The consumer controls this immutable trust anchor. Runtime parsing
normalizes LF/CRLF line endings and allows at most one trailing newline. It
then parses and re-exports SPKI PEM, and trusts the key only when the
canonicalized input exactly equals that one exported Ed25519 `PUBLIC KEY`
block. Leading or trailing junk, concatenated keys, a second certificate or
key block, duplicate PEM delimiters, private PEM, and non-SPKI PEM therefore
fail closed rather than relying on a parser's choice of a first block.

The signed payload is the canonical JSON exactly equivalent to:

```json
{
  "domain": "toss.decision-package.authority-attestation.v1",
  "source_id": "<source question ID>",
  "decision": "<authority-resolution decision>",
  "rationale": "<authority-resolution rationale>",
  "authority": "<derived authority>",
  "owner": "<derived owner>",
  "verification_kind": "...",
  "actor_id": "...",
  "actor_role": "...",
  "record_id": "...",
  "record_revision": 1,
  "record_sha256": "...",
  "timestamp": "..."
}
```

`authorityAttestationSigningPayload` exposes this deterministic payload shape
for integrators; the pipeline does not export signing or private-key behavior.
Both `buildDecisionPackage` and `evaluateDecisionGate` recompute and verify the
same payload. A missing registry, unknown actor, registry role or route
mismatch, wrong key, malformed signature, or any signed-field tampering fails
closed. The record identity is exactly `record_id@record_revision`: a different
`record_sha256` for that identity is a conflict, and the same exact record may
not be reused for another source question.

For `P0`, `authority: A3` and `owner: USER` is the explicit representation of
the required verified authority; the resolution's provenance remains only the
source trace. Its attestation and immutable authority record establish the
authority answer. Every A3 route (`P0`, `P1` with
`business_input_missing: true`, and `P2`) MUST use
`A3_VERIFIED_CEO_OR_USER_AUTHORITY` and name an actual `CEO` or `USER` actor.
A bare resolution string, a status flag, ordinary PM provenance, or a different
A3 delegate is insufficient. The corresponding exact A2 route is
`ARCHITECT` for ordinary `P1`, whose attestation uses
`A2_ARCHITECT_OR_SPECIALIST_EVIDENCE` and an `ARCHITECT` or `SPECIALIST` actor;
A3 `USER` for `P1` with `business_input_missing: true`; and A3 `USER` for
`P2`. Missing, mismatched, unbound, duplicate, malformed, or unprovenanced
records fail closed. `P3` and `P4` are never user escalations: they remain
visible assumptions and may proceed only when their evidence fields are
complete.

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
rebuild canonical questions from retained source evidence and recompute the
gate; they MUST NOT trust a supplied top-level question or gate value. Evidence
source IDs are unique and exactly equal to `source_ids`. Rebuilding verifies
the conservative severity, P1 escalation, authority/owner, status,
dependencies, assumption evidence, authority resolutions, and all material
merged fields before a result can be clear.

## PM-analysis adapter

`buildDecisionPackageFromPmAnalysis(pmAnalysis, enrichments, authorityRegistry)`
is the direct path from a validated `pm-analysis.v1` artifact. It first calls
the existing `validatePmAnalysis` contract and consumes only
`content.open_questions`; it does not alter the PM artifact or infer missing
decisions. `enrichments` MUST contain exactly one closed entry for every PM
open-question ID and no unknown IDs. Each entry supplies the material `context`
and `impact` that `pm-analysis.v1` intentionally does not require, plus only
the structured fields needed for decision routing when applicable: status,
authority resolution, P1 `business_input_missing`, technical-preference marker,
P3/P4 reversibility, and dependencies. If an enrichment resolves a P0–P2
question, the same separately supplied trusted registry is required and is
threaded unchanged to package construction. Missing, duplicate, extra, or
non-canonical enrichment data fails closed.

## Determinism and safety

`buildDecisionPackage(questions)` first analyzes every question, then groups
duplicates by normalized meaning and the sorted affected-entity set. The
lexicographically smallest source ID becomes the canonical ID. Severity is
merged toward the most blocking value, source evidence is retained, and every
dependency is rewritten to a canonical ID.

The resulting dependency graph MUST have no dangling references, self edges,
or cycles. Questions are emitted in deterministic topological order, with
canonical ID as the tie breaker. A repeated source ID is accepted only when
its full canonical source record is identical; any disagreement in meaning,
severity, material fields, options, dependencies, resolution, or provenance
fails closed. Conflicting option labels or classification declarations also
fail closed.

`classifyQuestion`, `buildDecisionPackage`, and `evaluateDecisionGate` accept
only canonical JSON values, never mutate inputs, return deeply frozen values,
and perform no persistence, network, terminal, or provider operation. The
optional registry argument is required whenever retained evidence resolves a
P0–P2 item; it remains external trust context rather than package data.
