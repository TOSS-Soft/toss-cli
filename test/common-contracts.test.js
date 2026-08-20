import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {
  createContractValidator,
  validateDocument,
} from "../src/contracts/validator.js";
import {canonicalJson} from "../src/contracts/acp.js";
import {
  SEMANTIC_VALIDATION_BOUNDARY,
  validateArtifactGraph,
} from "../src/contracts/semantic-validator.js";
import {
  fromYamlProjection,
  toYamlProjection,
} from "../src/contracts/yaml-projection.js";
import {createEagerContractValidator} from "./support/eager-contract-validator.mjs";

async function fixture(path) {
  return JSON.parse(await readFile(new URL(
    `./fixtures/common/${path}`,
    import.meta.url,
  ),"utf8"));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
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
const danglingQuestionAffectedEntityGraph=await fixture(
  "invalid/dangling-question-affected-entity.json",
);
const danglingArtifactGraph=await fixture("invalid/dangling-artifact-reference.json");
const mismatchedArtifactTypeGraph=await fixture("invalid/mismatched-artifact-document-type.json");
const duplicateGraph=await fixture("invalid/duplicate-entity-id.json");
const conflictingPrefixGraph=await fixture("invalid/conflicting-prefix.json");
const acpFixture=JSON.parse(await readFile(new URL(
  "./fixtures/acp/full-pipeline.json",
  import.meta.url,
),"utf8"));
const pmAnalysisFixture=JSON.parse(await readFile(new URL(
  "./fixtures/pm-analysis/valid/complete-artifact.json",
  import.meta.url,
),"utf8"));
const issuePlanFixture=JSON.parse(await readFile(new URL(
  "./fixtures/issue-plan/valid/complete-artifact.json",
  import.meta.url,
),"utf8"));
const designGraphFixture=JSON.parse(await readFile(new URL(
  "./fixtures/design-contracts/valid-graph.json",
  import.meta.url,
),"utf8"));

const logicalSchemaIds=[
  "adr-approval.v1",
  "adr.v1",
  "architecture-constraint.v1",
  "architecture.v1",
  "artifact-envelope.v1",
  "command-result.v1",
  "decision-answer.v1",
  "decision-package.v1",
  "design-approval.v1",
  "design-audit.v1",
  "design-brief.v1",
  "design-orchestration-state.v1",
  "design-system.v1",
  "entity.v1",
  "feature-delta.v1",
  "finding.v1",
  "github-publication-result.v1",
  "information-architecture.v1",
  "issue-plan.v1",
  "pdor-result.v1",
  "pm-analysis.v1",
  "project-input.v1",
  "prototype-manifest.v1",
  "provenance.v1",
  "question.v1",
  "reference.v1",
  "screen-spec.v1",
  "spec-audit.v1",
  "trace-graph.v1",
  "trace-result.v1",
  "transition-event.v1",
  "ui-design-dor-result.v1",
  "usability-evidence.v1",
  "user-flow.v1",
  "ux-analysis.v1",
  "visual-direction.v1",
  "wireframe-plan.v1",
];

const designSchemaByDocumentType={
  "design-brief":"design-brief.v1",
  "ux-analysis":"ux-analysis.v1",
  "user-flow":"user-flow.v1",
  "information-architecture":"information-architecture.v1",
  "wireframe-plan":"wireframe-plan.v1",
  "visual-direction":"visual-direction.v1",
  "design-system":"design-system.v1",
  "screen-spec":"screen-spec.v1",
  "prototype-manifest":"prototype-manifest.v1",
  "usability-evidence":"usability-evidence.v1",
  "design-audit":"design-audit.v1",
  "design-approval":"design-approval.v1",
};

function replaceDesignHashTokens(value,hash) {
  if (Array.isArray(value)) return value.map(item => replaceDesignHashTokens(item,hash));
  if (!value || typeof value!=="object") {
    return typeof value==="string" && value.startsWith("@") ? hash : value;
  }
  return Object.fromEntries(Object.entries(value).map(([key,item]) => [
    key,replaceDesignHashTokens(item,hash),
  ]));
}

function designDocuments() {
  const hash="d".repeat(64);
  const documents=[];
  for (const descriptor of designGraphFixture.artifacts) {
    const referenceFor=documentType => ({
      document_type:documentType,
      artifact_id:`${documentType}:DESIGN-CHECKOUT`,
      revision:1,
      content_sha256:hash,
    });
    const parents=(descriptor.parents ?? []).map(referenceFor);
    const content=replaceDesignHashTokens(descriptor.content,hash);
    if (descriptor.document_type==="design-approval") {
      content.graph_manifest=documents.map(document => referenceFor(document.document_type));
      content.graph_root_sha256=hash;
    }
    documents.push({
      schema_version:"acp.v1",
      document_type:descriptor.document_type,
      artifact_id:`${descriptor.document_type}:DESIGN-CHECKOUT`,
      revision:1,
      run_id:"run:design-equivalence:001",
      producer:{role:descriptor.producer_role,identity:`toss-${descriptor.producer_role}`},
      runtime_identity:{kind:"agent",name:"fixture-runtime",version:"1.0.0"},
      created_at:"2026-08-17T12:00:00Z",
      provenance:{
        source_revision:designGraphFixture.source_revision,
        source_sha256:designGraphFixture.source_sha256,
        locations:["project-brief.md#design"],
      },
      parents,
      inputs:parents,
      content_sha256:hash,
      content,
    });
  }
  return documents;
}

function programmaticCanonicalFailures() {
  const undefinedContent=cloneJson(validArtifactEnvelope);
  undefinedContent.content=undefined;

  const dateContent=cloneJson(validArtifactEnvelope);
  dateContent.content=new Date("2026-08-17T00:00:00.000Z");

  const customPrototypeContent=cloneJson(validArtifactEnvelope);
  customPrototypeContent.content=Object.create({inherited:true});

  const hiddenContent=cloneJson(validArtifactEnvelope);
  Object.defineProperty(hiddenContent.content,"hidden",{
    enumerable:false,
    value:true,
  });

  const symbolContent=cloneJson(validArtifactEnvelope);
  symbolContent.content[Symbol("hidden")]=true;

  const accessorContent=cloneJson(validArtifactEnvelope);
  Object.defineProperty(accessorContent.content,"computed",{
    enumerable:true,
    get() {
      return true;
    },
  });

  const inheritedEnvelope=Object.create(validArtifactEnvelope);
  return [
    ["undefined content",undefinedContent],
    ["Date content",dateContent],
    ["custom-prototype content",customPrototypeContent],
    ["non-enumerable content",hiddenContent],
    ["symbol content",symbolContent],
    ["accessor content",accessorContent],
    ["inherited envelope",inheritedEnvelope],
  ];
}

function assertEquivalentValidation(eager,demand,value,schemaId,label) {
  const expected=eager.validateDocument(value,schemaId);
  const actual=demand.validateDocument(value,schemaId);
  assert.deepStrictEqual(actual,expected,label);
  assert.equal(canonicalJson(actual),canonicalJson(expected),label);
  return actual;
}

test("demand validation remains byte-equivalent to the issue 86 eager reference",() => {
  const eager=createEagerContractValidator();
  const demand=createContractValidator();

  for (const schemaId of logicalSchemaIds) {
    assertEquivalentValidation(eager,demand,{},schemaId,`empty ${schemaId}`);
  }

  const commonCases=[
    [validArtifactEnvelope,"artifact-envelope.v1"],
    [validEntity,"entity.v1"],
    [validProvenance,"provenance.v1"],
    [validInternalReference,"reference.v1"],
    [validExternalReference,"reference.v1"],
    [validQuestion,"question.v1"],
    [invalidPrefix,"entity.v1"],
    [invalidEnvelopeProperty,"artifact-envelope.v1"],
    [invalidReferenceVariant,"reference.v1"],
    [invalidQuestion,"question.v1"],
  ];
  for (const [value,schemaId] of commonCases) {
    assertEquivalentValidation(eager,demand,value,schemaId,`common ${schemaId}`);
  }
  for (const graph of [
    validGraph,
    danglingGraph,
    danglingQuestionAffectedEntityGraph,
    danglingArtifactGraph,
    mismatchedArtifactTypeGraph,
    duplicateGraph,
    conflictingPrefixGraph,
  ]) {
    for (const artifact of graph) {
      assertEquivalentValidation(
        eager,demand,artifact,"artifact-envelope.v1","common graph artifact",
      );
    }
  }

  assert.equal(assertEquivalentValidation(
    eager,demand,pmAnalysisFixture,"pm-analysis.v1","valid PM analysis",
  ).valid,true);
  assert.equal(assertEquivalentValidation(
    eager,demand,{...pmAnalysisFixture,unexpected:true},"pm-analysis.v1","invalid PM analysis",
  ).valid,false);
  assert.equal(assertEquivalentValidation(
    eager,demand,issuePlanFixture,"issue-plan.v1","valid issue plan",
  ).valid,true);
  assert.equal(assertEquivalentValidation(
    eager,demand,{...issuePlanFixture,unexpected:true},"issue-plan.v1","invalid issue plan",
  ).valid,false);

  const designs=designDocuments();
  for (const document of designs) {
    const schemaId=designSchemaByDocumentType[document.document_type];
    assert.equal(assertEquivalentValidation(
      eager,demand,document,schemaId,`valid design ${document.document_type}`,
    ).valid,true);
  }
  assert.equal(assertEquivalentValidation(
    eager,
    demand,
    {...designs[0],unexpected:true},
    "design-brief.v1",
    "invalid design brief",
  ).valid,false);

  const commandSuccess={
    schema_version:"command-result.v1",
    document_type:"command-result",
    ok:true,
    data:{ready:true,evidence:["PDOR-001"]},
    error:null,
  };
  const commandFailure={
    schema_version:"command-result.v1",
    document_type:"command-result",
    ok:false,
    data:null,
    error:{code:"READINESS_BLOCKED",message:"Audit failed"},
  };
  for (const value of [
    commandSuccess,
    commandFailure,
    {...commandSuccess,extra:true},
    {...commandFailure,error:{...commandFailure.error,extra:true}},
  ]) {
    assertEquivalentValidation(eager,demand,value,"command-result.v1","command result");
  }

  for (const [name,value] of programmaticCanonicalFailures()) {
    assert.equal(assertEquivalentValidation(
      eager,demand,value,"artifact-envelope.v1",name,
    ).valid,false);
  }

  const impossibleDate=cloneJson(validArtifactEnvelope);
  impossibleDate.created_at="2026-02-30T12:00:00Z";
  for (const [label,value,schemaId] of [
    ["impossible RFC3339 date",impossibleDate,"artifact-envelope.v1"],
    ["additional property",invalidEnvelopeProperty,"artifact-envelope.v1"],
    ["broken reference",invalidReferenceVariant,"reference.v1"],
  ]) {
    assert.equal(assertEquivalentValidation(eager,demand,value,schemaId,label).valid,false);
  }

  let eagerOutput;
  let demandOutput;
  let eagerError;
  let demandError;
  try {
    eagerOutput=eager.validateDocument({},"unknown.v1");
  } catch (error) {
    eagerError=error;
  }
  try {
    demandOutput=demand.validateDocument({},"unknown.v1");
  } catch (error) {
    demandError=error;
  }
  assert.equal(eagerOutput,undefined);
  assert.equal(demandOutput,undefined);
  assert.deepStrictEqual(
    {constructorName:demandError?.constructor.name,message:demandError?.message},
    {constructorName:eagerError?.constructor.name,message:eagerError?.message},
  );
});

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
    () => validateArtifactGraph(danglingQuestionAffectedEntityGraph),
    /dangling reference.*affected_entities/i,
  );
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
  assert.ok(SEMANTIC_VALIDATION_BOUNDARY.semantic.includes("question affected entity targets"));
});

test("public document validation fails closed for programmatic values outside canonical JSON",() => {
  for (const [name,value] of programmaticCanonicalFailures()) {
    let result;
    assert.doesNotThrow(() => {
      result=validateDocument(value,"artifact-envelope.v1");
    },name);
    assert.equal(result.valid,false,name);
    assert.ok(Array.isArray(result.errors) && result.errors.length > 0,name);
  }
});

test("timestamp validation accepts real RFC3339 timestamps and rejects impossible values",() => {
  const impossibleTimestamps=[
    "2026-02-30T12:00:00Z",
    "2026-08-17T24:00:00Z",
    "2026-08-17T12:60:00Z",
    "2026-08-17T12:00:00+24:00",
    "2026-08-17T12:00:00+05:60",
  ];
  for (const timestamp of impossibleTimestamps) {
    const envelope=cloneJson(validArtifactEnvelope);
    envelope.created_at=timestamp;
    assert.equal(
      validateDocument(envelope,"artifact-envelope.v1").valid,
      false,
      `envelope ${timestamp}`,
    );
    const provenance=cloneJson(validProvenance);
    provenance.timestamp=timestamp;
    assert.equal(
      validateDocument(provenance,"provenance.v1").valid,
      false,
      `provenance ${timestamp}`,
    );
  }
  for (const timestamp of [
    "2024-02-29T23:59:59Z",
    "2026-08-17T17:30:00.123+05:30",
  ]) {
    const envelope=cloneJson(validArtifactEnvelope);
    envelope.created_at=timestamp;
    assert.equal(validateDocument(envelope,"artifact-envelope.v1").valid,true);
    const provenance=cloneJson(validProvenance);
    provenance.timestamp=timestamp;
    assert.equal(validateDocument(provenance,"provenance.v1").valid,true);
  }
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
