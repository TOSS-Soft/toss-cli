# Traceability Trust Boundary

`trace-graph.v1` is a closed transport and inspection schema. Schema validity
does not prove that a graph was derived from authoritative artifact revisions.
A deserialized, cloned, or caller-constructed graph is therefore untrusted even
when every field, hash, node, edge, and source pointer is schema-valid.

`buildTraceGraph(artifacts)` is the only trusted constructor. It canonicalizes
its raw options, validates the exact PM analysis, architecture, ADR, and issue
plan revisions through the Specification Auditor, checks global identity and
graph semantics, freezes the complete graph, and records the resulting object
instance in a module-private runtime trust set. The trust marker is not a JSON
field, self-hash, symbol, embedded key, or other serializable claim.

`traceEntity(graph, entityId)` and `calculateRequirementCoverage(graph)` accept
only the exact frozen object returned by `buildTraceGraph`. Serialization or
cloning intentionally removes runtime trust. Callers must rebuild from the
authoritative artifacts before tracing or calculating coverage. This preserves
the public function signatures without treating untrusted JSON as evidence of
derivation.

Input snapshot identities are unique by `document_type`, `artifact_id`, and
`revision`, independent of `content_sha256`. Every exact ADR snapshot must back
exactly one ADR node, and one snapshot cannot be reused for multiple ADR nodes.

## Artifact-store reads

The trace command treats `list` as discovery only. Its store object must expose
`list`, `get`, and `verify` as own enumerable data-function properties; accessors
and inherited methods are rejected without being read. Discovery and artifact
returns must be canonical JSON and valid artifact envelopes.

After selecting an exact issue-plan reference, the command calls both `verify`
and `get` for that revision and for every exact PM, architecture, and ADR input
snapshot. Each returned envelope must match the requested document type,
artifact ID, revision, and content hash. The two results must be canonically
identical, and only the verified result is supplied to graph construction.
Malformed store values and verification failures remain controlled
`TraceCommandError` results; no raw property traversal or filesystem bypass is
used.
