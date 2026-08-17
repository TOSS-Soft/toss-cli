# Agent Contract Protocol v1

**Version:** `acp.v1`
**Status:** Normative

Agent Contract Protocol (ACP) v1 is the provider-neutral interchange contract
for TOSS planning agents. The key words **MUST**, **MUST NOT**, **SHOULD**, and
**MAY** are requirements terminology. ACP defines the common artifact envelope,
integrity representation, role boundaries, and compatibility behavior. It does
not define the document-specific schemas or persistent artifact store.

## Canonical representation

Canonical artifacts are JSON values. An implementation MUST recursively sort
object keys lexicographically, MUST retain array order, and MUST serialize
without insignificant whitespace. It MUST reject values outside the JSON data
model, including undefined values, non-finite numbers, big integers, functions,
symbols, sparse arrays, non-plain objects, and cycles. `canonicalJson(value)` is
the reference implementation of these rules.

`content_sha256` MUST be the lowercase hexadecimal SHA-256 digest of the UTF-8
bytes of canonical JSON for the artifact's `content` value. Producers MUST
calculate the digest after content is complete. Consumers MUST recalculate it
before using an artifact and MUST reject a mismatch.

YAML MAY be accepted as input or rendered as a human-readable projection. A
YAML value MUST first be projected losslessly into the JSON data model. JSON is
always the integrity source: YAML text, comments, anchors, key order, quoting,
and formatting MUST NOT affect the digest. A YAML projection that cannot round
trip to the same JSON value MUST be rejected.

## Artifact envelope

Every ACP artifact MUST be a JSON object with this envelope:

| Field | Requirement |
| --- | --- |
| `schema_version` | Exact registered schema version. For this contract it is `acp.v1`. |
| `document_type` | Exact type registered with `schema_version`. |
| `artifact_id` | Globally unique, stable identity for the artifact across revisions. |
| `revision` | Positive integer that increases monotonically for an `artifact_id`. |
| `run_id` | Identity shared by work performed in one pipeline run. |
| `producer` | Object containing the producing `role` and stable `identity`. |
| `runtime_identity` | Model/runtime identity when applicable; deterministic or human producers identify that runtime instead. |
| `created_at` | RFC 3339 timestamp with a UTC offset. |
| `provenance` | Exact `source_revision`, source `source_sha256`, and one or more `locations`. |
| `parents` | Exact references to predecessor revisions of this artifact; empty for its first revision. |
| `inputs` | Exact references to upstream artifacts consumed to produce this revision. |
| `content_sha256` | SHA-256 of canonical `content`. |
| `content` | Document-specific JSON value owned by the registered producer role. |

Each `parents` or `inputs` entry MUST contain `artifact_id`, positive integer
`revision`, and `content_sha256`. Consumers MUST resolve all three values to the
same verified artifact revision. Resolving only the latest revision, or only an
artifact identity, is forbidden.

## Immutable revisions

An `(artifact_id, revision)` pair is immutable. A producer MUST NOT edit,
replace, or reinterpret a published revision. A change creates the next
monotonic revision with a new digest and an exact `parents` reference to its
predecessor. Historical references continue to resolve to their original
bytes. Persistence, atomic writes, discovery, and derived indexes are defined
by the separate artifact-store contract.

Consumers MUST treat a downstream artifact as stale when any referenced input
has been superseded for the operation being attempted. Historical artifacts
remain valid history; staleness never authorizes mutation or deletion.

## Global entity identities

Entities use globally unique, stable identifiers matching
`ENTITY_ID_PATTERN`. The required prefixes are:

| Prefix | Meaning |
| --- | --- |
| `REQ` | functional requirement |
| `NFR` | non-functional requirement |
| `BR` | business rule |
| `FLOW` | product or user flow |
| `ARCHQ` | architecture question |
| `ADR` | architecture decision record |
| `EPIC` | delivery epic |
| `ISSUE` | planned issue |
| `AC` | acceptance criterion |
| `RISK` | identified risk |
| `ASM` | explicit assumption |
| `Q` | open question or finding identity |

The suffix consists of uppercase letters or digits and MAY contain separated
uppercase letter/digit segments. For example, `REQ-001` is valid. An ID MUST
retain the same `kind` and `meaning` throughout the artifact graph. Reusing an
ID for a different meaning is forbidden; the new concept receives a new ID.
`assertStableEntityMeanings(entities)` provides the v1 cross-document guard.
Reference existence and document-specific semantics belong to later common and
agent schema contracts.

## Registry and role boundaries

`contracts/registry.json` is the normative v1 document registry. Each row
binds one `document_type` and `schema_version` pair to its producer, consumers,
allowed mutations, and forbidden actions. `assertKnownDocumentType(type,
version)` enforces the registry.

- PM owns product requirements, non-functional requirements, business rules,
  flows, risks, and assumptions in PM analysis.
- Architect owns architecture and ADR decisions. The Architect MUST NOT alter
  PM-owned meanings.
- PM Finalization owns epics, planned issues, acceptance criteria, and their
  traceability in the issue plan. It MUST NOT rewrite PM or Architect inputs.
- Spec Auditor is read-only with respect to every input. It owns only its new
  findings and audit result.

An agent MAY create a new revision only for document types assigned to its
producer role. Consumers MAY read and reference verified revisions but MUST NOT
mutate them. Runtime or model choice does not change authority.

## Compatibility and versioning

ACP versions are exact identifiers, not ranges. A consumer MUST accept only a
pair present in the registry. Unknown document types and unknown schema
versions MUST fail closed. A consumer MUST NOT guess a nearest version, ignore
an unknown field to manufacture compatibility, or silently coerce an artifact
to a known type.

Backward-compatible clarification may document existing v1 behavior. A change
to required fields, canonicalization, hashing, ownership, mutation authority,
or field meaning requires a new protocol or document schema version and an
explicit registry row. Producers SHOULD retain older readers or provide an
explicit migration; migration always creates a new artifact revision.

## Fail-closed behavior

A consumer MUST stop before producing or mutating downstream state when any of
the following occurs:

- an unknown type/version pair;
- a malformed envelope or non-JSON value;
- an invalid or reused entity ID;
- a content or source hash mismatch;
- a missing, mismatched, or stale exact-revision input;
- an unauthorized producer or attempted role mutation.

Failure MUST be observable to the caller. It MUST NOT be converted into an
empty success artifact, a partial artifact, a guessed reference, or permission
to continue the pipeline.

## Normative linked example

`test/fixtures/acp/full-pipeline.json` contains a deterministic, hash-valid
chain:

```text
pm-analysis
  -> architecture + adr
  -> issue-plan
  -> spec-audit
```

Architecture consumes the exact PM analysis revision. The ADR consumes that PM
analysis and architecture revision. The issue plan consumes all three, and the
read-only audit consumes the complete upstream set. The contract test verifies
every content digest and every artifact revision reference.

The fixture is an ACP envelope example, not a substitute for the
document-specific JSON Schemas introduced by later contracts.
