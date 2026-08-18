import fs from "node:fs";

import {canonicalJson,sha256Canonical} from "../contracts/acp.js";
import {validateDocument} from "../contracts/validator.js";
import {validateArchitecture} from "./architecture.js";
import {evaluateDecisionGate} from "./decisions.js";
import {validateIssuePlan} from "./issue-plan.js";
import {validatePmAnalysis} from "./pm-analysis.js";
import {auditSpecification} from "./spec-auditor.js";
import {transition} from "./state-machine.js";
import {buildTraceGraph,calculateRequirementCoverage} from "./traceability.js";

const RULES=JSON.parse(fs.readFileSync(new URL(
  "../../contracts/pipeline/pdor-rules.v1.json",
  import.meta.url,
),"utf8"));
const RULE_IDS=Object.freeze(RULES.rules.map(rule => rule.id));
const RULE_BY_ID=new Map(RULES.rules.map(rule => [rule.id,rule]));
const DECISION_RULE_ID="PDOR-040-BLOCKING-DECISIONS";
const DECISION_POLICY=RULE_BY_ID.get(DECISION_RULE_ID)?.policy;
const SUPPLIED_PACKAGE_REQUIREMENTS=Object.freeze([
  "external-authority-verification",
  "exact-cover-all-pm-questions",
  "exact-retained-pm-fields",
]);
const ALLOWED_AGGREGATE_KEYS=Object.freeze([
  "analysisState",
  "adrApprovals",
  "architecture",
  "decisionAnswers",
  "decisionPackage",
  "issuePlan",
  "pmAnalysis",
  "specAudits",
  "traceGraph",
]);
const REQUIRED_AGGREGATE_KEYS=ALLOWED_AGGREGATE_KEYS.filter(
  key => !["adrApprovals","decisionAnswers","decisionPackage"].includes(key),
);
const BLOCKING_SEVERITIES=new Set(DECISION_POLICY?.blocking_severities ?? []);
const ASSUMPTION_SEVERITIES=new Set(DECISION_POLICY?.warning_severities ?? []);
const SHA256_PATTERN=/^[a-f0-9]{64}$/;
const PM_QUESTION_FIELDS=Object.freeze([
  "meaning",
  "question",
  "severity",
  "owner",
  "options",
  "recommendation",
  "rationale",
  "affected_entities",
  "provenance",
]);

const RULES_ARE_CLOSED=RULES.rules.every(rule => canonicalJson(Object.keys(rule).sort())===
  canonicalJson(rule.id===DECISION_RULE_ID ?
    ["description","id","policy","severity"] : ["description","id","severity"]));
const DECISION_POLICY_IS_CLOSED=isPlainObject(DECISION_POLICY) &&
  canonicalJson(Object.keys(DECISION_POLICY).sort())===canonicalJson([
    "blocking_severities",
    "package_required_when",
    "supplied_package_requires",
    "warning_severities",
  ]) &&
  canonicalJson(DECISION_POLICY.blocking_severities)===canonicalJson(["P0","P1","P2"]) &&
  canonicalJson(DECISION_POLICY.warning_severities)===canonicalJson(["P3","P4"]) &&
  DECISION_POLICY.package_required_when==="blocking-question-present" &&
  canonicalJson(DECISION_POLICY.supplied_package_requires)===
    canonicalJson(SUPPLIED_PACKAGE_REQUIREMENTS);

if (canonicalJson(Object.keys(RULES).sort())!==canonicalJson([
  "document_type","rules","schema_version",
]) ||
    RULES.schema_version!=="pdor-rules.v1" ||
    RULES.document_type!=="pdor-rules" ||
    canonicalJson(RULE_IDS)!==canonicalJson([...RULE_IDS].sort()) ||
    new Set(RULE_IDS).size!==RULE_IDS.length ||
    !RULES_ARE_CLOSED || !DECISION_POLICY_IS_CLOSED) {
  throw new Error(
    "PDoR rules must be closed, versioned, unique, ordered, and carry the decision policy",
  );
}

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

function exactReference(artifact) {
  if (!isPlainObject(artifact) ||
      typeof artifact.document_type!=="string" ||
      typeof artifact.artifact_id!=="string" ||
      !Number.isSafeInteger(artifact.revision) || artifact.revision<1 ||
      typeof artifact.content_sha256!=="string") return undefined;
  return {
    document_type:artifact.document_type,
    artifact_id:artifact.artifact_id,
    revision:artifact.revision,
    content_sha256:artifact.content_sha256,
  };
}

function artifactLabel(key,artifact) {
  const reference=exactReference(artifact);
  if (!reference) return key;
  return `${key}:${reference.document_type}:${reference.artifact_id}@${reference.revision}#${reference.content_sha256}`;
}

function evidence(key,artifact,path,message,entityId=null) {
  return {
    artifact:artifactLabel(key,artifact),
    entity_id:entityId,
    path:path.startsWith("/") ? path : `/${path}`,
    message,
  };
}

function ruleResult(ruleId,items) {
  return {
    rule_id:ruleId,
    message:RULE_BY_ID.get(ruleId).description,
    evidence:items,
  };
}

function canonicalEvidenceItems(items) {
  const byCanonical=new Map(items.map(item => [canonicalJson(item),item]));
  return [...byCanonical.keys()].sort().map(key => byCanonical.get(key));
}

function recordDependencyEvidence(context,key,items) {
  const existing=context.dependencyEvidence.get(key) ?? [];
  context.dependencyEvidence.set(
    key,canonicalEvidenceItems([...existing,...items]),
  );
}

function sourceOf(input) {
  const revision=input?.pmAnalysis?.provenance?.source_revision;
  const sha256=input?.pmAnalysis?.provenance?.source_sha256;
  return {
    source_revision:typeof revision==="string" && revision.length>0 ? revision : null,
    source_sha256:typeof sha256==="string" && SHA256_PATTERN.test(sha256) ? sha256 : null,
  };
}

function boundaryFailure(message,path="/") {
  const result={
    schema_version:"pdor-result.v1",
    document_type:"pdor-result",
    rules_version:RULES.schema_version,
    source_revision:null,
    source_sha256:null,
    ready_for_issue_generation:false,
    coverage:{requirement_ac:0},
    failures:[ruleResult("PDOR-001-ARTIFACT-INTEGRITY",[
      evidence("pipeline-input",undefined,path,message),
    ])],
    warnings:[],
  };
  return deepFreeze(result);
}

function pointerSegments(path) {
  if (typeof path!=="string" || path==="" || path==="/") return [];
  return path.slice(1).split("/").map(segment =>
    segment.replaceAll("~1","/").replaceAll("~0","~"));
}

function safeEntityIdAtPath(artifact,path) {
  let current=artifact;
  let entityId=null;
  for (const segment of pointerSegments(path)) {
    if (isPlainObject(current) && typeof current.id==="string") entityId=current.id;
    if ((!isPlainObject(current) && !Array.isArray(current)) ||
        !Object.hasOwn(current,segment)) break;
    current=current[segment];
  }
  if (isPlainObject(current) && typeof current.id==="string") entityId=current.id;
  return entityId;
}

function validationEvidence(key,artifact,schemaId,pathPrefix="",{contentHash=true}={}) {
  const schemaItems=[];
  const validation=validateDocument(artifact,schemaId);
  for (const error of validation.errors) {
    const missing=error.keyword==="required" ? error.params?.missingProperty : undefined;
    const path=missing===undefined ? error.instancePath :
      `${error.instancePath}/${String(missing).replaceAll("~","~0").replaceAll("/","~1")}`;
    schemaItems.push(evidence(
      key,
      artifact,
      `${pathPrefix}${path || "/"}`,
      error.message ?? `${key} does not satisfy ${schemaId}`,
      safeEntityIdAtPath(artifact,path),
    ));
  }
  const items=[...schemaItems];
  if (contentHash && validation.valid &&
      artifact.content_sha256!==sha256Canonical(artifact.content)) {
    items.push(evidence(
      key,
      artifact,
      `${pathPrefix}/content_sha256`,
      "content_sha256 does not match canonical content",
    ));
  }
  return {items,schemaItems};
}

function exactSourceEvidence(key,artifact,source,path="/provenance") {
  if (artifact?.provenance?.source_revision===source.source_revision &&
      artifact?.provenance?.source_sha256===source.source_sha256) return [];
  return [evidence(
    key,
    artifact,
    path,
    "Artifact is not bound to the exact current source revision and digest",
  )];
}

function identityEvidence(artifacts) {
  const items=[];
  const seen=new Set();
  for (const {key,artifact,path} of artifacts) {
    const reference=exactReference(artifact);
    if (!reference) continue;
    const identity=`${reference.document_type}\u0000${reference.artifact_id}\u0000${reference.revision}`;
    if (seen.has(identity)) {
      items.push(evidence(
        key,
        artifact,
        path,
        `Duplicate artifact identity ${reference.artifact_id}@${reference.revision}`,
      ));
    }
    seen.add(identity);
  }
  return items;
}

function artifactEntries(input) {
  const entries=[
    {key:"pmAnalysis",artifact:input.pmAnalysis,path:"/pmAnalysis"},
    {key:"architecture.artifact",artifact:input.architecture?.artifact,path:"/architecture/artifact"},
    ...(Array.isArray(input.architecture?.adrs) ? input.architecture.adrs.map((artifact,index) => ({
      key:`architecture.adrs[${index}]`,
      artifact,
      path:`/architecture/adrs/${index}`,
    })) : []),
    ...(Array.isArray(input.adrApprovals) ? input.adrApprovals.map((artifact,index) => ({
      key:`adrApprovals[${index}]`,artifact,path:`/adrApprovals/${index}`,
    })) : []),
    ...(Array.isArray(input.decisionAnswers) ? input.decisionAnswers.map((artifact,index) => ({
      key:`decisionAnswers[${index}]`,artifact,path:`/decisionAnswers/${index}`,
    })) : []),
    {key:"issuePlan",artifact:input.issuePlan,path:"/issuePlan"},
    ...(Array.isArray(input.specAudits) ? input.specAudits.map((artifact,index) => ({
      key:`specAudits[${index}]`,
      artifact,
      path:`/specAudits/${index}`,
    })) : []),
    {key:"analysisState",artifact:input.analysisState,path:"/analysisState"},
  ];
  return entries;
}

function integrityRule(context) {
  const {input}=context;
  const items=[];
  context.dependencyEvidence=new Map();
  if (!isPlainObject(input)) {
    return [evidence("pipeline-input",undefined,"/","Artifact aggregate must be a plain object")];
  }
  for (const key of Object.keys(input).sort()) {
    if (!ALLOWED_AGGREGATE_KEYS.includes(key)) {
      items.push(evidence("pipeline-input",undefined,`/${key}`,`Unknown aggregate field ${key}`));
    }
  }
  for (const key of REQUIRED_AGGREGATE_KEYS) {
    if (!Object.hasOwn(input,key)) {
      items.push(evidence("pipeline-input",undefined,`/${key}`,`Missing current pipeline artifact ${key}`));
    }
  }
  if (!isPlainObject(input.architecture)) {
    items.push(evidence("architecture",undefined,"/architecture","Architecture aggregate must be an object"));
  }
  if (!Array.isArray(input.architecture?.adrs) || input.architecture.adrs.length===0) {
    const structural=[evidence(
      "architecture.adrs",undefined,"/architecture/adrs","ADRs must be a non-empty array",
    )];
    items.push(...structural);
    recordDependencyEvidence(context,"architecture.adrs",structural);
  }
  if (!Array.isArray(input.specAudits) || input.specAudits.length===0) {
    const structural=[evidence(
      "specAudits",undefined,"/specAudits","Spec Audits must be a non-empty array",
    )];
    items.push(...structural);
    recordDependencyEvidence(context,"specAudits",structural);
  }

  const contracts=[
    ["pmAnalysis",input.pmAnalysis,"pm-analysis.v1","/pmAnalysis",true],
    ["architecture.artifact",input.architecture?.artifact,"architecture.v1","/architecture/artifact",true],
    ...(Array.isArray(input.architecture?.adrs) ? input.architecture.adrs.map((adr,index) => [
      `architecture.adrs[${index}]`,adr,"adr.v1",`/architecture/adrs/${index}`,true,
    ]) : []),
    ...(Array.isArray(input.adrApprovals) ? input.adrApprovals.map((approval,index) => [
      `adrApprovals[${index}]`,approval,"adr-approval.v1",`/adrApprovals/${index}`,true,
    ]) : []),
    ...(Array.isArray(input.decisionAnswers) ? input.decisionAnswers.map((answer,index) => [
      `decisionAnswers[${index}]`,answer,"decision-answer.v1",`/decisionAnswers/${index}`,true,
    ]) : []),
    ["issuePlan",input.issuePlan,"issue-plan.v1","/issuePlan",true],
    ...(Array.isArray(input.specAudits) ? input.specAudits.map((audit,index) => [
      `specAudits[${index}]`,audit,"spec-audit.v1",`/specAudits/${index}`,true,
    ]) : []),
    ["analysisState",input.analysisState,"transition-event.v1","/analysisState",true],
    ...(Object.hasOwn(input,"decisionPackage") ? [[
      "decisionPackage",input.decisionPackage,"decision-package.v1","/decisionPackage",false,
    ]] : []),
  ];
  for (const [key,artifact,schemaId,path,contentHash] of contracts) {
    try {
      const result=validationEvidence(key,artifact,schemaId,path,{contentHash});
      recordDependencyEvidence(context,key,result.schemaItems);
      items.push(...result.items);
    } catch (error) {
      const fallback=[evidence(key,artifact,path,error.message)];
      recordDependencyEvidence(context,key,fallback);
      items.push(...fallback);
    }
  }
  try {
    const result=validationEvidence(
      "traceGraph",input.traceGraph,"trace-graph.v1","/traceGraph",{contentHash:false},
    );
    recordDependencyEvidence(context,"traceGraph",result.schemaItems);
    items.push(...result.items);
  } catch (error) {
    const fallback=[evidence("traceGraph",undefined,"/traceGraph",error.message)];
    recordDependencyEvidence(context,"traceGraph",fallback);
    items.push(...fallback);
  }

  const source=sourceOf(input);
  if (source.source_revision===null || source.source_sha256===null) {
    items.push(evidence(
      "pmAnalysis",
      input.pmAnalysis,
      "/pmAnalysis/provenance",
      "PM analysis must establish an exact source revision and digest",
    ));
  } else {
    for (const entry of artifactEntries(input)) {
      items.push(...exactSourceEvidence(entry.key,entry.artifact,source,`${entry.path}/provenance`));
    }
  }
  items.push(...identityEvidence(artifactEntries(input)));

  try {
    const pmResult=validatePmAnalysis(input.pmAnalysis);
    for (const finding of pmResult.findings) {
      items.push(evidence(
        "pmAnalysis",
        input.pmAnalysis,
        `/pmAnalysis${finding.path}`,
        finding.message,
        finding.affected_entities?.[0] ?? null,
      ));
    }
  } catch (error) {
    items.push(evidence("pmAnalysis",input.pmAnalysis,"/pmAnalysis",error.message));
  }
  try {
    const architectureResult=validateArchitecture({
      pmAnalysis:input.pmAnalysis,
      architecture:input.architecture?.artifact,
      adrs:input.architecture?.adrs,
      approvals:input.adrApprovals,
      decisionPackage:input.decisionPackage,
    });
    if (!architectureResult.valid) {
      for (const finding of architectureResult.findings) {
        items.push(evidence(
          "architecture",
          input.architecture?.artifact,
          `/architecture${finding.path}`,
          finding.message,
          finding.affected_entities?.[0] ?? null,
        ));
      }
    }
  } catch (error) {
    items.push(evidence("architecture",input.architecture?.artifact,"/architecture",error.message));
  }
  try {
    const issueResult=validateIssuePlan({
      pmAnalysis:input.pmAnalysis,
      architecture:input.architecture?.artifact,
      adrs:input.architecture?.adrs,
      ...(input.adrApprovals===undefined ? {} : {approvals:input.adrApprovals}),
      ...(input.decisionPackage===undefined ? {} : {
        decisionPackage:input.decisionPackage,
      }),
      issuePlan:input.issuePlan,
    });
    for (const finding of issueResult.findings) {
      items.push(evidence(
        "issuePlan",
        input.issuePlan,
        `/issuePlan${finding.path}`,
        finding.message,
        finding.affected_entities?.[0] ?? null,
      ));
    }
  } catch (error) {
    items.push(evidence("issuePlan",input.issuePlan,"/issuePlan",error.message));
  }
  try {
    const rebuilt=buildTraceGraph({
      pmAnalysis:input.pmAnalysis,
      architecture:input.architecture,
      ...(input.adrApprovals===undefined ? {} : {approvals:input.adrApprovals}),
      ...(input.decisionPackage===undefined ? {} : {
        decisionPackage:input.decisionPackage,
      }),
      ...(input.decisionAnswers===undefined ? {} : {
        decisionAnswers:input.decisionAnswers,
      }),
      issuePlan:input.issuePlan,
    });
    context.rebuiltTraceGraph=rebuilt;
    if (canonicalJson(rebuilt)!==canonicalJson(input.traceGraph)) {
      items.push(evidence(
        "traceGraph",
        undefined,
        "/traceGraph",
        "Supplied trace graph differs from the graph rebuilt from authoritative artifacts",
      ));
    }
  } catch (error) {
    items.push(evidence(
      "traceGraph",
      undefined,
      "/traceGraph",
      `Trace graph cannot be rebuilt from authoritative artifacts: ${error.message}`,
    ));
  }
  return items;
}

function requiredSection(input,section,ruleId) {
  const value=input.pmAnalysis?.content?.[section];
  const complete=typeof value==="string" ? value.trim().length>0 :
    Array.isArray(value) && value.length>0;
  if (complete) return [];
  return [evidence(
    "pmAnalysis",
    input.pmAnalysis,
    `/pmAnalysis/content/${section}`,
    `${ruleId} requires a non-empty ${section} section`,
  )];
}

function arrayShapeEvidence(value,key,artifact,path,label) {
  return Array.isArray(value) ? [] : [evidence(
    key,artifact,path,`${label} must be an array`,
  )];
}

function projectFramingRule({input}) {
  return ["goals","summary","non_goals"].flatMap(section =>
    requiredSection(input,section,"Project framing"));
}

function productDefinitionRule({input}) {
  return [
    "actors","functional_requirements","non_functional_requirements","business_rules",
  ].flatMap(section => requiredSection(input,section,"Product definition"));
}

function systemContextRule({input}) {
  return ["domains_modules","user_flows","integrations","constraints"].flatMap(section =>
    requiredSection(input,section,"System context"));
}

function exactDecisionCoverage(pmAnalysis,decisionPackage) {
  const questions=pmAnalysis?.content?.open_questions ?? [];
  const byId=new Map(questions.map((question,index) => [question.id,{question,index}]));
  const seen=new Set();
  const items=[];
  for (const [questionIndex,question] of (decisionPackage?.questions ?? []).entries()) {
    for (const [evidenceIndex,retained] of (question.evidence ?? []).entries()) {
      const source=byId.get(retained?.source_id);
      const path=`/decisionPackage/questions/${questionIndex}/evidence/${evidenceIndex}`;
      if (!source) {
        items.push(evidence(
          "decisionPackage",
          undefined,
          path,
          `Decision evidence references unknown PM question ${String(retained?.source_id)}`,
          retained?.source_id ?? null,
        ));
        continue;
      }
      if (seen.has(retained.source_id)) {
        items.push(evidence(
          "decisionPackage",
          undefined,
          path,
          `Decision evidence duplicates PM question ${retained.source_id}`,
          retained.source_id,
        ));
      }
      seen.add(retained.source_id);
      for (const field of PM_QUESTION_FIELDS) {
        if (!Object.hasOwn(retained,field)) {
          items.push(evidence(
            "decisionPackage",
            undefined,
            `${path}/${field}`,
            `Decision evidence omits PM-owned ${field}`,
            retained.source_id,
          ));
          continue;
        }
        if (canonicalJson(retained[field])!==canonicalJson(source.question[field])) {
          items.push(evidence(
            "decisionPackage",
            undefined,
            `${path}/${field}`,
            `Decision evidence does not preserve PM-owned ${field}`,
            retained.source_id,
          ));
        }
      }
    }
  }
  for (const {question,index} of byId.values()) {
    if (!seen.has(question.id)) {
      items.push(evidence(
        "pmAnalysis",
        pmAnalysis,
        `/pmAnalysis/content/open_questions/${index}`,
        `Decision package does not exact-cover PM question ${question.id}`,
        question.id,
      ));
    }
  }
  return items;
}

function evaluateDecisions(context) {
  if (context.decisionEvaluation!==undefined) return context.decisionEvaluation;
  const questions=context.input.pmAnalysis?.content?.open_questions;
  if (!Array.isArray(questions)) {
    const result={
      items:arrayShapeEvidence(
        questions,"pmAnalysis",context.input.pmAnalysis,
        "/pmAnalysis/content/open_questions","PM open questions",
      ),
      gate:undefined,
      exact:false,
    };
    context.decisionEvaluation=result;
    return result;
  }
  const blocking=questions.filter(question => BLOCKING_SEVERITIES.has(question.severity));
  const supplied=context.input.decisionPackage;
  const result={items:[],gate:undefined,exact:false};
  if (supplied===undefined) {
    if (DECISION_POLICY.package_required_when==="blocking-question-present" &&
        blocking.length>0) {
      for (const question of blocking) {
        const index=questions.indexOf(question);
        result.items.push(evidence(
          "pmAnalysis",
          context.input.pmAnalysis,
          `/pmAnalysis/content/open_questions/${index}`,
          `Blocking ${question.severity} question ${question.id} requires a verified decision package`,
          question.id,
        ));
      }
    }
    context.decisionEvaluation=result;
    return result;
  }
  const coverageItems=exactDecisionCoverage(context.input.pmAnalysis,supplied);
  result.items.push(...coverageItems);
  try {
    result.gate=evaluateDecisionGate(supplied,context.authorityRegistry);
    result.exact=coverageItems.length===0;
  } catch (error) {
    result.items.push(evidence(
      "decisionPackage",
      undefined,
      "/decisionPackage",
      `Decision package verification failed: ${error.message}`,
    ));
  }
  for (const id of result.gate?.unresolved_blocking_question_ids ?? []) {
    const index=questions.findIndex(question => question.id===id);
    result.items.push(evidence(
      "pmAnalysis",
      context.input.pmAnalysis,
      `/pmAnalysis/content/open_questions/${Math.max(index,0)}`,
      `Blocking decision ${id} remains unresolved`,
      id,
    ));
  }
  context.decisionEvaluation=result;
  return result;
}

function blockingDecisionsRule(context) {
  return evaluateDecisions(context).items;
}

function architectureQuestionsRule({input}) {
  const items=[];
  const pmQuestions=input.pmAnalysis?.content?.architecture_questions;
  const architectureQuestions=input.architecture?.artifact?.content?.architecture_questions;
  const adrs=input.architecture?.adrs;
  items.push(...arrayShapeEvidence(
    pmQuestions,"pmAnalysis",input.pmAnalysis,
    "/pmAnalysis/content/architecture_questions","PM architecture questions",
  ));
  items.push(...arrayShapeEvidence(
    architectureQuestions,"architecture.artifact",input.architecture?.artifact,
    "/architecture/artifact/content/architecture_questions","Architecture questions",
  ));
  items.push(...arrayShapeEvidence(
    adrs,"architecture.adrs",undefined,"/architecture/adrs","ADRs",
  ));
  if (items.length>0) return items;
  const resolutions=new Map(architectureQuestions
    .map((question,index) => [question.id,{question,index}]));
  const adrQuestionIds=new Set(adrs.flatMap(adr =>
    adr?.content?.resolved_architecture_questions ?? []));
  for (const [index,question] of pmQuestions.entries()) {
    const resolution=resolutions.get(question.id);
    if (resolution?.question?.status!=="resolved") {
      items.push(evidence(
        "architecture.artifact",
        input.architecture?.artifact,
        resolution ?
          `/architecture/artifact/content/architecture_questions/${resolution.index}/status` :
          "/architecture/artifact/content/architecture_questions",
        `Architecture question ${question.id} is not resolved`,
        question.id,
      ));
    } else if (!adrQuestionIds.has(question.id)) {
      items.push(evidence(
        "architecture.adrs",
        undefined,
        "/architecture/adrs",
        `Resolved architecture question ${question.id} is not linked by an ADR`,
        question.id,
      ));
    }
  }
  return items;
}

function approvedAdrsRule({input}) {
  const adrs=input.architecture?.adrs;
  if (!Array.isArray(adrs) || adrs.length===0) {
    return [evidence("architecture.adrs",undefined,"/architecture/adrs","At least one ADR is required")];
  }
  const items=[];
  const approved=new Set((input.adrApprovals ?? []).map(approval =>
    canonicalJson(approval.content?.adr)));
  for (const [index,adr] of adrs.entries()) {
    const externallyApproved=approved.has(canonicalJson(exactReference(adr)));
    if (adr?.content?.status!=="accepted" && !externallyApproved) {
      items.push(evidence(
        `architecture.adrs[${index}]`,adr,
        `/architecture/adrs/${index}/content/status`,
        `ADR ${String(adr?.content?.id)} is not accepted`,
        adr?.content?.id ?? null,
      ));
    }
    if (adr?.content?.approval?.state!=="approved" && !externallyApproved) {
      items.push(evidence(
        `architecture.adrs[${index}]`,adr,
        `/architecture/adrs/${index}/content/approval/state`,
        `ADR ${String(adr?.content?.id)} is not approved`,
        adr?.content?.id ?? null,
      ));
    }
  }
  return items;
}

function deliveryRecordsRule({input}) {
  const items=["risks","assumptions"].flatMap(section =>
    requiredSection(input,section,"Delivery records"));
  const issues=input.issuePlan?.content?.issues;
  items.push(...arrayShapeEvidence(
    issues,"issuePlan",input.issuePlan,
    "/issuePlan/content/issues","Issue-plan issues",
  ));
  if (!Array.isArray(issues)) return items;
  for (const [index,issue] of issues.entries()) {
    if (!Array.isArray(issue.dependencies)) {
      items.push(evidence(
        "issuePlan",
        input.issuePlan,
        `/issuePlan/content/issues/${index}/dependencies`,
        `Issue ${String(issue.id)} does not record dependencies`,
        issue.id ?? null,
      ));
    }
  }
  return items;
}

function epicMapRule({input}) {
  const epics=input.issuePlan?.content?.epics;
  const issues=input.issuePlan?.content?.issues;
  const items=[];
  if (!Array.isArray(epics) || epics.length===0) {
    items.push(evidence("issuePlan",input.issuePlan,"/issuePlan/content/epics","Epic map is empty"));
    return items;
  }
  items.push(...arrayShapeEvidence(
    issues,"issuePlan",input.issuePlan,
    "/issuePlan/content/issues","Issue-plan issues",
  ));
  if (!Array.isArray(issues)) return items;
  const epicIds=new Set(epics.map(epic => epic.id));
  const used=new Set();
  for (const [index,issue] of (issues ?? []).entries()) {
    const epicId=issue?.epic?.id;
    if (!epicIds.has(epicId)) {
      items.push(evidence(
        "issuePlan",input.issuePlan,`/issuePlan/content/issues/${index}/epic`,
        `Issue ${String(issue?.id)} is not mapped to an authoritative epic`,
        issue?.id ?? null,
      ));
    } else used.add(epicId);
  }
  for (const [index,epic] of epics.entries()) {
    if (!used.has(epic.id)) {
      items.push(evidence(
        "issuePlan",input.issuePlan,`/issuePlan/content/epics/${index}`,
        `Epic ${epic.id} contains no issue`,epic.id,
      ));
    }
  }
  for (const [index,candidate] of
    (input.pmAnalysis?.content?.epic_candidates ?? []).entries()) {
    if (!epicIds.has(candidate.id)) {
      items.push(evidence(
        "pmAnalysis",input.pmAnalysis,`/pmAnalysis/content/epic_candidates/${index}`,
        `PM epic candidate ${candidate.id} is absent from the authoritative epic map`,candidate.id,
      ));
    }
  }
  return items;
}

function rawCoverage(input) {
  const requirements=[];
  for (const section of ["functional_requirements","non_functional_requirements","constraints"]) {
    for (const [index,entity] of (input.pmAnalysis?.content?.[section] ?? []).entries()) {
      requirements.push({id:entity.id,section,index});
    }
  }
  const issues=input.issuePlan?.content?.issues ?? [];
  const criteria=new Map((input.issuePlan?.content?.acceptance_criteria ?? [])
    .map(criterion => [criterion.id,criterion]));
  const authoritativeIds=new Set(requirements.map(requirement => requirement.id));
  const covered=new Set();
  for (const issue of issues) {
    const sources=new Set((issue.source_requirements ?? []).map(reference => reference.id));
    for (const criterionReference of issue.acceptance_criteria ?? []) {
      const verifies=criteria.get(criterionReference.id)?.verifies ?? [];
      for (const reference of verifies) {
        if (authoritativeIds.has(reference.id) && sources.has(reference.id)) {
          covered.add(reference.id);
        }
      }
    }
  }
  return {
    value:requirements.length===0 ? 1 : covered.size/requirements.length,
    uncovered:requirements.filter(requirement => !covered.has(requirement.id)),
  };
}

function coverageShapeEvidence(input) {
  const items=[];
  for (const section of ["functional_requirements","non_functional_requirements","constraints"]) {
    items.push(...arrayShapeEvidence(
      input.pmAnalysis?.content?.[section],"pmAnalysis",input.pmAnalysis,
      `/pmAnalysis/content/${section}`,`PM ${section}`,
    ));
  }
  const issues=input.issuePlan?.content?.issues;
  const criteria=input.issuePlan?.content?.acceptance_criteria;
  items.push(...arrayShapeEvidence(
    issues,"issuePlan",input.issuePlan,
    "/issuePlan/content/issues","Issue-plan issues",
  ));
  items.push(...arrayShapeEvidence(
    criteria,"issuePlan",input.issuePlan,
    "/issuePlan/content/acceptance_criteria","Issue-plan acceptance criteria",
  ));
  if (Array.isArray(issues)) {
    for (const [index,issue] of issues.entries()) {
      items.push(...arrayShapeEvidence(
        issue?.source_requirements,"issuePlan",input.issuePlan,
        `/issuePlan/content/issues/${index}/source_requirements`,
        `Issue ${String(issue?.id)} source requirements`,
      ));
      items.push(...arrayShapeEvidence(
        issue?.acceptance_criteria,"issuePlan",input.issuePlan,
        `/issuePlan/content/issues/${index}/acceptance_criteria`,
        `Issue ${String(issue?.id)} acceptance criteria`,
      ));
    }
  }
  if (Array.isArray(criteria)) {
    for (const [index,criterion] of criteria.entries()) {
      items.push(...arrayShapeEvidence(
        criterion?.verifies,"issuePlan",input.issuePlan,
        `/issuePlan/content/acceptance_criteria/${index}/verifies`,
        `Acceptance criterion ${String(criterion?.id)} verifies`,
      ));
    }
  }
  return items;
}

function coverageRule(context) {
  const malformed=coverageShapeEvidence(context.input);
  if (malformed.length>0) {
    context.coverage=0;
    return malformed;
  }
  const direct=rawCoverage(context.input);
  if (context.rebuiltTraceGraph===undefined) {
    context.coverage=0;
    if (direct.uncovered.length===0) {
      return [evidence(
        "traceGraph",undefined,"/traceGraph",
        "Authoritative trace reconstruction failed; coverage cannot receive fallback credit",
      )];
    }
    return direct.uncovered.map(requirement => evidence(
      "pmAnalysis",context.input.pmAnalysis,
      `/pmAnalysis/content/${requirement.section}/${requirement.index}`,
      `Requirement ${requirement.id} has no issue-owned verifying acceptance criterion`,
      requirement.id,
    ));
  }
  const coverage=calculateRequirementCoverage(context.rebuiltTraceGraph);
  context.coverage=coverage;
  if (coverage===1) return [];
  if (direct.uncovered.length===0) {
    return [evidence(
      "traceGraph",undefined,"/traceGraph",
      `Recomputed requirement/AC coverage is ${coverage}`,
    )];
  }
  return direct.uncovered.map(requirement => evidence(
    "pmAnalysis",context.input.pmAnalysis,
    `/pmAnalysis/content/${requirement.section}/${requirement.index}`,
    `Requirement ${requirement.id} has no issue-owned verifying acceptance criterion`,
    requirement.id,
  ));
}

function expectedAuditInputs(input) {
  return [
    input.pmAnalysis,
    input.architecture?.artifact,
    ...(input.architecture?.adrs ?? []),
    ...(input.adrApprovals ?? []),
    ...(input.decisionAnswers ?? []),
    input.issuePlan,
  ].map(exactReference).filter(Boolean).sort((left,right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)));
}

function latestAuditRule(context) {
  const {input}=context;
  if (!Array.isArray(input.specAudits) || input.specAudits.length===0) {
    return [evidence("specAudits",undefined,"/specAudits","No Spec Audit is available")];
  }
  const source=sourceOf(input);
  const items=[];
  const adrs=input.architecture?.adrs;
  items.push(...arrayShapeEvidence(
    adrs,"architecture.adrs",undefined,"/architecture/adrs","ADRs",
  ));
  if (!Array.isArray(adrs)) return items;
  const expectedInputs=expectedAuditInputs(input);
  for (const [index,audit] of input.specAudits.entries()) {
    if (audit?.provenance?.source_revision!==source.source_revision ||
        audit?.provenance?.source_sha256!==source.source_sha256) {
      items.push(evidence(
        `specAudits[${index}]`,audit,`/specAudits/${index}/provenance`,
        "Spec Audit is stale or belongs to a different source revision",
      ));
    }
    const auditInputs=audit?.inputs;
    const malformedInputs=arrayShapeEvidence(
      auditInputs,`specAudits[${index}]`,audit,
      `/specAudits/${index}/inputs`,`Spec Audit ${index} inputs`,
    );
    items.push(...malformedInputs);
    if (malformedInputs.length>0) continue;
    const actual=[...auditInputs].sort((left,right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)));
    if (canonicalJson(actual)!==canonicalJson(expectedInputs)) {
      items.push(evidence(
        `specAudits[${index}]`,audit,`/specAudits/${index}/inputs`,
        "Spec Audit does not bind the exact current pipeline revisions",
      ));
    }
  }
  const latestEntry=input.specAudits.map((audit,index) => ({audit,index}))
    .sort((left,right) =>
      (right.audit?.revision ?? 0)-(left.audit?.revision ?? 0) ||
      String(right.audit?.created_at).localeCompare(String(left.audit?.created_at)) ||
      String(right.audit?.artifact_id).localeCompare(String(left.audit?.artifact_id)) ||
      left.index-right.index)[0];
  const latest=latestEntry.audit;
  const latestPath=`/specAudits/${latestEntry.index}`;
  context.latestAudit=latest;
  context.latestAuditIndex=latestEntry.index;
  let expected;
  try {
    expected=auditSpecification({
      pmAnalysis:input.pmAnalysis,
      architecture:input.architecture,
      ...(input.adrApprovals===undefined ? {} : {approvals:input.adrApprovals}),
      ...(input.decisionPackage===undefined ? {} : {
        decisionPackage:input.decisionPackage,
      }),
      ...(input.decisionAnswers===undefined ? {} : {
        decisionAnswers:input.decisionAnswers,
      }),
      issuePlan:input.issuePlan,
    }).artifact;
    context.rebuiltAudit=expected;
  } catch (error) {
    items.push(evidence(
      `specAudits[${latestEntry.index}]`,latest,latestPath,
      `Spec Audit cannot be recomputed from authoritative artifacts: ${error.message}`,
    ));
    return items;
  }
  if (canonicalJson(latest)!==canonicalJson(expected)) {
    items.push(evidence(
      `specAudits[${latestEntry.index}]`,latest,latestPath,
      "Latest Spec Audit differs from the independently recomputed audit",
    ));
  }
  if (latest?.content?.status!=="PASS") {
    items.push(evidence(
      `specAudits[${latestEntry.index}]`,latest,`${latestPath}/content/status`,
      `Latest exact-source Spec Audit status is ${String(latest?.content?.status)}, not PASS`,
    ));
  }
  return items;
}

function analysisStateRule(context) {
  const {input}=context;
  const state=input.analysisState;
  const items=[];
  if (state?.content?.previous_state!=="SPEC_AUDIT" ||
      state?.content?.event!=="AUDIT_PASSED" ||
      state?.content?.state!=="READY_FOR_ISSUES") {
    items.push(evidence(
      "analysisState",state,"/analysisState/content",
      "Analysis state is not an AUDIT_PASSED transition from SPEC_AUDIT to READY_FOR_ISSUES",
    ));
  }
  const latest=context.latestAudit ?? input.specAudits?.[0];
  const artifacts={
    pm_analysis:input.pmAnalysis,
    architecture:input.architecture?.artifact,
    adrs:input.architecture?.adrs,
    issue_plan:input.issuePlan,
    spec_audit:latest,
  };
  if ((input.adrApprovals?.length ?? 0)>0) artifacts.adr_approvals=input.adrApprovals;
  if ((input.decisionAnswers?.length ?? 0)>0) artifacts.decision_answers=input.decisionAnswers;
  if ((input.decisionAnswers?.length ?? 0)>0 && input.decisionPackage!==undefined) {
    artifacts.decision_package=input.decisionPackage;
  }
  let reconstructed;
  try {
    reconstructed=transition("SPEC_AUDIT","AUDIT_PASSED",{
      source_revision:input.pmAnalysis?.provenance?.source_revision,
      source_sha256:input.pmAnalysis?.provenance?.source_sha256,
      artifacts,
    });
  } catch (error) {
    items.push(evidence(
      "analysisState",state,"/analysisState",
      `Analysis state cannot be reconstructed from current evidence: ${error.message}`,
    ));
    return items;
  }
  if (canonicalJson(state?.content)!==canonicalJson(reconstructed)) {
    items.push(evidence(
      "analysisState",state,"/analysisState/content",
      "Analysis-state content differs from the independently reconstructed transition",
    ));
  }
  if (canonicalJson(state?.inputs)!==canonicalJson(reconstructed.input_artifacts)) {
    items.push(evidence(
      "analysisState",state,"/analysisState/inputs",
      "Analysis-state envelope inputs contradict its exact transition inputs",
    ));
  }
  return items;
}

function assumptionWarningsRule(context) {
  const questions=context.input.pmAnalysis?.content?.open_questions;
  if (!Array.isArray(questions)) {
    return arrayShapeEvidence(
      questions,"pmAnalysis",context.input.pmAnalysis,
      "/pmAnalysis/content/open_questions","PM open questions",
    );
  }
  const evaluation=evaluateDecisions(context);
  const unresolved=!evaluation.exact ?
    new Set(questions.filter(question => ASSUMPTION_SEVERITIES.has(question.severity))
      .map(question => question.id)) :
    new Set(evaluation.gate.unresolved_assumption_question_ids);
  return questions.flatMap((question,index) => unresolved.has(question.id) ? [evidence(
    "pmAnalysis",context.input.pmAnalysis,
    `/pmAnalysis/content/open_questions/${index}`,
    `Non-blocking ${question.severity} assumption ${question.id} remains unresolved`,
    question.id,
  )] : []);
}

const RULE_HANDLERS=Object.freeze({
  "PDOR-001-ARTIFACT-INTEGRITY":integrityRule,
  "PDOR-010-PROJECT-FRAMING":projectFramingRule,
  "PDOR-020-PRODUCT-DEFINITION":productDefinitionRule,
  "PDOR-030-SYSTEM-CONTEXT":systemContextRule,
  "PDOR-040-BLOCKING-DECISIONS":blockingDecisionsRule,
  "PDOR-050-ARCHITECTURE-QUESTIONS":architectureQuestionsRule,
  "PDOR-060-APPROVED-ADRS":approvedAdrsRule,
  "PDOR-070-DELIVERY-RECORDS":deliveryRecordsRule,
  "PDOR-080-EPIC-MAP":epicMapRule,
  "PDOR-090-REQUIREMENT-AC-COVERAGE":coverageRule,
  "PDOR-100-LATEST-SPEC-AUDIT":latestAuditRule,
  "PDOR-110-ANALYSIS-STATE":analysisStateRule,
  "PDOR-120-UNRESOLVED-ASSUMPTIONS":assumptionWarningsRule,
});
const RULE_INPUT_DEPENDENCIES=Object.freeze({
  "PDOR-010-PROJECT-FRAMING":["pmAnalysis"],
  "PDOR-020-PRODUCT-DEFINITION":["pmAnalysis"],
  "PDOR-030-SYSTEM-CONTEXT":["pmAnalysis"],
  "PDOR-040-BLOCKING-DECISIONS":["pmAnalysis","decisionPackage"],
  "PDOR-050-ARCHITECTURE-QUESTIONS":[
    "pmAnalysis","architecture.artifact","architecture.adrs",
  ],
  "PDOR-060-APPROVED-ADRS":["architecture.adrs"],
  "PDOR-070-DELIVERY-RECORDS":["pmAnalysis","issuePlan"],
  "PDOR-080-EPIC-MAP":["pmAnalysis","issuePlan"],
  "PDOR-090-REQUIREMENT-AC-COVERAGE":[
    "pmAnalysis","architecture.artifact","architecture.adrs","issuePlan",
  ],
  "PDOR-100-LATEST-SPEC-AUDIT":[
    "pmAnalysis","architecture.artifact","architecture.adrs","issuePlan","specAudits",
  ],
  "PDOR-110-ANALYSIS-STATE":[
    "pmAnalysis","architecture.artifact","architecture.adrs","issuePlan",
    "specAudits","analysisState",
  ],
  "PDOR-120-UNRESOLVED-ASSUMPTIONS":["pmAnalysis","decisionPackage"],
});

function dependentInputEvidence(context,ruleId) {
  const dependencies=RULE_INPUT_DEPENDENCIES[ruleId] ?? [];
  const items=[];
  for (const [key,evidenceItems] of context.dependencyEvidence ?? []) {
    if (dependencies.some(dependency =>
      key===dependency || key.startsWith(`${dependency}[`))) {
      items.push(...evidenceItems);
    }
  }
  return canonicalEvidenceItems(items);
}

if (canonicalJson(Object.keys(RULE_HANDLERS).sort())!==canonicalJson([...RULE_IDS].sort())) {
  throw new Error("Every PDoR rule must have exactly one runtime evaluator");
}

export function evaluateProjectReadiness(artifacts,options={}) {
  let input;
  let trustedOptions;
  try {
    input=canonicalCopy(artifacts);
  } catch (error) {
    return boundaryFailure(
      `Pipeline artifact aggregate must be canonical JSON: ${error.message}`,
    );
  }
  try {
    trustedOptions=canonicalCopy(options);
  } catch (error) {
    return boundaryFailure(
      `Readiness trust context must be canonical JSON: ${error.message}`,
      "/options",
    );
  }
  if (!isPlainObject(trustedOptions) ||
      Object.keys(trustedOptions).some(key => key!=="authorityRegistry")) {
    return boundaryFailure(
      "Readiness trust context accepts only an external authorityRegistry",
      "/options",
    );
  }
  if (!isPlainObject(input)) {
    return boundaryFailure(
      "Pipeline artifact aggregate must be a plain JSON object",
    );
  }

  const context={
    input,
    authorityRegistry:trustedOptions.authorityRegistry,
    coverage:0,
  };
  const failures=[];
  const warnings=[];
  for (const rule of RULES.rules) {
    let items;
    try {
      const dependencyItems=dependentInputEvidence(context,rule.id);
      items=dependencyItems.length>0 ? dependencyItems : RULE_HANDLERS[rule.id](context);
    } catch (error) {
      items=[evidence(
        "pipeline-input",undefined,"/",
        `${rule.id} evaluation failed closed: ${error.message}`,
      )];
    }
    if (items.length===0) continue;
    const result=ruleResult(rule.id,items);
    if (rule.severity==="blocking") failures.push(result);
    else warnings.push(result);
  }
  const source=sourceOf(input);
  const result={
    schema_version:"pdor-result.v1",
    document_type:"pdor-result",
    rules_version:RULES.schema_version,
    ...source,
    ready_for_issue_generation:failures.length===0 && context.coverage===1,
    coverage:{requirement_ac:context.coverage},
    failures,
    warnings,
  };
  const validation=validateDocument(result,"pdor-result.v1");
  if (!validation.valid) {
    return boundaryFailure(
      `Readiness result contract construction failed: ${validation.errors[0]?.message}`,
    );
  }
  return deepFreeze(result);
}
