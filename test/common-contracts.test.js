import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {
  createContractValidator,
  validateDocument,
} from "../src/contracts/validator.js";
import {
  SEMANTIC_VALIDATION_BOUNDARY,
  validateArtifactGraph,
} from "../src/contracts/semantic-validator.js";
import {
  fromYamlProjection,
  toYamlProjection,
} from "../src/contracts/yaml-projection.js";

async function fixture(path) {
  return JSON.parse(await readFile(new URL(
    `./fixtures/common/${path}`,
    import.meta.url,
  ),"utf8"));
}

const validArtifactEnvelope=await fixture("valid/artifact-envelope.json");
const validEntity=await fixture("valid/entity.json");
const validProvenance=await fixture("valid/provenance.json");
const validInternalReference=await fixture("valid/internal-reference.json");
const validExternalReference=await fixture("valid/external-reference.json");
const validQuestion=await fixture("valid/question.json");
const validGraph=await fixture("valid/artifact-graph.json");
const yamlRoundTrip=await fixture("valid/yaml-round-trip.json");
const invalidPrefix=await fixture("invalid/entity-prefix.json");
const invalidEnvelopeProperty=await fixture("invalid/artifact-envelope-property.json");
const invalidReferenceVariant=await fixture("invalid/reference-variant.json");
const invalidQuestion=await fixture("invalid/question-missing-recommendation.json");
const danglingGraph=await fixture("invalid/dangling-reference.json");
const danglingArtifactGraph=await fixture("invalid/dangling-artifact-reference.json");
const mismatchedArtifactTypeGraph=await fixture("invalid/mismatched-artifact-document-type.json");
const duplicateGraph=await fixture("invalid/duplicate-entity-id.json");
const conflictingPrefixGraph=await fixture("invalid/conflicting-prefix.json");
const acpFixture=JSON.parse(await readFile(new URL(
  "./fixtures/acp/full-pipeline.json",
  import.meta.url,
),"utf8"));

test("common schemas accept complete normative documents and reject closed-shape violations",() => {
  const validator=createContractValidator();
  const validCases=[
    [validArtifactEnvelope,"artifact-envelope.v1"],
    [validEntity,"entity.v1"],
    [validProvenance,"provenance.v1"],
    [validInternalReference,"reference.v1"],
    [validExternalReference,"reference.v1"],
    [validQuestion,"question.v1"],
  ];

  for (const [value,schemaId] of validCases) {
    assert.deepEqual(validator.validateDocument(value,schemaId),{
      valid:true,
      errors:[],
    });
  }

  assert.equal(validateDocument(validArtifactEnvelope,"artifact-envelope.v1").valid,true);
  assert.equal(validateDocument(invalidPrefix,"entity.v1").valid,false);
  assert.equal(validateDocument(invalidEnvelopeProperty,"artifact-envelope.v1").valid,false);
  assert.equal(validateDocument(invalidReferenceVariant,"reference.v1").valid,false);
  assert.equal(validateDocument(invalidQuestion,"question.v1").valid,false);
});

test("semantic graph validation rejects duplicate IDs, dangling internal references, and prefix meaning conflicts",() => {
  assert.deepEqual(validateArtifactGraph(validGraph),{
    valid:true,
    entity_count:2,
    internal_reference_count:1,
  });
  assert.throws(() => validateArtifactGraph(danglingGraph),/dangling reference/i);
  assert.throws(
    () => validateArtifactGraph(danglingArtifactGraph),
    /dangling reference/i,
  );
  assert.throws(
    () => validateArtifactGraph(mismatchedArtifactTypeGraph),
    /reference document type/i,
  );
  assert.throws(
    () => validateArtifactGraph(duplicateGraph),
    /duplicate entity ID.*conflicting meaning/i,
  );
  assert.throws(() => validateArtifactGraph(conflictingPrefixGraph),/prefix.*conflicts/i);
});

test("shape validation remains separate from graph-level prefix meaning validation",() => {
  const prefixConflict={...validEntity,id:"REQ-099",kind:"risk"};
  assert.equal(validateDocument(prefixConflict,"entity.v1").valid,true);
  assert.throws(() => validateArtifactGraph([{
    artifact_id:"artifact-prefix-boundary-001",
    revision:1,
    content:{entities:[prefixConflict]},
  }]),/prefix.*conflicts/i);
  assert.ok(SEMANTIC_VALIDATION_BOUNDARY.schema.includes("ACP identifier syntax"));
  assert.ok(SEMANTIC_VALIDATION_BOUNDARY.semantic.includes("entity prefix-to-kind meaning"));
});

test("artifact-envelope validation accepts ACP v1's recorded provenance shape as well as full common provenance",() => {
  assert.equal(
    validateDocument(acpFixture.artifacts[0],"artifact-envelope.v1").valid,
    true,
  );
});

test("YAML projection round trips canonical JSON values without tags or prototype mutation",() => {
  const text=toYamlProjection(yamlRoundTrip);
  assert.deepEqual(fromYamlProjection(text),yamlRoundTrip);
  assert.throws(
    () => toYamlProjection({notJson:undefined}),
    /non-JSON value/i,
  );
  assert.throws(
    () => fromYamlProjection("value: !!js/function >\n  return 1\n"),
    /YAML tags are unsupported/i,
  );

  const projected=fromYamlProjection("__proto__:\n  polluted: true\n");
  assert.equal(Object.prototype.polluted,undefined);
  assert.equal(Object.hasOwn(projected,"__proto__"),true);
  assert.deepEqual(projected,JSON.parse('{"__proto__":{"polluted":true}}'));
});
