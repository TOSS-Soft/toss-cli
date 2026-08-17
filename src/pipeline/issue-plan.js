import {canonicalJson,sha256Canonical} from "../contracts/acp.js";
import {validateDocument} from "../contracts/validator.js";
import {validateArchitecture} from "./architecture.js";
import {validatePmAnalysis} from "./pm-analysis.js";

// pm-analysis.v1 has no priority field. Its functional requirements are the
// explicitly documented v1 must set until a later PM schema adds priority.
export const MUST_REQUIREMENT_POLICY="pm-analysis.v1-functional-requirements-are-must";

const BUILD_PLAN_FIELDS=new Set([
  "summary",
  "epics",
  "issues",
  "acceptance_criteria",
]);

function isPlainObject(value) {
  if (!value || typeof value!=="object" || Array.isArray(value)) return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype || prototype===null;
}

function canonicalCopy(value) {
  return JSON.parse(canonicalJson(value));
}

function deepFreeze(value) {
  if (!value || typeof value!=="object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function escapePointerSegment(value) {
  return String(value).replaceAll("~","~0").replaceAll("/","~1");
}

function freezeFinding({
  type,
  path,
  message,
  owner="PM",
  severity="P2",
  affected_entities=[],
}) {
  return Object.freeze({
    type,
    path,
    message,
    owner,
    severity,
    affected_entities:Object.freeze([...affected_entities]),
  });
}

function canonicalFinding(error) {
  return freezeFinding({
    type:"CANONICAL_JSON",
    path:"/",
    message:error instanceof Error ? error.message : "Value is not canonical JSON",
  });
}

function validationFinding(error) {
  const missing=error.keyword==="required" ? error.params?.missingProperty : undefined;
  const path=missing===undefined ? error.instancePath :
    `${error.instancePath}/${escapePointerSegment(missing)}`;
  return freezeFinding({
    type:"SCHEMA_VALIDATION",
    path:path || "/",
    message:error.message ?? "Issue plan contract shape is invalid",
  });
}

function artifactReference(artifact) {
  return {
    document_type:artifact.document_type,
    artifact_id:artifact.artifact_id,
    revision:artifact.revision,
    content_sha256:artifact.content_sha256,
  };
}

function sameArtifactReference(reference,artifact) {
  return isPlainObject(reference) && isPlainObject(artifact) &&
    reference.document_type===artifact.document_type &&
    reference.artifact_id===artifact.artifact_id &&
    reference.revision===artifact.revision &&
    reference.content_sha256===artifact.content_sha256;
}

function sameArtifactIdentity(reference,artifact) {
  return isPlainObject(reference) && isPlainObject(artifact) &&
    reference.document_type===artifact.document_type &&
    reference.artifact_id===artifact.artifact_id &&
    reference.revision===artifact.revision;
}

function referenceIdentity(reference) {
  return [
    reference.document_type,
    reference.artifact_id,
    reference.revision,
    reference.content_sha256,
  ].join("\u0000");
}

function schemaAndIntegrityFindings(artifact,schemaId) {
  const shape=validateDocument(artifact,schemaId);
  if (!shape.valid) return shape.errors.map(validationFinding);
  try {
    if (artifact.content_sha256===sha256Canonical(artifact.content)) return [];
  } catch (error) {
    return [canonicalFinding(error)];
  }
  return [freezeFinding({
    type:"CONTENT_SHA256_MISMATCH",
    path:"/content_sha256",
    message:"content_sha256 must equal the SHA-256 digest of canonical content",
  })];
}

function immutableInputError(label) {
  return new Error(
    `PM Finalization cannot change immutable ${label.toLowerCase()} input`,
  );
}

function assertExactInputSnapshots(issuePlan,pmAnalysis,architecture,adrs) {
  const snapshots=issuePlan.content.input_snapshots;
  if (!sameArtifactReference(snapshots.pm_analysis,pmAnalysis)) {
    throw immutableInputError("PM analysis");
  }
  if (!sameArtifactReference(snapshots.architecture,architecture)) {
    throw immutableInputError("architecture");
  }
  if (snapshots.adrs.length!==adrs.length) {
    throw immutableInputError("ADR");
  }
  const expected=new Map(adrs.map(adr => [referenceIdentity(artifactReference(adr)),adr]));
  const seen=new Set();
  for (const snapshot of snapshots.adrs) {
    const identity=referenceIdentity(snapshot);
    if (seen.has(identity) || !expected.has(identity)) {
      throw immutableInputError("ADR");
    }
    seen.add(identity);
  }
}

function exactInputSetFindings(issuePlan,expectedInputs) {
  const findings=[];
  const actual=Array.isArray(issuePlan.inputs) ? issuePlan.inputs : [];
  const seen=new Set();
  for (const [index,reference] of actual.entries()) {
    const identity=referenceIdentity(reference);
    if (seen.has(identity)) {
      findings.push(freezeFinding({
        type:"DUPLICATE_ARTIFACT_INPUT",
        path:`/inputs/${index}`,
        message:"Issue-plan inputs must not repeat an exact reference",
      }));
    }
    seen.add(identity);
    if (sameArtifactIdentity(reference,issuePlan)) {
      findings.push(freezeFinding({
        type:"SELF_ARTIFACT_INPUT",
        path:`/inputs/${index}`,
        message:"An issue plan must not consume itself as an input",
      }));
    }
    if (!expectedInputs.some(expected => sameArtifactReference(reference,expected.artifact))) {
      findings.push(freezeFinding({
        type:"EXTRA_ARTIFACT_INPUT",
        path:`/inputs/${index}`,
        message:"Issue-plan inputs must contain only the exact PM, architecture, and ADR inputs",
      }));
    }
  }
  for (const expected of expectedInputs) {
    if (actual.some(reference => sameArtifactReference(reference,expected.artifact))) {
      continue;
    }
    const sameIdentity=actual.some(reference => sameArtifactIdentity(reference,expected.artifact));
    findings.push(freezeFinding({
      type:sameIdentity ? `MISMATCHED_${expected.label}_INPUT` :
        `MISSING_${expected.label}_INPUT`,
      path:"/inputs",
      message:sameIdentity ?
        `${expected.label} input must have the exact document type, identity, revision, and hash` :
        `${expected.label} input is required`,
    }));
  }
  return findings;
}

function pmRequirements(pmAnalysis) {
  const content=pmAnalysis.content ?? {};
  return [
    ...(Array.isArray(content.functional_requirements) ? content.functional_requirements : []),
    ...(Array.isArray(content.non_functional_requirements) ?
      content.non_functional_requirements : []),
    ...(Array.isArray(content.constraints) ? content.constraints : []),
  ];
}

function mustRequirements(pmAnalysis) {
  return Array.isArray(pmAnalysis?.content?.functional_requirements) ?
    pmAnalysis.content.functional_requirements : [];
}

function mapById(entities) {
  return new Map(entities.map(entity => [entity.id,entity]));
}

function duplicateIdentityFindings(content) {
  const findings=[];
  for (const [collection,type] of [
    ["epics","DUPLICATE_EPIC_ID"],
    ["issues","DUPLICATE_ISSUE_ID"],
    ["acceptance_criteria","DUPLICATE_AC_ID"],
  ]) {
    const seen=new Set();
    for (const [index,entity] of content[collection].entries()) {
      if (seen.has(entity.id)) {
        findings.push(freezeFinding({
          type,
          path:`/content/${collection}/${index}/id`,
          message:`${collection} identity ${entity.id} is duplicated`,
          affected_entities:[entity.id],
        }));
      }
      seen.add(entity.id);
    }
  }
  return findings;
}

function finalEpicCandidateFindings(pmAnalysis,epics) {
  const candidates=new Map((pmAnalysis?.content?.epic_candidates ?? []).map(candidate => [
    candidate.id,
    candidate,
  ]));
  const findings=[];
  for (const [index,epic] of epics.entries()) {
    const candidate=candidates.get(epic.id);
    if (!candidate) continue;
    if (canonicalJson({kind:candidate.kind,meaning:candidate.meaning})===
        canonicalJson({kind:epic.kind,meaning:epic.meaning})) {
      continue;
    }
    findings.push(freezeFinding({
      type:"EPIC_CANDIDATE_MEANING_CONFLICT",
      path:`/content/epics/${index}/meaning`,
      message:`Authoritative epic ${epic.id} must retain the PM candidate's kind and meaning or use a new identity`,
      affected_entities:[epic.id],
    }));
  }
  return findings;
}

function assertRequirementReference(reference,requirements,path) {
  if (!requirements.has(reference.id)) {
    throw new Error(`Dangling requirement reference ${reference.id} at ${path}`);
  }
}

function assertEntityReference(reference,entities,kind,path) {
  if (reference.kind!==kind || !entities.has(reference.id)) {
    throw new Error(`Dangling ${kind} reference ${reference.id} at ${path}`);
  }
}

function requiredApprovedAdrs(issue,adrs) {
  const sourceRequirementIds=new Set((issue.source_requirements ?? []).map(
    reference => reference.id,
  ));
  const required=new Map();
  for (const adr of adrs) {
    const content=adr?.content;
    if (!isPlainObject(content) || content.status!=="accepted" ||
        content.approval?.state!=="approved" ||
        !Array.isArray(content.affected_requirements)) {
      continue;
    }
    if (content.affected_requirements.some(id => sourceRequirementIds.has(id))) {
      required.set(content.id,content);
    }
  }
  return required;
}

function issueAdrTraceabilityFindings(issue,issueIndex,adrs) {
  const findings=[];
  const required=requiredApprovedAdrs(issue,adrs);
  const declaredIds=new Set(issue.adr_refs.map(reference => reference.id));
  const basePath=`/content/issues/${issueIndex}`;

  if (required.size>0 && !issue.requires_adr) {
    findings.push(freezeFinding({
      type:"ISSUE_ADR_REQUIRED",
      path:`${basePath}/requires_adr`,
      message:`Issue ${issue.id} has source requirements affected by accepted and approved ADRs`,
      affected_entities:[issue.id,...required.keys()],
    }));
  }
  if (required.size===0 && issue.requires_adr) {
    findings.push(freezeFinding({
      type:"ISSUE_ADR_NOT_REQUIRED",
      path:`${basePath}/requires_adr`,
      message:`Issue ${issue.id} has no source requirement affected by an accepted and approved ADR`,
      affected_entities:[issue.id],
    }));
  }
  for (const [adrId] of required) {
    if (declaredIds.has(adrId)) continue;
    findings.push(freezeFinding({
      type:"ISSUE_ADR_MISSING_RELEVANT",
      path:`${basePath}/adr_refs`,
      message:`Issue ${issue.id} must reference relevant accepted and approved ADR ${adrId}`,
      affected_entities:[issue.id,adrId],
    }));
  }
  for (const [referenceIndex,reference] of issue.adr_refs.entries()) {
    if (required.has(reference.id)) continue;
    findings.push(freezeFinding({
      type:"ISSUE_ADR_UNRELATED",
      path:`${basePath}/adr_refs/${referenceIndex}`,
      message:`Issue ${issue.id} may reference only accepted and approved ADRs relevant to its source requirements`,
      affected_entities:[issue.id,reference.id],
    }));
  }
  return findings;
}

function dependencyCycle(issues) {
  const visiting=new Set();
  const visited=new Set();

  function visit(issue) {
    if (visiting.has(issue.id)) {
      throw new Error(`Dependency cycle detected at ${issue.id}`);
    }
    if (visited.has(issue.id)) return;
    visiting.add(issue.id);
    for (const dependency of issue.dependencies) {
      if (dependency.id===issue.id) {
        throw new Error(`Issue ${issue.id} has a self dependency`);
      }
      visit(issues.get(dependency.id));
    }
    visiting.delete(issue.id);
    visited.add(issue.id);
  }

  for (const issue of issues.values()) visit(issue);
}

function semanticFindings({pmAnalysis,adrs,issuePlan}) {
  const content=issuePlan.content;
  const findings=[
    ...duplicateIdentityFindings(content),
    ...finalEpicCandidateFindings(pmAnalysis,content.epics),
  ];
  const requirements=mapById(pmRequirements(pmAnalysis));
  const epics=mapById(content.epics);
  const issues=mapById(content.issues);
  const criteria=mapById(content.acceptance_criteria);
  const adrById=mapById(adrs.map(adr => adr.content));

  for (const [index,epic] of content.epics.entries()) {
    for (const [referenceIndex,reference] of epic.source_requirements.entries()) {
      assertRequirementReference(
        reference,
        requirements,
        `/content/epics/${index}/source_requirements/${referenceIndex}`,
      );
    }
  }

  for (const [index,issue] of content.issues.entries()) {
    if (issue.epic) {
      assertEntityReference(issue.epic,epics,"epic",`/content/issues/${index}/epic`);
    }
    for (const [referenceIndex,reference] of (issue.source_requirements ?? []).entries()) {
      assertRequirementReference(
        reference,
        requirements,
        `/content/issues/${index}/source_requirements/${referenceIndex}`,
      );
    }
    for (const [referenceIndex,reference] of issue.acceptance_criteria.entries()) {
      assertEntityReference(
        reference,
        criteria,
        "acceptance-criterion",
        `/content/issues/${index}/acceptance_criteria/${referenceIndex}`,
      );
      const criterion=criteria.get(reference.id);
      if (criterion.issue.id!==issue.id) {
        findings.push(freezeFinding({
          type:"AC_ISSUE_LINK_MISMATCH",
          path:`/content/issues/${index}/acceptance_criteria/${referenceIndex}`,
          message:`Acceptance criterion ${criterion.id} must belong to issue ${issue.id}`,
          affected_entities:[issue.id,criterion.id],
        }));
      }
    }
    for (const [referenceIndex,reference] of issue.adr_refs.entries()) {
      assertEntityReference(reference,adrById,"adr",`/content/issues/${index}/adr_refs/${referenceIndex}`);
      const adr=adrById.get(reference.id);
      if (adr.status!=="accepted" || adr.approval.state!=="approved") {
        findings.push(freezeFinding({
          type:"ISSUE_ADR_NOT_APPROVED",
          path:`/content/issues/${index}/adr_refs/${referenceIndex}`,
          message:`Issue ${issue.id} requires an accepted and approved ADR ${adr.id}`,
          affected_entities:[issue.id,adr.id],
        }));
      }
    }
    findings.push(...issueAdrTraceabilityFindings(issue,index,adrs));
    for (const [referenceIndex,reference] of issue.dependencies.entries()) {
      assertEntityReference(reference,issues,"issue",`/content/issues/${index}/dependencies/${referenceIndex}`);
    }
  }

  for (const [index,criterion] of content.acceptance_criteria.entries()) {
    assertEntityReference(criterion.issue,issues,"issue",`/content/acceptance_criteria/${index}/issue`);
    const issue=issues.get(criterion.issue.id);
    if (!issue.acceptance_criteria.some(reference => reference.id===criterion.id)) {
      findings.push(freezeFinding({
        type:"AC_ISSUE_LINK_MISMATCH",
        path:`/content/acceptance_criteria/${index}/issue`,
        message:`Acceptance criterion ${criterion.id} must be declared by issue ${issue.id}`,
        affected_entities:[issue.id,criterion.id],
      }));
    }
    for (const [referenceIndex,reference] of criterion.verifies.entries()) {
      assertRequirementReference(
        reference,
        requirements,
        `/content/acceptance_criteria/${index}/verifies/${referenceIndex}`,
      );
    }
  }

  dependencyCycle(issues);
  return findings;
}

function calculateCoverage(pmAnalysis,acceptanceCriteria) {
  const mustIds=new Set(mustRequirements(pmAnalysis).map(requirement => requirement.id));
  const covered=new Set();
  const criteria=Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [];
  for (const criterion of criteria) {
    if (!isPlainObject(criterion) || !Array.isArray(criterion.verifies)) continue;
    for (const reference of criterion.verifies) {
      if (!isPlainObject(reference)) continue;
      if (mustIds.has(reference.id)) covered.add(reference.id);
    }
  }
  const uncovered=[...mustIds].filter(id => !covered.has(id)).sort();
  return Object.freeze({
    must_requirement_policy:MUST_REQUIREMENT_POLICY,
    must_requirements:mustIds.size,
    covered_must_requirements:covered.size,
    uncovered_must_requirement_ids:Object.freeze(uncovered),
    ready:uncovered.length===0,
  });
}

function coverageFindings(issuePlan,coverage,hasIntegrity) {
  const findings=[];
  for (const id of coverage.uncovered_must_requirement_ids) {
    findings.push(freezeFinding({
      type:"MUST_REQUIREMENT_UNCOVERED",
      path:"/content/acceptance_criteria",
      message:`Must requirement ${id} is not verified by an acceptance criterion; ${MUST_REQUIREMENT_POLICY} treats every pm-analysis.v1 functional requirement as must`,
      affected_entities:[id],
    }));
  }
  const summaryMatches=canonicalJson(issuePlan.content.coverage)===canonicalJson(coverage);
  if (!summaryMatches) {
    findings.push(freezeFinding({
      type:"COVERAGE_SUMMARY_MISMATCH",
      path:"/content/coverage",
      message:"Issue-plan coverage is computed from acceptance criteria and cannot be trusted from input",
    }));
  }
  const expectedStatus=hasIntegrity && summaryMatches && coverage.ready ?
    "ready-for-issues" : "blocked";
  if (issuePlan.content.status!==expectedStatus) {
    findings.push(freezeFinding({
      type:"STATUS_READINESS_MISMATCH",
      path:"/content/status",
      message:`Issue-plan status must be ${expectedStatus} for computed integrity and must coverage`,
    }));
  }
  return findings;
}

function upstreamFindings(pmAnalysis,architecture,adrs) {
  const findings=[];
  const pmResult=validatePmAnalysis(pmAnalysis);
  if (!pmResult.valid) {
    findings.push(...pmResult.findings.map(finding => freezeFinding({
      type:`PM_ANALYSIS_${finding.type}`,
      path:finding.path,
      message:finding.message,
      affected_entities:finding.affected_entities,
    })));
    return findings;
  }
  let architectureResult;
  try {
    architectureResult=validateArchitecture({pmAnalysis,architecture,adrs});
  } catch (error) {
    findings.push(freezeFinding({
      type:"UPSTREAM_ARCHITECTURE_INTEGRITY",
      path:"/architecture",
      message:error instanceof Error ? error.message : "Architecture input is invalid",
    }));
    return findings;
  }
  if (!architectureResult.valid) {
    findings.push(...architectureResult.findings.map(finding => freezeFinding({
      type:`ARCHITECTURE_${finding.type}`,
      path:finding.path,
      message:finding.message,
      affected_entities:finding.affected_entities,
    })));
  }
  if (architectureResult.valid && !architectureResult.complete) {
    findings.push(freezeFinding({
      type:"UPSTREAM_ARCHITECTURE_NOT_READY",
      path:"/architecture",
      message:"PM finalization requires a complete approved architecture and ADR set",
    }));
  }
  return findings;
}

function resultFor({findings=[],coverage}={}) {
  const frozenFindings=Object.freeze([...findings]);
  const valid=frozenFindings.length===0;
  const ready_for_issues=valid && coverage.ready;
  return Object.freeze({
    valid,
    complete:ready_for_issues,
    ready_for_issues,
    coverage,
    findings:frozenFindings,
  });
}

function assertBuildArguments(pmAnalysis,architecture,adrs,plan,artifactContext) {
  if (!isPlainObject(plan)) {
    throw new TypeError("Issue plan must be an object");
  }
  for (const key of Object.keys(plan)) {
    if (!BUILD_PLAN_FIELDS.has(key)) {
      throw new TypeError(`Issue plan contains unsupported field ${key}`);
    }
  }
  for (const key of BUILD_PLAN_FIELDS) {
    if (!Object.hasOwn(plan,key)) {
      throw new TypeError(`Issue plan requires ${key}`);
    }
  }
  if (!isPlainObject(artifactContext)) {
    throw new TypeError("Issue-plan artifactContext must be an object");
  }
  if (artifactContext.producer?.role!=="pm-finalization") {
    throw new TypeError("Issue-plan artifactContext producer must be pm-finalization");
  }
  if (!Array.isArray(artifactContext.parents)) {
    throw new TypeError("Issue-plan artifactContext parents must be an array");
  }
  if (!Array.isArray(adrs) || adrs.length===0) {
    throw new TypeError("Issue plan requires at least one ADR input");
  }
  const pmResult=validatePmAnalysis(pmAnalysis);
  if (!pmResult.valid) {
    throw new TypeError("Cannot build issue plan from invalid PM analysis");
  }
  const architectureResult=validateArchitecture({pmAnalysis,architecture,adrs});
  if (!architectureResult.valid || !architectureResult.complete) {
    throw new TypeError("Cannot build issue plan from incomplete architecture inputs");
  }
}

export function buildIssuePlan({
  pmAnalysis,
  architecture,
  adrs,
  plan,
  artifactContext,
}={}) {
  let normalized;
  try {
    normalized=canonicalCopy({pmAnalysis,architecture,adrs,plan,artifactContext});
  } catch (error) {
    throw new TypeError(
      `Cannot build issue plan from non-canonical inputs: ${
        error instanceof Error ? error.message : "invalid input"
      }`,
      {cause:error},
    );
  }
  const {
    pmAnalysis:pm,
    architecture:architectureArtifact,
    adrs:adrArtifacts,
    plan:planInput,
    artifactContext:context,
  }=normalized;
  assertBuildArguments(pm,architectureArtifact,adrArtifacts,planInput,context);

  const snapshots={
    pm_analysis:artifactReference(pm),
    architecture:artifactReference(architectureArtifact),
    adrs:adrArtifacts.map(artifactReference),
  };
  const coverage=calculateCoverage(pm,planInput.acceptance_criteria);
  const content={
    ...planInput,
    input_snapshots:snapshots,
    coverage,
    status:coverage.ready ? "ready-for-issues" : "blocked",
  };
  const issuePlan={
    schema_version:"acp.v1",
    document_type:"issue-plan",
    artifact_id:context.artifact_id,
    revision:context.revision,
    run_id:context.run_id,
    producer:context.producer,
    runtime_identity:context.runtime_identity,
    created_at:context.created_at,
    provenance:context.provenance,
    parents:context.parents,
    inputs:[
      artifactReference(pm),
      artifactReference(architectureArtifact),
      ...adrArtifacts.map(artifactReference),
    ],
    content_sha256:sha256Canonical(content),
    content,
  };
  let result;
  try {
    result=validateIssuePlan({
      pmAnalysis:pm,
      architecture:architectureArtifact,
      adrs:adrArtifacts,
      issuePlan,
    });
  } catch (error) {
    throw new TypeError(
      `Cannot build invalid issue plan: ${
        error instanceof Error ? error.message : "invalid inputs"
      }`,
      {cause:error},
    );
  }
  if (!result.valid) {
    throw new TypeError(`Cannot build invalid issue plan: ${result.findings.map(finding =>
      `${finding.type} at ${finding.path}`,
    ).join("; ")}`);
  }
  return deepFreeze(issuePlan);
}

export function validateIssuePlan(graph={}) {
  let normalized;
  try {
    normalized=canonicalCopy(graph);
  } catch (error) {
    const coverage=Object.freeze({
      must_requirement_policy:MUST_REQUIREMENT_POLICY,
      must_requirements:0,
      covered_must_requirements:0,
      uncovered_must_requirement_ids:Object.freeze([]),
      ready:false,
    });
    return resultFor({findings:[canonicalFinding(error)],coverage});
  }
  const {
    pmAnalysis,
    architecture,
    adrs,
    issuePlan,
  }=normalized;
  const issuePlanFindings=schemaAndIntegrityFindings(issuePlan,"issue-plan.v1");
  const coverage=calculateCoverage(pmAnalysis ?? {},issuePlan?.content?.acceptance_criteria ?? []);
  if (issuePlanFindings.length>0) {
    return resultFor({findings:issuePlanFindings,coverage});
  }
  if (!Array.isArray(adrs)) {
    return resultFor({
      findings:[freezeFinding({
        type:"ADRS_NOT_ARRAY",
        path:"/adrs",
        message:"ADRs must be an array",
      })],
      coverage,
    });
  }

  assertExactInputSnapshots(issuePlan,pmAnalysis,architecture,adrs);
  const findings=[
    ...exactInputSetFindings(
      issuePlan,
      [
        {artifact:pmAnalysis,label:"PM"},
        {artifact:architecture,label:"ARCHITECTURE"},
        ...adrs.map(adr => ({artifact:adr,label:"ADR"})),
      ],
    ),
    ...upstreamFindings(pmAnalysis,architecture,adrs),
  ];
  const hasInputIntegrity=findings.length===0;
  findings.push(...semanticFindings({pmAnalysis,adrs,issuePlan}));
  findings.push(...coverageFindings(
    issuePlan,
    coverage,
    hasInputIntegrity && findings.length===0,
  ));
  return resultFor({findings,coverage});
}
