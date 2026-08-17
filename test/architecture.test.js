import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {sha256Canonical} from "../src/contracts/acp.js";
import {validateDocument} from "../src/contracts/validator.js";
import {
  buildArchitecture,
  validateArchitecture,
} from "../src/pipeline/architecture.js";

function fixture(path) {
  return JSON.parse(fs.readFileSync(new URL(path,import.meta.url),"utf8"));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function rehash(artifact) {
  artifact.content_sha256=sha256Canonical(artifact.content);
  return artifact;
}

function reference(artifact) {
  return {
    artifact_id:artifact.artifact_id,
    revision:artifact.revision,
    content_sha256:artifact.content_sha256,
    document_type:artifact.document_type,
  };
}

function pmAnalysis({questionSeverity="P3"}={}) {
  const analysis=fixture("./fixtures/pm-analysis/valid/complete-artifact.json");
  analysis.content.open_questions[0].severity=questionSeverity;
  return rehash(analysis);
}

function architectureContext() {
  return fixture("./fixtures/architecture/valid/artifact-context.json");
}

function architectureDecisions() {
  return fixture("./fixtures/architecture/valid/decisions.json");
}

function architectureFor(analysis,decisions=architectureDecisions()) {
  return buildArchitecture({
    pmAnalysis:analysis,
    decisions,
    artifactContext:architectureContext(),
  });
}

function adrFor(analysis,architecture,content=fixture(
  "./fixtures/architecture/valid/adr-content.json",
)) {
  return rehash({
    schema_version:"acp.v1",
    document_type:"adr",
    artifact_id:"ADR-ARTIFACT-001",
    revision:1,
    run_id:"run-architecture-001",
    producer:{role:"architect",identity:"toss-architect"},
    runtime_identity:{kind:"deterministic",name:"toss-cli",version:"2.1.0"},
    created_at:"2026-08-17T13:00:00.000Z",
    provenance:clone(architecture.provenance),
    parents:[],
    inputs:[reference(analysis),reference(architecture)],
    content_sha256:"0".repeat(64),
    content:clone(content),
  });
}

function completeChain() {
  const analysis=pmAnalysis();
  const architecture=architectureFor(analysis);
  const adr=adrFor(analysis,architecture);
  return {pmAnalysis:analysis,architecture,adrs:[adr]};
}

test("architecture pipeline exposes deterministic construction and validation contracts",() => {
  assert.equal(typeof buildArchitecture,"function");
  assert.equal(typeof validateArchitecture,"function");
});

test("buildArchitecture creates a frozen Architect-owned artifact without mutating supplied PM evidence",() => {
  const analysis=pmAnalysis();
  const decisions=architectureDecisions();
  const artifactContext=architectureContext();
  const before=clone({analysis,decisions,artifactContext});

  const first=buildArchitecture({
    pmAnalysis:analysis,
    decisions,
    artifactContext,
  });
  const second=buildArchitecture({
    pmAnalysis:analysis,
    decisions,
    artifactContext,
  });

  assert.deepEqual(first,second);
  assert.deepEqual({analysis,decisions,artifactContext},before);
  assert.equal(Object.isFrozen(first),true);
  assert.equal(first.document_type,"architecture");
  assert.equal(first.producer.role,"architect");
  assert.deepEqual(first.inputs,[reference(analysis)]);
  assert.equal(first.content.pm_entity_snapshots.length,4);
  assert.equal(validateDocument(first,"architecture.v1").valid,true);
});

test("an approved complete architecture and ADR set is ready for PM finalization",() => {
  const chain=completeChain();
  const result=validateArchitecture(chain);

  assert.equal(validateDocument(chain.architecture,"architecture.v1").valid,true);
  assert.equal(validateDocument(chain.adrs[0],"adr.v1").valid,true);
  assert.equal(result.valid,true);
  assert.equal(result.complete,true);
  assert.equal(result.ready_for_pm_finalization,true);
  assert.deepEqual(result.findings,[]);
});

test("a pending ADR fixture keeps an otherwise valid contract out of PM finalization",() => {
  const chain=completeChain();
  const pending=fixture("./fixtures/architecture/invalid/pending-adr.json");
  chain.adrs[0].content.status=pending.status;
  chain.adrs[0].content.approval={
    ...chain.adrs[0].content.approval,
    ...pending.approval,
  };
  rehash(chain.adrs[0]);

  const result=validateArchitecture(chain);

  assert.equal(result.valid,true);
  assert.equal(result.complete,false);
  assert.equal(result.ready_for_pm_finalization,false);
  assert.ok(result.findings.some(finding => finding.type==="ADR_PENDING"));
  assert.ok(result.findings.some(finding => finding.type==="ADR_UNAPPROVED"));
});

test("an Architect cannot mutate, remove, or create PM-owned requirement snapshots",() => {
  const patch=fixture("./fixtures/architecture/invalid/mutated-requirement.json");
  const mutated=clone(completeChain());
  const snapshot=mutated.architecture.content.pm_entity_snapshots.find(item =>
    item.id===patch.target_id,
  );
  snapshot.snapshot.meaning=patch.changed_meaning;
  snapshot.canonical_sha256=sha256Canonical(snapshot.snapshot);
  rehash(mutated.architecture);

  assert.throws(
    () => validateArchitecture(mutated),
    /architect.*requirement/i,
  );

  const deleted=clone(completeChain());
  deleted.architecture.content.pm_entity_snapshots=deleted.architecture
    .content.pm_entity_snapshots.filter(item => item.id!=="REQ-001");
  rehash(deleted.architecture);
  assert.throws(() => validateArchitecture(deleted),/architect.*requirement/i);

  const created=clone(completeChain());
  const added=clone(created.architecture.content.pm_entity_snapshots[0]);
  added.id="REQ-404";
  added.snapshot.id="REQ-404";
  added.snapshot.meaning="An Architect-created product requirement.";
  added.canonical_sha256=sha256Canonical(added.snapshot);
  created.architecture.content.pm_entity_snapshots.push(added);
  rehash(created.architecture);
  assert.throws(() => validateArchitecture(created),/architect.*requirement/i);
});

test("missing business information is returned as an unresolved PM-owned finding",() => {
  const patch=fixture("./fixtures/architecture/invalid/missing-business.json");
  const analysis=pmAnalysis({questionSeverity:patch.severity});
  const architecture=architectureFor(analysis);
  const adr=adrFor(analysis,architecture);

  const result=validateArchitecture({pmAnalysis:analysis,architecture,adrs:[adr]});

  assert.equal(result.valid,true);
  assert.equal(result.ready_for_pm_finalization,false);
  assert.equal(result.findings[0].owner,"PM");
  assert.equal(result.findings[0].type,"UNRESOLVED_PM_BUSINESS_INFORMATION");
  assert.deepEqual(result.findings[0].affected_entities,["REQ-001"]);
  assert.match(result.findings[0].path,/open_questions/);
});

test("an ADR missing a normative section fails its closed contract",() => {
  const chain=completeChain();
  const patch=fixture("./fixtures/architecture/invalid/incomplete-adr.json");
  delete chain.adrs[0].content[patch.remove];
  rehash(chain.adrs[0]);

  const result=validateArchitecture(chain);

  assert.equal(validateDocument(chain.adrs[0],"adr.v1").valid,false);
  assert.equal(result.valid,false);
  assert.ok(result.findings.some(finding =>
    finding.type==="SCHEMA_VALIDATION" && finding.path===`/content/${patch.remove}`,
  ));
});

test("ADR links must resolve exact PM ARCHQ and requirement identities",() => {
  const chain=completeChain();
  const patch=fixture("./fixtures/architecture/invalid/dangling-link.json");
  chain.adrs[0].content.resolved_architecture_questions=[patch.architecture_question];
  chain.adrs[0].content.affected_requirements=[patch.requirement];
  rehash(chain.adrs[0]);

  const result=validateArchitecture(chain);

  assert.equal(result.valid,false);
  assert.ok(result.findings.some(finding =>
    finding.type==="DANGLING_ADR_ARCHITECTURE_QUESTION",
  ));
  assert.ok(result.findings.some(finding =>
    finding.type==="DANGLING_ADR_REQUIREMENT",
  ));
});

test("architecture constraints are provenance-bearing technical constraints, never business requirements",() => {
  const chain=completeChain();
  const constraint=chain.architecture.content.constraints[0];

  assert.equal(validateDocument(constraint,"architecture-constraint.v1").valid,true);
  assert.ok(constraint.provenance);
  const masquerading=clone(constraint);
  masquerading.id="NFR-999";
  masquerading.kind="non-functional-requirement";
  assert.equal(
    validateDocument(masquerading,"architecture-constraint.v1").valid,
    false,
  );
});

test("producer, exact provenance inputs, and programmatic JSON violations fail closed",() => {
  const wrongProducer=clone(completeChain());
  wrongProducer.architecture.producer.role="pm";
  assert.equal(validateArchitecture(wrongProducer).valid,false);
  assert.ok(validateArchitecture(wrongProducer).findings.some(finding =>
    finding.type==="SCHEMA_VALIDATION",
  ));

  const staleInput=clone(completeChain());
  staleInput.architecture.inputs[0].content_sha256="0".repeat(64);
  assert.equal(validateArchitecture(staleInput).valid,false);
  assert.ok(validateArchitecture(staleInput).findings.some(finding =>
    finding.type==="MISMATCHED_PM_INPUT",
  ));

  const nonCanonical=clone(completeChain());
  Object.defineProperty(nonCanonical.architecture.content.components[0],"hidden",{
    enumerable:false,
    value:true,
  });
  const result=validateArchitecture(nonCanonical);
  assert.equal(result.valid,false);
  assert.equal(result.findings[0].type,"CANONICAL_JSON");
});
