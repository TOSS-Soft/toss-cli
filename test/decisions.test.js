import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {canonicalJson} from "../src/contracts/acp.js";
import {validateDocument} from "../src/contracts/validator.js";
import {
  buildDecisionPackage,
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
  const recomputed=evaluateDecisionGate(forged);
  assert.equal(recomputed.can_continue,false);
  assert.equal(Object.isFrozen(recomputed),true);
  assert.deepEqual(recomputed.unresolved_blocking_question_ids,["Q-BLOCKING"]);
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
  const p2={
    ...clone(resolved[0]),
    id:"Q-RESOLVED-P2",
    meaning:"Confirm resolved product behavior",
    question:"Is the product behavior resolved?",
    severity:"P2",
  };
  const packageResult=buildDecisionPackage([...resolved,p1,p2]);

  assert.equal(packageResult.gate.can_continue,true);
  assert.deepEqual(packageResult.gate.unresolved_blocking_question_ids,[]);
  assert.equal(evaluateDecisionGate(packageResult).can_continue,true);
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
  const canonicalPackage=buildDecisionPackage(clone(
    await fixture("valid/blocking.json"),
  ));
  assert.doesNotThrow(() => canonicalJson(canonicalPackage));
});
