import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {canonicalJson, sha256Canonical} from "../src/contracts/acp.js";
import {validateDocument} from "../src/contracts/validator.js";
import {
  buildDecisionPackage,
  buildDecisionPackageFromPmAnalysis,
  classifyQuestion,
  evaluateDecisionGate,
} from "../src/pipeline/decisions.js";

async function fixture(path) {
  return JSON.parse(await readFile(new URL(
    `./fixtures/decisions/${path}`,
    import.meta.url,
  ),"utf8"));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function authorityAttestation(question,resolution,record={}) {
  const a3=resolution.authority==="A3";
  const recordId=record.record_id ?? `AUTH-${question.id}`;
  const recordRevision=record.record_revision ?? 1;
  const attestation={
    verification_kind:a3 ?
      "A3_VERIFIED_CEO_OR_USER_AUTHORITY" :
      "A2_ARCHITECT_OR_SPECIALIST_EVIDENCE",
    actor_id:a3 ? "verified-ceo" : "assigned-architect",
    actor_role:a3 ? "CEO" : "ARCHITECT",
    record_id:recordId,
    record_revision:recordRevision,
    record_sha256:record.record_sha256 ?? sha256Canonical({
      record_id:recordId,
      revision:recordRevision,
    }),
    timestamp:"2026-08-17T12:05:00.000Z",
  };
  return {
    ...attestation,
    binding_sha256:sha256Canonical({
      source_id:question.id,
      decision:resolution.decision,
      rationale:resolution.rationale,
      authority:resolution.authority,
      owner:resolution.owner,
      authority_attestation:attestation,
    }),
  };
}

function authorityResolution(question,authority,owner) {
  const resolution={
    decision:`${question.id} was resolved by the required authority.`,
    rationale:"The recorded decision resolves the blocking ambiguity.",
    authority,
    owner,
    provenance:clone(question.provenance),
  };
  return {
    ...resolution,
    authority_attestation:authorityAttestation(question,resolution),
  };
}

async function pmAnalysisFixture() {
  return JSON.parse(await readFile(new URL(
    "./fixtures/pm-analysis/valid/complete-artifact.json",
    import.meta.url,
  ),"utf8"));
}

test("severity maps deterministically to authority, owner, and stop behavior",() => {
  const p0=classifyQuestion({severity:"P0"});
  const p1=classifyQuestion({severity:"P1"});
  const p2=classifyQuestion({severity:"P2"});
  const p3=classifyQuestion({severity:"P3"});
  const p4=classifyQuestion({severity:"P4"});

  assert.equal(p0.authority,"A3");
  assert.equal(p0.owner,"USER");
  assert.equal(p0.hard_stop,true);
  assert.equal(p1.authority,"A2");
  assert.equal(p1.owner,"ARCHITECT");
  assert.equal(p2.authority,"A3");
  assert.equal(p2.owner,"USER");
  assert.equal(p3.authority,"A1");
  assert.equal(p3.owner,"PM");
  assert.equal(p3.requires_assumption_evidence,true);
  assert.equal(p4.authority,"A1");
  assert.equal(p4.owner,"PM");
  assert.equal(p4.requires_assumption_evidence,true);
  assert.equal(Object.isFrozen(p0),true);
});

test("only the structured P1 business-input condition can escalate a technical choice to USER",async () => {
  const [{...businessInputMissing}]=await fixture("valid/p1-business-input-missing.json");
  const route=classifyQuestion(businessInputMissing);

  assert.equal(route.authority,"A3");
  assert.equal(route.owner,"USER");
  assert.equal(route.business_input_missing,true);
  const documentedTechnicalAssumption=classifyQuestion({
    severity:"P3",
    technical_preference:true,
  });
  assert.equal(documentedTechnicalAssumption.authority,"A1");
  assert.equal(documentedTechnicalAssumption.owner,"PM");
  assert.throws(
    () => classifyQuestion({severity:"P2",technical_preference:true}),
    /technical preference/i,
  );
  assert.throws(
    () => classifyQuestion({severity:"P1",authority:"A3"}),
    /contradicts/i,
  );
  assert.throws(() => classifyQuestion({severity:"P9"}),/severity/i);
});

test("a decision package is deterministic, immutable, schema-valid, and recomputes its gate",async () => {
  const questions=await fixture("valid/blocking.json");
  const before=clone(questions);
  const first=buildDecisionPackage(questions);
  const second=buildDecisionPackage(clone(questions));

  assert.deepEqual(first,second);
  assert.deepEqual(first,buildDecisionPackage([...clone(questions)].reverse()));
  assert.deepEqual(questions,before);
  assert.equal(Object.isFrozen(first),true);
  assert.equal(Object.isFrozen(first.questions),true);
  assert.equal(Object.isFrozen(first.questions[0]),true);
  assert.equal(Object.isFrozen(first.questions[0].evidence[0].provenance),true);
  assert.equal(validateDocument(first,"decision-package.v1").valid,true);
  assert.equal(first.gate.can_continue,false);
  assert.deepEqual(first.gate.unresolved_blocking_question_ids,["Q-BLOCKING"]);

  const forged=clone(first);
  forged.gate={
    can_continue:true,
    status:"CLEAR",
    unresolved_blocking_question_ids:[],
    unresolved_assumption_question_ids:[],
  };
  assert.throws(() => evaluateDecisionGate(forged),/gate/i);
});

test("resolved P0-P2 decisions do not block a package",async () => {
  const resolved=await fixture("valid/resolved.json");
  const p1={
    ...clone(resolved[0]),
    id:"Q-RESOLVED-P1",
    meaning:"Confirm resolved architecture evidence",
    question:"Is the architecture evidence resolved?",
    severity:"P1",
  };
  p1.authority_resolution=authorityResolution(p1,"A2","ARCHITECT");
  const p2={
    ...clone(resolved[0]),
    id:"Q-RESOLVED-P2",
    meaning:"Confirm resolved product behavior",
    question:"Is the product behavior resolved?",
    severity:"P2",
  };
  p2.authority_resolution=authorityResolution(p2,"A3","USER");
  const packageResult=buildDecisionPackage([...resolved,p1,p2]);

  assert.equal(packageResult.gate.can_continue,true);
  assert.deepEqual(packageResult.gate.unresolved_blocking_question_ids,[]);
  assert.equal(evaluateDecisionGate(packageResult).can_continue,true);
});

test("blocking resolution records require the exact derived authority, owner, and provenance",async () => {
  const [base]=await fixture("valid/blocking.json");
  const variants=[
    ["Q-RES-P0","P0",{},"A3","USER"],
    ["Q-RES-P1","P1",{},"A2","ARCHITECT"],
    ["Q-RES-P1-BUSINESS","P1",{business_input_missing:true},"A3","USER"],
    ["Q-RES-P2","P2",{},"A3","USER"],
  ];
  for (const [id,severity,extra,authority,owner] of variants) {
    const question={
      ...clone(base),
      id,
      meaning:`Resolve ${id} authority`,
      question:`Can ${id} be resolved?`,
      severity,
      status:"resolved",
      ...extra,
    };
    question.authority_resolution=authorityResolution(question,authority,owner);
    const packageResult=buildDecisionPackage([question]);
    assert.equal(packageResult.gate.can_continue,true,id);
    assert.equal(packageResult.questions[0].authority_resolutions[0].authority,authority,id);
    assert.equal(packageResult.questions[0].authority_resolutions[0].owner,owner,id);
  }

  const missing={...clone(base),status:"resolved"};
  assert.throws(() => buildDecisionPackage([missing]),/authority resolution/i);

  const wrong={...clone(base),status:"resolved"};
  wrong.authority_resolution=authorityResolution(wrong,"A2","ARCHITECT");
  assert.throws(() => buildDecisionPackage([wrong]),/authority.*mapping/i);

  const bare={...clone(base),status:"resolved",resolution:"A claimed resolution"};
  assert.throws(() => buildDecisionPackage([bare]),/unsupported field resolution/i);
});

test("ordinary PM provenance cannot clear a P0 without a verified authority attestation",async () => {
  const [base]=await fixture("valid/blocking.json");
  const p0={...clone(base),status:"resolved"};
  p0.authority_resolution=authorityResolution(p0,"A3","USER");
  delete p0.authority_resolution.authority_attestation;

  assert.equal(p0.authority_resolution.provenance.agent.identity,"pm-agent");
  assert.throws(() => buildDecisionPackage([p0]),/authority attestation/i);
});

test("ordinary A2 specialist resolution cannot clear a P1 without an authority attestation",async () => {
  const [base]=await fixture("valid/blocking.json");
  const p1={
    ...clone(base),
    id:"Q-ATTESTATION-P1",
    severity:"P1",
    status:"resolved",
  };
  p1.authority_resolution=authorityResolution(p1,"A2","ARCHITECT");
  delete p1.authority_resolution.authority_attestation;

  assert.throws(() => buildDecisionPackage([p1]),/authority attestation/i);
});

test("a tampered authority-attestation binding cannot clear a P0",async () => {
  const [base]=await fixture("valid/blocking.json");
  const p0={...clone(base),status:"resolved"};
  p0.authority_resolution=authorityResolution(p0,"A3","USER");
  p0.authority_resolution.decision="A tampered authority decision.";

  assert.throws(() => buildDecisionPackage([p0]),/binding/i);

  const verified={...clone(base),status:"resolved"};
  verified.authority_resolution=authorityResolution(verified,"A3","USER");
  const forgedPackage=clone(buildDecisionPackage([verified]));
  forgedPackage.questions[0].evidence[0].authority_resolution.decision=
    "A forged retained-evidence decision.";
  assert.throws(() => evaluateDecisionGate(forgedPackage),/binding/i);
});

test("authority-attestation route profiles reject wrong verification kinds and actor roles",async () => {
  const [base]=await fixture("valid/blocking.json");
  const wrongKind={...clone(base),status:"resolved"};
  wrongKind.authority_resolution=authorityResolution(wrongKind,"A3","USER");
  wrongKind.authority_resolution.authority_attestation.verification_kind=
    "A2_ARCHITECT_OR_SPECIALIST_EVIDENCE";
  assert.throws(() => buildDecisionPackage([wrongKind]),/route/i);

  const wrongRole={...clone(base),status:"resolved"};
  wrongRole.authority_resolution=authorityResolution(wrongRole,"A3","USER");
  wrongRole.authority_resolution.authority_attestation.actor_role="ARCHITECT";
  assert.throws(() => buildDecisionPackage([wrongRole]),/actor role.*route/i);
});

test("authority attestations require a non-blank actor and cannot reuse an immutable record",async () => {
  const [base]=await fixture("valid/blocking.json");
  const malformed={...clone(base),status:"resolved"};
  malformed.authority_resolution=authorityResolution(malformed,"A3","USER");
  malformed.authority_resolution.authority_attestation.actor_id="";
  assert.throws(() => buildDecisionPackage([malformed]),/actor_id/i);

  const malformedTimestamp={...clone(base),status:"resolved"};
  malformedTimestamp.authority_resolution=authorityResolution(
    malformedTimestamp,
    "A3",
    "USER",
  );
  malformedTimestamp.authority_resolution.authority_attestation.timestamp="not-a-timestamp";
  const attestation=malformedTimestamp.authority_resolution.authority_attestation;
  attestation.binding_sha256=sha256Canonical({
    source_id:malformedTimestamp.id,
    decision:malformedTimestamp.authority_resolution.decision,
    rationale:malformedTimestamp.authority_resolution.rationale,
    authority:malformedTimestamp.authority_resolution.authority,
    owner:malformedTimestamp.authority_resolution.owner,
    authority_attestation:{
      verification_kind:attestation.verification_kind,
      actor_id:attestation.actor_id,
      actor_role:attestation.actor_role,
      record_id:attestation.record_id,
      record_revision:attestation.record_revision,
      record_sha256:attestation.record_sha256,
      timestamp:attestation.timestamp,
    },
  });
  assert.throws(() => buildDecisionPackage([malformedTimestamp]),/timestamp/i);

  const first={...clone(base),status:"resolved"};
  first.authority_resolution=authorityResolution(first,"A3","USER");
  const second={
    ...clone(base),
    id:"Q-ATTESTATION-DUPLICATE",
    status:"resolved",
  };
  second.authority_resolution=authorityResolution(second,"A3","USER");
  const record=first.authority_resolution.authority_attestation;
  second.authority_resolution.authority_attestation=authorityAttestation(
    second,
    second.authority_resolution,
    record,
  );
  assert.throws(() => buildDecisionPackage([first,second]),/duplicated/i);
});

test("retained evidence exactly determines material fields, source identities, and blocking resolution coverage",async () => {
  const [base]=await fixture("valid/blocking.json");
  const p0={
    ...clone(base),
    id:"Q-RESOLUTION-P0",
    meaning:"Record the merged authority decision",
    question:"Has the merged authority decision been recorded?",
    status:"resolved",
  };
  p0.authority_resolution=authorityResolution(p0,"A3","USER");
  const p1={
    ...clone(p0),
    id:"Q-RESOLUTION-P1",
    severity:"P1",
  };
  p1.authority_resolution=authorityResolution(p1,"A2","ARCHITECT");
  const packageResult=buildDecisionPackage([p0,p1]);
  assert.equal(packageResult.gate.status,"CLEAR");
  assert.equal(packageResult.questions[0].authority_resolutions.length,2);

  const materialForgery=clone(packageResult);
  materialForgery.questions[0].context="Forged top-level context.";
  assert.throws(() => evaluateDecisionGate(materialForgery),/canonical.*evidence/i);

  const sourceIdForgery=clone(packageResult);
  sourceIdForgery.questions[0].source_ids=["Q-RESOLUTION-P0"];
  assert.throws(() => evaluateDecisionGate(sourceIdForgery),/source ID.*source_ids/i);

  const missingResolution=clone(packageResult);
  delete missingResolution.questions[0].evidence.find(evidence =>
    evidence.source_id==="Q-RESOLUTION-P1",
  ).authority_resolution;
  assert.throws(() => evaluateDecisionGate(missingResolution),/authority_resolution|authority resolution/i);
});

test("gate evaluation rejects forged canonical routing when retained evidence remains blocking",async () => {
  const packageResult=buildDecisionPackage(await fixture("valid/blocking.json"));
  const forged=clone(packageResult);
  forged.questions[0].severity="P3";
  forged.questions[0].authority="A1";
  forged.questions[0].owner="PM";
  forged.questions[0].reversibility="reversible";
  forged.gate={
    can_continue:true,
    status:"CLEAR",
    unresolved_blocking_question_ids:[],
    unresolved_assumption_question_ids:["Q-BLOCKING"],
  };

  assert.throws(() => evaluateDecisionGate(forged),/canonical|evidence|gate/i);
});

test("PM analysis adapter requires exact material enrichments and preserves PM-owned questions",async () => {
  const pmAnalysis=await pmAnalysisFixture();
  const enrichments=await fixture("valid/pm-enrichments.json");
  const before=clone({pmAnalysis,enrichments});
  const packageResult=buildDecisionPackageFromPmAnalysis(pmAnalysis,enrichments);

  assert.equal(validateDocument(packageResult,"decision-package.v1").valid,true);
  assert.equal(packageResult.questions[0].id,"Q-001");
  assert.equal(packageResult.questions[0].severity,"P2");
  assert.equal(packageResult.questions[0].owner,"USER");
  assert.equal(packageResult.gate.can_continue,false);
  assert.deepEqual({pmAnalysis,enrichments},before);

  assert.throws(
    () => buildDecisionPackageFromPmAnalysis(pmAnalysis,[]),
    /missing enrichment/i,
  );
  assert.throws(
    () => buildDecisionPackageFromPmAnalysis(pmAnalysis,[...enrichments,clone(enrichments[0])]),
    /duplicate enrichment/i,
  );
  assert.throws(
    () => buildDecisionPackageFromPmAnalysis(pmAnalysis,[{
      ...enrichments[0],
      id:"Q-UNKNOWN",
    }]),
    /unknown enrichment/i,
  );
  const nonCanonical=clone(enrichments);
  nonCanonical[0].context=undefined;
  assert.throws(
    () => buildDecisionPackageFromPmAnalysis(pmAnalysis,nonCanonical),
    /canonical JSON/i,
  );
});

test("deduplication uses normalized meaning and canonical affected entities without losing evidence",async () => {
  const packageResult=buildDecisionPackage(await fixture("valid/dedup.json"));
  const [base,canonical]=packageResult.questions;

  assert.equal(packageResult.questions.length,2);
  assert.equal(base.id,"Q-BASE");
  assert.equal(canonical.id,"Q-DUP-A");
  assert.equal(canonical.severity,"P1");
  assert.equal(canonical.authority,"A2");
  assert.deepEqual(canonical.affected_entities,["NFR-001","REQ-001"]);
  assert.deepEqual(canonical.source_ids,["Q-DUP-A","Q-DUP-B"]);
  assert.equal(canonical.evidence.length,2);
  assert.deepEqual(canonical.dependencies,["Q-BASE"]);
});

test("matching meaning with a different affected-entity set remains a distinct decision",async () => {
  const questions=await fixture("valid/dedup.json");
  questions.find(question => question.id==="Q-DUP-B").affected_entities=[
    "NFR-002",
    "REQ-001",
  ];

  const packageResult=buildDecisionPackage(questions);

  assert.deepEqual(
    packageResult.questions.map(question => question.id),
    ["Q-BASE","Q-DUP-A","Q-DUP-B"],
  );
});

test("dependencies that point to a duplicate source ID are rewritten to its canonical ID",async () => {
  const questions=await fixture("valid/dedup.json");
  const consumer={
    ...clone(questions.find(question => question.id==="Q-BASE")),
    id:"Q-CONSUMER",
    meaning:"Approve the chosen storage strategy",
    question:"Can the selected storage strategy be approved?",
    dependencies:["Q-DUP-B"],
  };

  const packageResult=buildDecisionPackage([...questions,consumer]);
  const canonical=packageResult.questions.find(question => question.id==="Q-CONSUMER");

  assert.deepEqual(canonical.dependencies,["Q-DUP-A"]);
});

test("dependencies are rewritten to canonical ids and emitted in stable topological order",async () => {
  const packageResult=buildDecisionPackage(await fixture("valid/dependencies.json"));

  assert.deepEqual(
    packageResult.questions.map(question => question.id),
    ["Q-ALPHA","Q-BRAVO","Q-CHARLIE"],
  );
  assert.deepEqual(packageResult.questions[2].dependencies,["Q-ALPHA","Q-BRAVO"]);
});

test("canonical ordering does not depend on ambient locale behavior",async () => {
  const questions=await fixture("valid/dedup.json");
  const original=String.prototype.localeCompare;
  String.prototype.localeCompare=function localeDependentOrdering() {
    throw new Error("ambient locale ordering was used");
  };
  try {
    assert.doesNotThrow(() => buildDecisionPackage(questions));
  } finally {
    String.prototype.localeCompare=original;
  }
});

test("cyclic and dangling dependencies fail closed",async () => {
  await assert.rejects(
    async () => buildDecisionPackage(await fixture("invalid/cycle.json")),
    /cycle/i,
  );
  await assert.rejects(
    async () => buildDecisionPackage(await fixture("invalid/dangling.json")),
    /dangling/i,
  );
  const self=await fixture("invalid/dangling.json");
  self[0].dependencies=[self[0].id];
  assert.throws(() => buildDecisionPackage(self),/self dependency/i);
});

test("P3 and P4 assumptions require visible provenance, impact, and reversibility",async () => {
  const p3p4=buildDecisionPackage(await fixture("valid/p3-p4-assumptions.json"));

  assert.equal(p3p4.gate.can_continue,true);
  assert.ok(p3p4.questions.every(question =>
    question.impact && question.reversibility && question.provenance,
  ));
  await assert.rejects(
    async () => buildDecisionPackage(await fixture("invalid/p3-missing-evidence.json")),
    /reversibility/i,
  );
  await assert.rejects(
    async () => buildDecisionPackage(await fixture("invalid/p4-missing-impact.json")),
    /impact/i,
  );
  const forged=clone(p3p4);
  delete forged.questions[0].evidence[0].reversibility;
  assert.throws(() => evaluateDecisionGate(forged),/reversibility/i);
});

test("noncanonical values and conflicting duplicate identities fail closed",async () => {
  const questions=await fixture("valid/blocking.json");
  Object.defineProperty(questions[0],"hidden",{enumerable:false,value:true});
  assert.throws(() => buildDecisionPackage(questions),/non-enumerable/i);

  const conflicting=await fixture("invalid/conflicting-duplicate-id.json");
  assert.throws(() => buildDecisionPackage(conflicting),/duplicate question id/i);
  const duplicateSource=await fixture("valid/blocking.json");
  duplicateSource.push({...clone(duplicateSource[0]),impact:"Different material impact."});
  assert.throws(
    () => buildDecisionPackage(duplicateSource),
    /duplicate source question id/i,
  );
  const canonicalPackage=buildDecisionPackage(clone(
    await fixture("valid/blocking.json"),
  ));
  assert.doesNotThrow(() => canonicalJson(canonicalPackage));
});
