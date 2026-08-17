import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {sha256Canonical} from "../src/contracts/acp.js";
import {validateDocument} from "../src/contracts/validator.js";
import {
  buildPmAnalysis,
  validatePmAnalysis,
} from "../src/pipeline/pm-analysis.js";

function fixture(path) {
  return JSON.parse(fs.readFileSync(new URL(path,import.meta.url),"utf8"));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function allExtractedEntities(analysis) {
  const {content}=analysis;
  return [
    ...content.goals,
    ...content.non_goals,
    ...content.actors,
    ...content.functional_requirements,
    ...content.non_functional_requirements,
    ...content.business_rules,
    ...content.domains_modules,
    ...content.user_flows,
    ...content.integrations,
    ...content.constraints,
    ...content.assumptions,
    ...content.open_questions,
    ...content.risks,
    ...content.architecture_questions,
    ...content.epic_candidates,
  ];
}

const valid=fixture("./fixtures/pm-analysis/valid/complete-artifact.json");
const missingSection=fixture("./fixtures/pm-analysis/invalid/missing-section.json");
const technicalRequirement=fixture(
  "./fixtures/pm-analysis/invalid/technical-requirement.json",
);
const danglingArchitectureQuestion=fixture(
  "./fixtures/pm-analysis/invalid/dangling-architecture-question.json",
);
const missingAssumptionEvidence=fixture(
  "./fixtures/pm-analysis/invalid/missing-provenance.json",
);
const selfReferentialEpicCandidate=fixture(
  "./fixtures/pm-analysis/invalid/self-referential-epic-candidate.json",
);

const REQUIRED_COLLECTIONS=[
  "goals",
  "non_goals",
  "actors",
  "functional_requirements",
  "non_functional_requirements",
  "business_rules",
  "domains_modules",
  "user_flows",
  "integrations",
  "constraints",
  "assumptions",
  "open_questions",
  "risks",
  "architecture_questions",
  "epic_candidates",
];

test("a complete pm-analysis artifact validates with provenance for every extracted entity",() => {
  const result=validatePmAnalysis(valid);

  assert.equal(result.valid,true);
  assert.equal(result.complete,true);
  assert.deepEqual(result.findings,[]);
  assert.equal(validateDocument(valid,"pm-analysis.v1").valid,true);
  assert.equal(valid.content_sha256,sha256Canonical(valid.content));
  for (const entity of allExtractedEntities(valid)) {
    assert.ok(entity.provenance);
  }
});

test("buildPmAnalysis deterministically creates a PM-owned immutable envelope without mutating inputs",() => {
  const source=clone(valid.content);
  const provenance=clone(valid.provenance);
  delete source.goals[0].provenance;
  const artifactContext={
    artifact_id:valid.artifact_id,
    revision:valid.revision,
    run_id:valid.run_id,
    producer:clone(valid.producer),
    runtime_identity:clone(valid.runtime_identity),
    created_at:valid.created_at,
    parents:clone(valid.parents),
    inputs:clone(valid.inputs),
  };
  const before=clone({source,provenance,artifactContext});

  const first=buildPmAnalysis({source,provenance,artifactContext});
  const second=buildPmAnalysis({source,provenance,artifactContext});

  assert.deepEqual(first,second);
  assert.deepEqual({source,provenance,artifactContext},before);
  assert.equal(first.document_type,"pm-analysis");
  assert.equal(first.producer.role,"pm");
  assert.equal(first.content_sha256,sha256Canonical(first.content));
  assert.deepEqual(first.content.goals[0].provenance,provenance);
  assert.equal(validatePmAnalysis(first).complete,true);
});

test("a missing mandatory PM section blocks completion with a useful finding",() => {
  const result=validatePmAnalysis(missingSection);

  assert.equal(result.valid,false);
  assert.equal(result.complete,false);
  assert.ok(result.findings.some(finding =>
    finding.type==="MISSING_REQUIRED_SECTION" && finding.path==="/content/risks",
  ));
});

test("every mandatory PM collection requires material evidence",() => {
  for (const section of REQUIRED_COLLECTIONS) {
    const incomplete=clone(valid);
    incomplete.content[section]=[];
    incomplete.content_sha256=sha256Canonical(incomplete.content);

    const result=validatePmAnalysis(incomplete);

    assert.equal(result.valid,false,section);
    assert.equal(result.complete,false,section);
    assert.ok(result.findings.some(finding =>
      finding.type==="EMPTY_REQUIRED_SECTION" &&
        finding.path===`/content/${section}`,
    ),section);
  }
});

test("a blank PM summary blocks completion with a useful finding",() => {
  const incomplete=clone(valid);
  incomplete.content.summary=" \n\t ";
  incomplete.content_sha256=sha256Canonical(incomplete.content);

  const result=validatePmAnalysis(incomplete);

  assert.equal(result.valid,false);
  assert.equal(result.complete,false);
  assert.ok(result.findings.some(finding =>
    finding.type==="BLANK_REQUIRED_TEXT" && finding.path==="/content/summary",
  ));
});

test("a requirement explicitly typed as a technical solution is outside PM authority",() => {
  const result=validatePmAnalysis(technicalRequirement);

  assert.equal(result.valid,false);
  assert.equal(result.complete,false);
  assert.match(result.findings[0].type,/ROLE_BOUNDARY/);
});

test("a PM-authored ADR field is rejected as a structured role-boundary violation",() => {
  const pmAuthoredAdr=clone(valid);
  pmAuthoredAdr.content.adrs=[{
    id:"ADR-001",
    decision:"Use a specific database",
  }];
  pmAuthoredAdr.content_sha256=sha256Canonical(pmAuthoredAdr.content);

  const result=validatePmAnalysis(pmAuthoredAdr);

  assert.equal(result.valid,false);
  assert.match(result.findings[0].type,/ROLE_BOUNDARY/);
});

test("architecture questions must reference existing PM requirements and constraints",() => {
  const dangling=clone(valid);
  dangling.content.architecture_questions[0].affected_requirements=
    danglingArchitectureQuestion.content.architecture_questions[0].affected_requirements;
  dangling.content_sha256=sha256Canonical(dangling.content);

  const result=validatePmAnalysis(dangling);

  assert.equal(result.valid,false);
  assert.equal(result.complete,false);
  assert.ok(result.findings.some(finding =>
    finding.type==="SEMANTIC_DANGLING_REFERENCE" &&
      finding.path.includes("affected_requirements"),
  ));
});

test("duplicate PM entity identities fail semantic validation",() => {
  const duplicate=clone(valid);
  duplicate.content.functional_requirements.push(
    clone(duplicate.content.functional_requirements[0]),
  );
  duplicate.content_sha256=sha256Canonical(duplicate.content);

  const result=validatePmAnalysis(duplicate);

  assert.equal(result.valid,false);
  assert.ok(result.findings.some(finding =>
    finding.type==="SEMANTIC_VALIDATION" && /duplicate entity ID/i.test(finding.message),
  ));
});

test("epic candidate internal references must resolve to a PM entity",() => {
  const danglingEpic=clone(valid);
  danglingEpic.content.epic_candidates[0].source_entities[0].entity_id="REQ-404";
  danglingEpic.content_sha256=sha256Canonical(danglingEpic.content);

  const result=validatePmAnalysis(danglingEpic);

  assert.equal(result.valid,false);
  assert.ok(result.findings.some(finding =>
    finding.type==="SEMANTIC_VALIDATION" && /dangling reference/i.test(finding.message),
  ));
});

test("an epic candidate cannot use itself as source evidence",() => {
  const circular=clone(valid);
  circular.content.epic_candidates[0].source_entities=
    selfReferentialEpicCandidate.content.epic_candidates[0].source_entities;
  circular.content_sha256=sha256Canonical(circular.content);

  const result=validatePmAnalysis(circular);

  assert.equal(result.valid,false);
  assert.equal(result.complete,false);
  assert.ok(result.findings.some(finding =>
    finding.type==="SEMANTIC_CIRCULAR_REFERENCE" &&
      finding.path==="/content/epic_candidates/0/source_entities/0/entity_id",
  ));
});

test("PM epic candidates stay explicitly non-authoritative until PM finalization",() => {
  assert.equal(
    valid.content.epic_candidates[0].candidate_status,
    "non-authoritative",
  );

  const finalizedCandidate=clone(valid);
  finalizedCandidate.content.epic_candidates[0].candidate_status="finalized";
  finalizedCandidate.content_sha256=sha256Canonical(finalizedCandidate.content);

  assert.equal(validatePmAnalysis(finalizedCandidate).valid,false);
});

test("legitimate business text is not treated as an architecture decision",() => {
  const businessText=clone(valid);
  businessText.content.functional_requirements[0].meaning=
    "Customers can export their requests for PostgreSQL-compatible business reporting.";
  businessText.content_sha256=sha256Canonical(businessText.content);

  const result=validatePmAnalysis(businessText);

  assert.equal(result.valid,true);
  assert.equal(result.complete,true);
});

test("assumptions require impact, reversibility, and source provenance",() => {
  const result=validatePmAnalysis(missingAssumptionEvidence);

  assert.equal(result.valid,false);
  assert.ok(result.findings.some(finding =>
    finding.type==="SCHEMA_VALIDATION" &&
      /impact|provenance/.test(finding.path),
  ));
});

test("PM analysis validation fails closed for non-canonical programmatic values",() => {
  const nonCanonical=clone(valid);
  nonCanonical.content.assumptions[0].extra=undefined;

  const result=validatePmAnalysis(nonCanonical);

  assert.equal(result.valid,false);
  assert.equal(result.complete,false);
  assert.equal(result.findings[0].type,"CANONICAL_JSON");
});
