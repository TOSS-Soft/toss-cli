import {createHash,createPublicKey,verify as verifyDetached} from "node:crypto";

import {canonicalJson,sha256Canonical} from "../contracts/acp.js";
import {validateDocument} from "../contracts/validator.js";
import {
  assertOwnDataFunction,
  exactArtifactReference,
  normalizeMarkerMatches,
  normalizeRemoteIssue,
  validateGitHubAdapter,
} from "./github-adapter.js";
import {validateIssuePlan} from "./issue-plan.js";
import {evaluateProjectReadiness} from "./readiness.js";
import {createDesignOrchestrator} from "./design-orchestrator.js";
import {evaluateDesignReadiness} from "./design-readiness.js";
import {auditSpecification} from "./spec-auditor.js";
import {transition} from "./state-machine.js";

const REPOSITORY_PATTERN=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]+$/;
const SHA256_PATTERN=/^[a-f0-9]{64}$/;
const SIGNATURE_PATTERN=/^[A-Za-z0-9+/]{86}==$/;
const APPROVAL_KIND="GITHUB_ISSUE_PUBLICATION";
const SIGNING_DOMAIN="toss.github-issue-publication.authority-approval.v1";
const AUTHORITY_REGISTRY_VERSION="github-publication-authority-registry.v1";
const PUBLICATION_ROLES=new Set(["CEO","USER"]);
const AUTHORITY_ROLES=new Set(["ARCHITECT","SPECIALIST","CEO","USER"]);
const DECISION_ROUTES=Object.freeze({
  A2:Object.freeze({
    verification_kind:"A2_ARCHITECT_OR_SPECIALIST_EVIDENCE",
    actor_roles:Object.freeze(["ARCHITECT","SPECIALIST"]),
  }),
  A3:Object.freeze({
    verification_kind:"A3_VERIFIED_CEO_OR_USER_AUTHORITY",
    actor_roles:Object.freeze(["CEO","USER"]),
  }),
});
const RETRYABLE_CODES=new Set([
  "API_UNAVAILABLE",
  "PERMISSION_DENIED",
  "RATE_LIMITED",
]);

export class GitHubPublicationError extends Error {
  constructor(message,{code="GITHUB_PUBLICATION_FAILED",result,cause}={}) {
    super(message,{cause});
    this.name="GitHubPublicationError";
    this.code=code;
    if (result!==undefined) this.result=result;
  }
}

function isPlainObject(value) {
  if (!value || typeof value!=="object" || Array.isArray(value)) return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype || prototype===null;
}

function canonicalCopy(value,label) {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw new TypeError(`${label} must be canonical JSON`,{cause:error});
  }
}

function deepFreeze(value) {
  if (!value || typeof value!=="object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requiredText(value,label) {
  if (typeof value!=="string" || value.length===0 || value.trim()!==value) {
    throw new TypeError(`${label} must be a non-blank exact string`);
  }
  return value;
}

function rejectUnknownFields(value,allowed,label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${label} contains unsupported field ${key}`);
  }
}

function requireClosedObject(value,fields,label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a closed plain object`);
  rejectUnknownFields(value,fields,label);
  for (const field of fields) {
    if (!Object.hasOwn(value,field)) throw new TypeError(`${label} requires ${field}`);
  }
}

function exactReference(artifact) {
  return exactArtifactReference({
    document_type:artifact.document_type,
    artifact_id:artifact.artifact_id,
    revision:artifact.revision,
    content_sha256:artifact.content_sha256,
  });
}

function same(left,right) {
  return canonicalJson(left)===canonicalJson(right);
}

function canonicalContext(value) {
  const context=canonicalCopy(value,"GitHub writer context");
  requireClosedObject(context,["repository","artifacts"],"GitHub writer context");
  if (typeof context.repository!=="string" ||
      !REPOSITORY_PATTERN.test(context.repository)) {
    throw new TypeError(
      "GitHub writer repository must be an exact canonical owner/name identity",
    );
  }
  if (!isPlainObject(context.artifacts)) {
    throw new TypeError("GitHub writer artifacts must be a closed plain object");
  }
  return context;
}

function latestAudit(artifacts) {
  if (!Array.isArray(artifacts.specAudits) || artifacts.specAudits.length===0) {
    throw new GitHubPublicationError("GitHub publication readiness requires a Spec Audit");
  }
  return artifacts.specAudits.map((audit,index) => ({audit,index})).sort((left,right) =>
    (right.audit?.revision ?? 0)-(left.audit?.revision ?? 0) ||
    String(right.audit?.created_at).localeCompare(String(left.audit?.created_at)) ||
    String(right.audit?.artifact_id).localeCompare(String(left.audit?.artifact_id)) ||
    left.index-right.index,
  )[0].audit;
}

function decisionAuthorityRegistry(registry) {
  const actors=registry.actors.filter(actor => Array.isArray(actor.allowed_routes) &&
    actor.allowed_routes.length>0).map(actor => ({
    actor_id:actor.actor_id,
    actor_role:actor.actor_role,
    public_key:actor.public_key,
    allowed_routes:actor.allowed_routes,
  }));
  return actors.length===0 ? undefined : {actors};
}

function designAuthorityRegistry(registry) {
  const actors=registry.actors.filter(actor =>
    new Set(["CEO","USER"]).has(actor.actor_role) &&
    Array.isArray(actor.allowed_routes) && actor.allowed_routes.some(route =>
      route.authority==="A3" &&
      route.verification_kind==="A3_VERIFIED_CEO_OR_USER_AUTHORITY",
    )).map(actor => ({
    actor_id:actor.actor_id,
    actor_role:actor.actor_role,
    public_key:actor.public_key,
    allowed_routes:[{
      authority:"A3",
      verification_kind:"A3_VERIFIED_CEO_OR_USER_AUTHORITY",
    }],
  }));
  return actors.length===0 ? undefined : {actors};
}

function assertIndependentGates(context,registry) {
  const {artifacts}=context;
  const issuePlanValidation=validateIssuePlan({
    pmAnalysis:artifacts.pmAnalysis,
    architecture:artifacts.architecture?.artifact,
    adrs:artifacts.architecture?.adrs,
    ...(artifacts.adrApprovals===undefined ? {} : {approvals:artifacts.adrApprovals}),
    ...(artifacts.decisionPackage===undefined ? {} : {
      decisionPackage:artifacts.decisionPackage,
    }),
    issuePlan:artifacts.issuePlan,
  });
  if (!issuePlanValidation.valid || !issuePlanValidation.complete ||
      !issuePlanValidation.ready_for_issues) {
    throw new GitHubPublicationError("GitHub publication readiness requires a valid complete issue plan");
  }

  const audit=latestAudit(artifacts);
  const rebuilt=auditSpecification({
    pmAnalysis:artifacts.pmAnalysis,
    architecture:artifacts.architecture,
    ...(artifacts.adrApprovals===undefined ? {} : {approvals:artifacts.adrApprovals}),
    ...(artifacts.decisionPackage===undefined ? {} : {
      decisionPackage:artifacts.decisionPackage,
    }),
    ...(artifacts.decisionAnswers===undefined ? {} : {
      decisionAnswers:artifacts.decisionAnswers,
    }),
    issuePlan:artifacts.issuePlan,
  }).artifact;
  if (!same(audit,rebuilt) || audit.content?.status!=="PASS" ||
      audit.content?.ready_for_github!==true) {
    throw new GitHubPublicationError(
      "GitHub publication readiness requires the latest exact-source Spec Audit PASS",
    );
  }

  const stateArtifacts={
    pm_analysis:artifacts.pmAnalysis,
    architecture:artifacts.architecture.artifact,
    adrs:artifacts.architecture.adrs,
    issue_plan:artifacts.issuePlan,
    spec_audit:audit,
  };
  if ((artifacts.adrApprovals?.length ?? 0)>0) {
    stateArtifacts.adr_approvals=artifacts.adrApprovals;
  }
  if ((artifacts.decisionAnswers?.length ?? 0)>0) {
    stateArtifacts.decision_answers=artifacts.decisionAnswers;
  }
  if ((artifacts.decisionAnswers?.length ?? 0)>0 && artifacts.decisionPackage!==undefined) {
    stateArtifacts.decision_package=artifacts.decisionPackage;
  }
  const rebuiltState=transition("SPEC_AUDIT","AUDIT_PASSED",{
    source_revision:artifacts.pmAnalysis.provenance.source_revision,
    source_sha256:artifacts.pmAnalysis.provenance.source_sha256,
    artifacts:stateArtifacts,
  });
  if (!same(artifacts.analysisState?.content,rebuiltState) ||
      !same(artifacts.analysisState?.inputs,rebuiltState.input_artifacts) ||
      artifacts.analysisState?.content?.state!=="READY_FOR_ISSUES") {
    throw new GitHubPublicationError(
      "GitHub publication readiness requires verified READY_FOR_ISSUES state",
    );
  }

  const trustedDecisions=decisionAuthorityRegistry(registry);
  const projectArtifacts=Object.fromEntries([
    "analysisState","adrApprovals","architecture","decisionAnswers",
    "decisionPackage","issuePlan","pmAnalysis","specAudits","traceGraph",
  ].filter(key => Object.hasOwn(artifacts,key)).map(key => [key,artifacts[key]]));
  const readiness=evaluateProjectReadiness(
    projectArtifacts,
    trustedDecisions===undefined ? {} : {authorityRegistry:trustedDecisions},
  );
  const source=artifacts.issuePlan.provenance;
  if (readiness.ready_for_issue_generation!==true ||
      readiness.source_revision!==source.source_revision ||
      readiness.source_sha256!==source.source_sha256) {
    throw new GitHubPublicationError(
      "GitHub publication readiness requires exact current-source PDoR PASS",
    );
  }
  const uiIssues=artifacts.issuePlan.content.issues.filter(issue =>
    Object.hasOwn(issue,"ui_design_trace"));
  let designReadiness;
  let designInputs=[];
  if (uiIssues.length>0) {
    const {designGraph,designAudit,designApproval,designState}=artifacts;
    if (!Array.isArray(designGraph) || !designAudit || !designApproval || !designState) {
      throw new GitHubPublicationError(
        "GitHub publication design readiness requires the exact design graph, audit, approval, and state",
      );
    }
    const stateValidation=validateDocument(designState,"design-orchestration-state.v1");
    if (!stateValidation.valid || designState.content_sha256!==sha256Canonical(designState.content)) {
      throw new GitHubPublicationError(
        "GitHub publication design readiness requires a valid immutable design state",
      );
    }
    let verifiedState;
    try {
      const trustedDesign=designAuthorityRegistry(registry);
      if (!trustedDesign) throw new TypeError("Trusted registry has no design authority");
      verifiedState=createDesignOrchestrator({authorityRegistry:trustedDesign})
        .verifyStateSnapshot({content:designState.content,provenance:designState.provenance});
    } catch (error) {
      throw new GitHubPublicationError(
        "GitHub publication design readiness requires independently verified design authority",
        {cause:error},
      );
    }
    const graphRefs=designGraph.map(exactReference).sort((left,right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)));
    const stateRefs=[...(verifiedState.content?.artifact_refs ?? [])].sort((left,right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)));
    if (verifiedState.content?.state!=="APPROVED" ||
        verifiedState.content?.gate!=="COMPLETE" || !same(graphRefs,stateRefs)) {
      throw new GitHubPublicationError(
        "GitHub publication design readiness requires a COMPLETE state for the exact graph",
      );
    }
    designReadiness=evaluateDesignReadiness({
      designGraph,
      audit:designAudit,
      approval:designApproval,
      issuePlan:artifacts.issuePlan,
    });
    if (designReadiness.ready_for_ui_issue_generation!==true ||
        !same(designReadiness.ui_issue_ids,uiIssues.map(issue => issue.id).sort())) {
      throw new GitHubPublicationError(
        "GitHub publication design readiness requires exact current UI Design DoR PASS",
      );
    }
    designInputs=[designAudit,designApproval,designState].map(exactReference);
  }
  return {audit,readiness,designReadiness,designInputs};
}

function canonicalizePublicKey(value,label) {
  if (typeof value!=="string" || value.length===0 ||
      value.replace(/\r\n/gu,"").includes("\r")) {
    throw new TypeError(`${label} must be a canonical public PEM string`);
  }
  const canonical=value.replace(/\r\n/gu,"\n");
  const input=canonical.endsWith("\n") ? canonical : `${canonical}\n`;
  const blocks=input.match(
    /-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n/gu,
  );
  if (!blocks || blocks.length!==1 || blocks[0]!==input) {
    throw new TypeError(`${label} must contain exactly one canonical Ed25519 SPKI key`);
  }
  let key;
  let normalized;
  try {
    key=createPublicKey(input);
    normalized=key.export({format:"pem",type:"spki"}).toString();
  } catch (error) {
    throw new TypeError(`${label} is not a valid public PEM key`,{cause:error});
  }
  if (key.asymmetricKeyType!=="ed25519") {
    throw new TypeError(`${label} must be an Ed25519 public key`);
  }
  if (input!==normalized) {
    throw new TypeError(`${label} must contain exactly one canonical Ed25519 SPKI key`);
  }
  return key;
}

function publicKeyFingerprint(key) {
  return createHash("sha256").update(key.export({
    type:"spki",
    format:"der",
  })).digest("hex");
}

function canonicalAuthorityRegistry(value) {
  const registry=canonicalCopy(value,"Trusted publication authority registry");
  requireClosedObject(registry,[
    "schema_version","registry_id","revision","actors","content_sha256",
  ],"Trusted publication authority registry");
  if (registry.schema_version!==AUTHORITY_REGISTRY_VERSION) {
    throw new TypeError("Trusted publication authority registry version is unsupported");
  }
  requiredText(registry.registry_id,"Trusted publication authority registry registry_id");
  if (!Number.isSafeInteger(registry.revision) || registry.revision<1) {
    throw new TypeError("Trusted publication authority registry revision must be positive");
  }
  if (typeof registry.content_sha256!=="string" ||
      !SHA256_PATTERN.test(registry.content_sha256)) {
    throw new TypeError("Trusted publication authority registry content hash is invalid");
  }
  const {content_sha256:contentHash,...unsignedRegistry}=registry;
  if (sha256Canonical(unsignedRegistry)!==contentHash) {
    throw new TypeError("Trusted publication authority registry content hash does not match");
  }
  if (!Array.isArray(registry.actors) || registry.actors.length===0) {
    throw new TypeError("Trusted publication authority registry requires actors");
  }
  const actors=new Map();
  for (const [index,actor] of registry.actors.entries()) {
    const label=`Trusted publication authority registry actor ${index}`;
    if (!isPlainObject(actor)) throw new TypeError(`${label} must be a closed plain object`);
    const allowed=[
      "actor_id","actor_role","public_key","public_key_fingerprint",
      "allowed_publications","allowed_routes",
    ];
    rejectUnknownFields(actor,allowed,label);
    for (const field of [
      "actor_id","actor_role","public_key","public_key_fingerprint","allowed_publications",
    ]) {
      if (!Object.hasOwn(actor,field)) throw new TypeError(`${label} requires ${field}`);
    }
    const actorId=requiredText(actor.actor_id,`${label}.actor_id`);
    const actorRole=requiredText(actor.actor_role,`${label}.actor_role`);
    if (!AUTHORITY_ROLES.has(actorRole)) throw new TypeError(`${label}.actor_role is invalid`);
    if (actors.has(actorId)) throw new TypeError(`Authority registry duplicates actor ${actorId}`);
    if (!Array.isArray(actor.allowed_publications)) {
      throw new TypeError(`${label}.allowed_publications must be an array`);
    }
    const publications=new Set();
    for (const [publicationIndex,publication] of actor.allowed_publications.entries()) {
      const publicationLabel=`${label}.allowed_publications[${publicationIndex}]`;
      requireClosedObject(
        publication,
        ["approval_kind","repository"],
        publicationLabel,
      );
      if (publication.approval_kind!==APPROVAL_KIND ||
          typeof publication.repository!=="string" ||
          !REPOSITORY_PATTERN.test(publication.repository)) {
        throw new TypeError(`${publicationLabel} is invalid`);
      }
      const key=canonicalJson(publication);
      if (publications.has(key)) throw new TypeError(`${label} duplicates publication route`);
      publications.add(key);
    }
    if (actor.allowed_routes!==undefined) {
      if (!Array.isArray(actor.allowed_routes) || actor.allowed_routes.length===0) {
        throw new TypeError(`${label}.allowed_routes must be a non-empty array when supplied`);
      }
      const routes=new Set();
      for (const [routeIndex,routeValue] of actor.allowed_routes.entries()) {
        const routeLabel=`${label}.allowed_routes[${routeIndex}]`;
        requireClosedObject(routeValue,["authority","verification_kind"],routeLabel);
        const route=DECISION_ROUTES[routeValue.authority];
        if (!route || route.verification_kind!==routeValue.verification_kind ||
            !route.actor_roles.includes(actorRole)) {
          throw new TypeError(`${routeLabel} contradicts the actor role or decision route`);
        }
        const routeKey=canonicalJson(routeValue);
        if (routes.has(routeKey)) throw new TypeError(`${label} duplicates allowed_routes entry`);
        routes.add(routeKey);
      }
    }
    const publicKey=canonicalizePublicKey(actor.public_key,`${label}.public_key`);
    const fingerprint=publicKeyFingerprint(publicKey);
    if (actor.public_key_fingerprint!==fingerprint) {
      throw new TypeError(`${label}.public_key_fingerprint does not match public key`);
    }
    actors.set(actorId,{
      actor_role:actorRole,
      public_key:publicKey,
      public_key_fingerprint:fingerprint,
      publications,
    });
  }

  return {
    registry:deepFreeze(registry),
    actors,
    provenance:Object.freeze({
      registry_id:registry.registry_id,
      revision:registry.revision,
      content_sha256:registry.content_sha256,
    }),
  };
}

function canonicalApproval(value,expected,trusted) {
  const approval=canonicalCopy(value,"GitHub publication approval");
  const approvalFields=[
    "approval_kind","actor_id","actor_role","repository","source_revision",
    "source_sha256","issue_plan","record_id","record_revision","record_sha256",
    "timestamp","signature",
  ];
  requireClosedObject(approval,approvalFields,"GitHub publication approval");
  if (approval.approval_kind!==APPROVAL_KIND) {
    throw new TypeError("GitHub publication approval kind is invalid");
  }
  requiredText(approval.actor_id,"GitHub publication approval actor_id");
  requiredText(approval.actor_role,"GitHub publication approval actor_role");
  if (!PUBLICATION_ROLES.has(approval.actor_role)) {
    throw new TypeError("GitHub publication approval role is not allowed");
  }
  if (approval.repository!==expected.repository) {
    throw new TypeError("GitHub publication approval repository does not match context");
  }
  if (approval.source_revision!==expected.source_revision ||
      approval.source_sha256!==expected.source_sha256) {
    throw new TypeError("GitHub publication approval source does not match current source");
  }
  const planReference=exactArtifactReference(
    approval.issue_plan,
    "GitHub publication approval issue plan",
  );
  if (!same(planReference,expected.issue_plan)) {
    throw new TypeError("GitHub publication approval plan does not match current issue plan");
  }
  requiredText(approval.record_id,"GitHub publication approval record_id");
  if (!Number.isSafeInteger(approval.record_revision) || approval.record_revision<1) {
    throw new TypeError("GitHub publication approval record revision must be positive");
  }
  if (typeof approval.record_sha256!=="string" ||
      !SHA256_PATTERN.test(approval.record_sha256)) {
    throw new TypeError("GitHub publication approval record hash is invalid");
  }
  const timestampValidation=validateDocument({
    source:{file:"authority-record",section:"publication",location:"timestamp"},
    source_revision:approval.source_revision,
    source_sha256:approval.source_sha256,
    agent:{
      identity:approval.actor_id,
      model:"external-human-authority",
      run_id:`${approval.record_id}@${approval.record_revision}`,
    },
    timestamp:approval.timestamp,
    confidence:1,
  },"provenance.v1");
  if (!timestampValidation.valid) {
    throw new TypeError("GitHub publication approval timestamp is invalid");
  }
  if (typeof approval.signature!=="string" ||
      !SIGNATURE_PATTERN.test(approval.signature) ||
      Buffer.from(approval.signature,"base64").length!==64 ||
      Buffer.from(approval.signature,"base64").toString("base64")!==approval.signature) {
    throw new TypeError("GitHub publication approval signature is invalid");
  }
  const actor=trusted.actors.get(approval.actor_id);
  if (!actor) throw new TypeError("GitHub publication approval actor is not trusted");
  if (actor.actor_role!==approval.actor_role) {
    throw new TypeError("GitHub publication approval role does not match registry");
  }
  if (!actor.publications.has(canonicalJson({
    approval_kind:approval.approval_kind,
    repository:approval.repository,
  }))) {
    throw new TypeError("GitHub publication approval repository route is not trusted");
  }
  const {signature,...unsigned}=approval;
  const payload={domain:SIGNING_DOMAIN,...unsigned};
  let verified=false;
  try {
    verified=verifyDetached(
      null,
      Buffer.from(canonicalJson(payload),"utf8"),
      actor.public_key,
      Buffer.from(signature,"base64"),
    );
  } catch {
    verified=false;
  }
  if (!verified) throw new TypeError("GitHub publication approval signature is invalid");
  return {
    approval:deepFreeze(approval),
    authority_registry:Object.freeze({
      ...trusted.provenance,
      actor_id:approval.actor_id,
      public_key_fingerprint:actor.public_key_fingerprint,
    }),
  };
}

function issueMarker(repository,plan,localIssueId) {
  return `<!-- toss:issue-plan=${plan.artifact_id}@${plan.revision}#${
    plan.content_sha256};issue=${localIssueId};repository=${repository} -->`;
}

function entityMeaningById(collections) {
  const result=new Map();
  for (const collection of collections) {
    for (const entity of collection ?? []) result.set(entity.id,entity.meaning);
  }
  return result;
}

function bulletList(references,meanings,{empty="None"}={}) {
  if (references.length===0) return `- ${empty}`;
  return references.map(reference => {
    const meaning=meanings.get(reference.id);
    return meaning ? `- ${reference.id} — ${meaning}` : `- ${reference.id}`;
  }).join("\n");
}

function exactDesignLabel(reference) {
  return `${reference.document_type}:${reference.artifact_id}@${reference.revision}#${reference.content_sha256}${
    reference.entity_id===undefined ? "" : `:${reference.entity_id}`}`;
}

function designTraceBody(context,issue) {
  const trace=issue.ui_design_trace;
  if (!trace) return [];
  const brief=context.artifacts.designGraph.find(row => row.document_type==="design-brief");
  const rows=[
    "## UI Design trace",
    `- Design level: ${brief.content.orchestration.level}`,
    `- Design System: ${exactDesignLabel(trace.design_system_ref)}`,
  ];
  for (const [label,key] of [
    ["Flows","flow_refs"],["Screens","screen_refs"],["Components","component_refs"],
    ["States","state_refs"],["Responsive targets","responsive_refs"],
    ["Accessibility criteria","accessibility_refs"],
  ]) rows.push(`- ${label}: ${trace[key].map(exactDesignLabel).join(", ")}`);
  return rows;
}

function buildOperations(context) {
  const plan=context.artifacts.issuePlan;
  const pm=context.artifacts.pmAnalysis.content;
  const requirementMeanings=entityMeaningById([
    pm.functional_requirements,
    pm.non_functional_requirements,
    pm.constraints,
  ]);
  const adrMeanings=entityMeaningById(
    context.artifacts.architecture.adrs.map(adr => [adr.content]),
  );
  const criteria=new Map(plan.content.acceptance_criteria.map(criterion => [
    criterion.id,
    criterion,
  ]));
  return [...plan.content.issues].sort((left,right) => left.id.localeCompare(right.id))
    .map(issue => {
      const marker=issueMarker(context.repository,plan,issue.id);
      const acceptanceCriteria=issue.acceptance_criteria.map(reference => criteria.get(reference.id));
      const body=[
        marker,
        "",
        `# ${issue.id}`,
        "",
        issue.atomic_scope,
        "",
        "## Requirements",
        bulletList(issue.source_requirements ?? [],requirementMeanings),
        "",
        "## Relevant ADRs",
        bulletList(issue.adr_refs,adrMeanings),
        "",
        "## Dependencies",
        bulletList(issue.dependencies,new Map()),
        "",
        "## Acceptance criteria",
        ...acceptanceCriteria.map(criterion =>
          `- [ ] ${criterion.id} — ${criterion.meaning} (verifies: ${
            criterion.verifies.map(reference => reference.id).join(", ")})`,
        ),
        "",
        "## Definition of done",
        ...issue.definition_of_done.map(item => `- [ ] ${item}`),
        ...(issue.ui_design_trace ? ["",...designTraceBody(context,issue)] : []),
      ].join("\n");
      return {
        action:"create",
        repository:context.repository,
        local_issue_id:issue.id,
        marker,
        title:`[${issue.id}] ${issue.meaning}`,
        body,
        labels:["toss-generated"],
        milestone:null,
        dependencies:issue.dependencies.map(reference => reference.id),
      };
    });
}

function previewFor(context) {
  const plan=context.artifacts.issuePlan;
  return deepFreeze(canonicalCopy({
    schema_version:"github-publication-preview.v1",
    document_type:"github-publication-preview",
    mode:"preview",
    repository:context.repository,
    source_revision:plan.provenance.source_revision,
    source_sha256:plan.provenance.source_sha256,
    issue_plan:exactReference(plan),
    operations:buildOperations(context),
  },"GitHub publication preview"));
}

function validateStore(store) {
  return Object.freeze({
    list:assertOwnDataFunction(store,"list","Artifact store").bind(store),
    verify:assertOwnDataFunction(store,"verify","Artifact store").bind(store),
    append:assertOwnDataFunction(store,"append","Artifact store").bind(store),
  });
}

function artifactIdentity(artifact) {
  return canonicalJson({
    document_type:artifact.document_type,
    artifact_id:artifact.artifact_id,
    revision:artifact.revision,
  });
}

function validatePublicationArtifact(artifact,label) {
  const validation=validateDocument(artifact,"github-publication-result.v1");
  if (!validation.valid) {
    throw new GitHubPublicationError(
      `${label} is corrupt or has an unknown publication-result version: ${
        validation.errors[0]?.message ?? "contract failure"}`,
    );
  }
  if (artifact.content_sha256!==sha256Canonical(artifact.content)) {
    throw new GitHubPublicationError(`${label} content hash is corrupt`);
  }
  if (artifact.provenance.source_revision!==artifact.content.source_revision ||
      artifact.provenance.source_sha256!==artifact.content.source_sha256) {
    throw new GitHubPublicationError(`${label} has conflicting source provenance`);
  }
}

function validateHistorySemantics(history,trustedRegistry) {
  const identities=new Set();
  const byArtifact=new Map();
  const localFacts=new Map();
  const numberFacts=new Map();
  const urlFacts=new Map();
  const approvals=new Map();
  for (const artifact of history) {
    const identity=artifactIdentity(artifact);
    if (identities.has(identity)) throw new GitHubPublicationError("Publication store history duplicates an artifact identity");
    identities.add(identity);
    const groupKey=`${artifact.document_type}\u0000${artifact.artifact_id}`;
    if (!byArtifact.has(groupKey)) byArtifact.set(groupKey,[]);
    byArtifact.get(groupKey).push(artifact);

    const approval=artifact.content.approval_record;
    let verifiedApproval;
    try {
      verifiedApproval=canonicalApproval(approval,{
        repository:artifact.content.repository,
        source_revision:artifact.content.source_revision,
        source_sha256:artifact.content.source_sha256,
        issue_plan:artifact.content.issue_plan,
      },trustedRegistry);
    } catch (error) {
      throw new GitHubPublicationError("Historical publication approval signature is invalid",{
        cause:error,
      });
    }
    if (!same(artifact.content.authority_registry,verifiedApproval.authority_registry)) {
      throw new GitHubPublicationError(
        "Historical publication authority registry provenance conflicts with trusted registry",
      );
    }
    const approvalKey=canonicalJson({
      record_id:approval.record_id,
      record_revision:approval.record_revision,
    });
    const existingApproval=approvals.get(approvalKey);
    if (existingApproval && !same(existingApproval,approval)) {
      throw new GitHubPublicationError("Publication approval record conflicts or was replayed");
    }
    approvals.set(approvalKey,approval);

    const seenLocals=new Set();
    const orderedLocals=[];
    for (const mapping of artifact.content.mappings) {
      if (seenLocals.has(mapping.local_issue_id)) {
        throw new GitHubPublicationError("Publication result duplicates a local issue mapping");
      }
      seenLocals.add(mapping.local_issue_id);
      orderedLocals.push(mapping.local_issue_id);
      const fact={
        repository:artifact.content.repository,
        source_revision:artifact.content.source_revision,
        source_sha256:artifact.content.source_sha256,
        issue_plan:artifact.content.issue_plan,
        ...mapping,
      };
      const localKey=canonicalJson({
        repository:fact.repository,
        issue_plan:fact.issue_plan,
        local_issue_id:mapping.local_issue_id,
      });
      for (const [key,map] of [
        [localKey,localFacts],
        [canonicalJson({repository:fact.repository,number:mapping.number}),numberFacts],
        [mapping.url,urlFacts],
      ]) {
        const existing=map.get(key);
        if (existing && !same(existing,fact)) {
          throw new GitHubPublicationError("Publication mapping conflicts with immutable history");
        }
        map.set(key,fact);
      }
    }
    if (!same(orderedLocals,[...orderedLocals].sort())) {
      throw new GitHubPublicationError("Publication result mappings must be canonically sorted");
    }
    const failureKeys=[];
    const failureIssueIds=new Set();
    for (const failure of artifact.content.failures) {
      if (seenLocals.has(failure.local_issue_id)) {
        throw new GitHubPublicationError("Publication failure cannot identify an already mapped issue");
      }
      if (failureIssueIds.has(failure.local_issue_id)) {
        throw new GitHubPublicationError("Publication result duplicates a failed local issue");
      }
      failureIssueIds.add(failure.local_issue_id);
      failureKeys.push(`${failure.local_issue_id}\u0000${failure.code}`);
    }
    if (new Set(failureKeys).size!==failureKeys.length ||
        !same(failureKeys,[...failureKeys].sort())) {
      throw new GitHubPublicationError("Publication failures must be unique and canonically sorted");
    }
    if (artifact.content.failures.length>1) {
      throw new GitHubPublicationError("Publication result may record only one active failure");
    }
    if (artifact.content.status==="complete" && artifact.content.failures.length!==0) {
      throw new GitHubPublicationError("Complete publication result cannot contain failures");
    }
  }
  for (const revisions of byArtifact.values()) {
    revisions.sort((left,right) => left.revision-right.revision);
    let cumulative=new Map();
    for (const [index,artifact] of revisions.entries()) {
      if (artifact.revision!==index+1) {
        throw new GitHubPublicationError("Publication store history has a stale or missing revision");
      }
      if (index===0 && artifact.parents.length!==0) {
        throw new GitHubPublicationError("Publication result revision 1 has corrupt parents");
      }
      if (index>0 && (artifact.parents.length!==1 ||
          !same(artifact.parents[0],exactReference(revisions[index-1])))) {
        throw new GitHubPublicationError("Publication result parent history is corrupt");
      }
      const current=new Map(artifact.content.mappings.map(mapping => [
        mapping.local_issue_id,mapping,
      ]));
      for (const [localIssueId,mapping] of cumulative) {
        if (!current.has(localIssueId) || !same(current.get(localIssueId),mapping)) {
          throw new GitHubPublicationError(
            "Publication result mappings must be a cumulative immutable superset",
          );
        }
      }
      cumulative=current;
    }
  }
}

async function loadHistory(store,trustedRegistry) {
  let listed;
  try {
    listed=canonicalCopy(
      await store.list({document_type:"github-publication-result"}),
      "Artifact store publication history",
    );
  } catch (error) {
    if (error instanceof GitHubPublicationError) throw error;
    throw new GitHubPublicationError("Artifact store publication history is unavailable",{
      code:"ARTIFACT_STORE_FAILED",
      cause:error,
    });
  }
  if (!Array.isArray(listed)) {
    throw new GitHubPublicationError("Artifact store publication history must be an array");
  }
  const history=[];
  for (const [index,artifact] of listed.entries()) {
    validatePublicationArtifact(artifact,`Publication history[${index}]`);
    let verified;
    try {
      verified=canonicalCopy(
        await store.verify(exactReference(artifact)),
        `Verified publication history[${index}]`,
      );
    } catch (error) {
      throw new GitHubPublicationError("Artifact store publication history verification failed",{
        code:"ARTIFACT_STORE_FAILED",
        cause:error,
      });
    }
    if (!same(verified,artifact)) {
      throw new GitHubPublicationError("Artifact store returned conflicting verified history");
    }
    history.push(artifact);
  }
  validateHistorySemantics(history,trustedRegistry);
  return history.sort((left,right) =>
    left.artifact_id.localeCompare(right.artifact_id) || left.revision-right.revision,
  );
}

function publicationArtifactId(context) {
  return `github-publication-${sha256Canonical({
    repository:context.repository,
    issue_plan:exactReference(context.artifacts.issuePlan),
  }).slice(0,24)}`;
}

function currentHistory(history,context,gates) {
  const id=publicationArtifactId(context);
  const plan=exactReference(context.artifacts.issuePlan);
  const source=context.artifacts.issuePlan.provenance;
  const issueIds=context.artifacts.issuePlan.content.issues.map(issue => issue.id).sort();
  const allowedIssueIds=new Set(issueIds);
  const revisions=history.filter(artifact => artifact.artifact_id===id);
  const exactInputs=[
    exactReference(plan),
    exactReference(gates.audit),
    exactReference(context.artifacts.analysisState),
    ...gates.designInputs,
  ].sort((left,right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  for (const artifact of revisions) {
    if (artifact.content.repository!==context.repository ||
        !same(artifact.content.issue_plan,plan) ||
        artifact.content.source_revision!==source.source_revision ||
        artifact.content.source_sha256!==source.source_sha256) {
      throw new GitHubPublicationError("Publication history mixes stale source or issue-plan facts");
    }
    if (!same(artifact.inputs,exactInputs)) {
      throw new GitHubPublicationError(
        "Publication result gate inputs must be the exact plan, audit, and state references",
      );
    }
    const mappedIds=artifact.content.mappings.map(mapping => mapping.local_issue_id).sort();
    for (const mapping of artifact.content.mappings) {
      if (!allowedIssueIds.has(mapping.local_issue_id)) {
        throw new GitHubPublicationError("Publication result maps an unknown local issue");
      }
      if (mapping.marker!==issueMarker(
        context.repository,
        context.artifacts.issuePlan,
        mapping.local_issue_id,
      )) {
        throw new GitHubPublicationError("Publication result contains a conflicting issue marker");
      }
      if (mapping.url!==`https://github.com/${context.repository}/issues/${mapping.number}`) {
        throw new GitHubPublicationError("Publication result contains a conflicting GitHub URL");
      }
    }
    for (const failure of artifact.content.failures) {
      if (!allowedIssueIds.has(failure.local_issue_id)) {
        throw new GitHubPublicationError("Publication result fails an unknown local issue");
      }
    }
    if (artifact.content.status==="complete" &&
        (!same(mappedIds,issueIds) || artifact.content.failures.length!==0)) {
      throw new GitHubPublicationError(
        "Publication completion claim does not contain the exact issue mappings",
      );
    }
    if (artifact.content.status==="retryable" && same(mappedIds,issueIds)) {
      throw new GitHubPublicationError(
        "Retryable publication result cannot contain every completed mapping",
      );
    }
  }
  return revisions.sort((left,right) => left.revision-right.revision);
}

function mappingsFromHistory(history) {
  const mappings=new Map();
  for (const artifact of history) {
    for (const mapping of artifact.content.mappings) {
      const existing=mappings.get(mapping.local_issue_id);
      if (existing && !same(existing,mapping)) {
        throw new GitHubPublicationError("Publication history conflicts for a local issue mapping");
      }
      mappings.set(mapping.local_issue_id,mapping);
    }
  }
  return mappings;
}

function publicationContent(context,authority,mappings,failures,status) {
  const plan=context.artifacts.issuePlan;
  return {
    status,
    repository:context.repository,
    source_revision:plan.provenance.source_revision,
    source_sha256:plan.provenance.source_sha256,
    issue_plan:exactReference(plan),
    authority_registry:authority.authority_registry,
    approval_record:authority.approval,
    mappings:[...mappings.values()].sort((left,right) =>
      left.local_issue_id.localeCompare(right.local_issue_id),
    ),
    failures:[...failures].sort((left,right) =>
      left.local_issue_id.localeCompare(right.local_issue_id) ||
      left.code.localeCompare(right.code),
    ),
  };
}

function publicationDraft(context,gates,approval,current,content) {
  const plan=context.artifacts.issuePlan;
  const previous=current.at(-1);
  const inputs=[
    exactReference(plan),
    exactReference(gates.audit),
    exactReference(context.artifacts.analysisState),
    ...gates.designInputs,
  ].sort((left,right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return {
    schema_version:"acp.v1",
    document_type:"github-publication-result",
    artifact_id:publicationArtifactId(context),
    revision:(previous?.revision ?? 0)+1,
    run_id:`${plan.run_id}:github-publication`,
    producer:{role:"issue-publisher",identity:"toss-github-writer"},
    runtime_identity:canonicalCopy(plan.runtime_identity,"Issue-plan runtime identity"),
    created_at:approval.timestamp,
    provenance:{
      source_revision:plan.provenance.source_revision,
      source_sha256:plan.provenance.source_sha256,
      locations:[
        `github:${context.repository}`,
        `issue-plan:${plan.artifact_id}@${plan.revision}#${plan.content_sha256}`,
      ],
    },
    parents:previous ? [exactReference(previous)] : [],
    inputs,
    content_sha256:sha256Canonical(content),
    content,
  };
}

async function persist(
  store,
  context,
  gates,
  approval,
  current,
  history,
  trustedRegistry,
  content,
) {
  const previous=current.at(-1);
  if (previous && same(previous.content,content)) return previous;
  const draft=publicationDraft(context,gates,approval,current,content);
  const validation=validateDocument(draft,"github-publication-result.v1");
  if (!validation.valid) {
    throw new GitHubPublicationError(
      `Publication result construction failed: ${validation.errors[0]?.message}`,
    );
  }
  validateHistorySemantics([...history,draft],trustedRegistry);
  let appended;
  try {
    appended=canonicalCopy(await store.append(draft),"Appended publication result");
  } catch (error) {
    throw new GitHubPublicationError("Artifact store append failed after GitHub publication",{
      code:"ARTIFACT_STORE_FAILED",
      cause:error,
    });
  }
  validatePublicationArtifact(appended,"Appended publication result");
  if (!same(appended,draft)) {
    throw new GitHubPublicationError("Artifact store returned a conflicting appended result");
  }
  let verified;
  try {
    verified=canonicalCopy(
      await store.verify(exactReference(appended)),
      "Verified appended publication result",
    );
  } catch (error) {
    throw new GitHubPublicationError(
      "Artifact store verification failed after publication append",
      {code:"ARTIFACT_STORE_FAILED",cause:error},
    );
  }
  validatePublicationArtifact(verified,"Verified appended publication result");
  if (!same(verified,appended)) {
    throw new GitHubPublicationError("Artifact store returned conflicting verified persistence");
  }
  current.push(verified);
  history.push(verified);
  return verified;
}

function operationPayload(operation) {
  return {
    repository:operation.repository,
    marker:operation.marker,
    title:operation.title,
    body:operation.body,
    labels:operation.labels,
    milestone:operation.milestone,
  };
}

function remoteMatches(remote,payload) {
  return remote.repository===payload.repository &&
    remote.marker===payload.marker &&
    remote.title===payload.title &&
    remote.body===payload.body &&
    same(remote.labels,payload.labels) &&
    remote.milestone===payload.milestone;
}

function mappingFor(operation,remote) {
  return {
    local_issue_id:operation.local_issue_id,
    number:remote.number,
    url:remote.url,
    marker:operation.marker,
  };
}

function claimMapping(mapping,repository,owner,numberClaims,urlClaims,label) {
  for (const [identity,claimKey,claims] of [
    ["number",canonicalJson({repository,number:mapping.number}),numberClaims],
    ["URL",mapping.url,urlClaims],
  ]) {
    const claimedBy=claims.get(claimKey);
    if (claimedBy!==undefined && claimedBy.key!==owner.key) {
      throw new GitHubPublicationError(
        `${label} ${identity} is claimed by multiple local issues: ${
          claimedBy.label} and ${owner.label}`,
      );
    }
    claims.set(claimKey,owner);
  }
}

function retryableFailure(error,localIssueId) {
  const codeDescriptor=error && typeof error==="object" ?
    Object.getOwnPropertyDescriptor(error,"code") : undefined;
  const messageDescriptor=error && typeof error==="object" ?
    Object.getOwnPropertyDescriptor(error,"message") : undefined;
  const rawCode=codeDescriptor && "value" in codeDescriptor ? codeDescriptor.value : undefined;
  if (!RETRYABLE_CODES.has(rawCode)) return undefined;
  const code=rawCode;
  const message=messageDescriptor && "value" in messageDescriptor &&
    typeof messageDescriptor.value==="string" && messageDescriptor.value.length>0 ?
    messageDescriptor.value : "GitHub publication failed with a retryable error";
  return {local_issue_id:localIssueId,code,message,retryable:true};
}

function publicResult(context,preview,status,mappings,failures,artifact) {
  const result={
    schema_version:"github-publication-result.v1",
    document_type:"github-publication-result",
    status,
    repository:context.repository,
    source_revision:preview.source_revision,
    source_sha256:preview.source_sha256,
    issue_plan:preview.issue_plan,
    operations:preview.operations,
    mappings:[...mappings.values()].sort((left,right) =>
      left.local_issue_id.localeCompare(right.local_issue_id),
    ),
    failures:[...failures],
    artifact,
  };
  return deepFreeze(canonicalCopy(result,"GitHub publication result"));
}

export function createGitHubWriter({adapter,store,authorityRegistry}={}) {
  const github=validateGitHubAdapter(adapter);
  const artifacts=validateStore(store);
  const configuredAuthority=canonicalAuthorityRegistry(authorityRegistry);

  async function preview(value) {
    const context=canonicalContext(value);
    assertIndependentGates(context,configuredAuthority.registry);
    return previewFor(context);
  }

  async function publish(value,{apply=false,authority}={}) {
    const context=canonicalContext(value);
    if (apply!==true) {
      if (apply!==false) throw new TypeError("GitHub publication apply must be a boolean");
      assertIndependentGates(context,configuredAuthority.registry);
      return previewFor(context);
    }
    const plan=context.artifacts.issuePlan;
    const trusted=canonicalApproval(authority,{
      repository:context.repository,
      source_revision:plan.provenance.source_revision,
      source_sha256:plan.provenance.source_sha256,
      issue_plan:exactReference(plan),
    },configuredAuthority);
    const gates=assertIndependentGates(context,configuredAuthority.registry);
    const desired=previewFor(context);
    const history=await loadHistory(artifacts,configuredAuthority);
    const current=currentHistory(history,context,gates);
    const approvalKey=canonicalJson({
      record_id:trusted.approval.record_id,
      record_revision:trusted.approval.record_revision,
    });
    for (const artifact of history) {
      const recorded=artifact.content.approval_record;
      const recordedKey=canonicalJson({
        record_id:recorded.record_id,
        record_revision:recorded.record_revision,
      });
      if (recordedKey===approvalKey && !same(recorded,trusted.approval)) {
        throw new GitHubPublicationError("Publication approval record conflicts or was replayed");
      }
    }
    const mappings=mappingsFromHistory(current);
    let latest=current.at(-1);
    const numberClaims=new Map();
    const urlClaims=new Map();
    const ownerFor=(repository,issuePlan,localIssueId) => ({
      key:canonicalJson({repository,issue_plan:issuePlan,local_issue_id:localIssueId}),
      label:`${repository}:${issuePlan.artifact_id}@${issuePlan.revision}:${localIssueId}`,
    });
    const currentPlan=exactReference(context.artifacts.issuePlan);
    for (const artifact of history) {
      for (const mapping of artifact.content.mappings) {
        claimMapping(
          mapping,
          artifact.content.repository,
          ownerFor(
            artifact.content.repository,
            artifact.content.issue_plan,
            mapping.local_issue_id,
          ),
          numberClaims,
          urlClaims,
          "Immutable publication mapping",
        );
      }
    }

    async function transientResult(failure) {
      if (mappings.has(failure.local_issue_id)) {
        if (!latest) {
          throw new GitHubPublicationError(
            "Publication mappings exist without an immutable result artifact",
          );
        }
        return publicResult(context,desired,"retryable",mappings,[failure],latest);
      }
      const content=publicationContent(context,trusted,mappings,[failure],"retryable");
      latest=await persist(
        artifacts,context,gates,trusted.approval,current,history,
        configuredAuthority,content,
      );
      return publicResult(context,desired,"retryable",mappings,[failure],latest);
    }

    const reconciled=[];
    for (const operation of desired.operations) {
      const payload=operationPayload(operation);
      let matches;
      try {
        matches=normalizeMarkerMatches(await github.findByMarker(operation.marker),{
          repository:context.repository,
          marker:operation.marker,
        });
      } catch (error) {
        const failure=retryableFailure(error,operation.local_issue_id);
        if (!failure) throw error;
        return transientResult(failure);
      }
      if (matches.length>1) {
        throw new GitHubPublicationError(
          `Multiple duplicate GitHub issues contain marker for ${operation.local_issue_id}`,
        );
      }
      const recorded=mappings.get(operation.local_issue_id);
      if (recorded && matches.length===0) {
        throw new GitHubPublicationError(
          `Recorded GitHub mapping for ${operation.local_issue_id} is missing its marker`,
        );
      }
      let remote=matches[0];
      if (recorded && remote &&
          (recorded.number!==remote.number || recorded.url!==remote.url ||
            recorded.marker!==remote.marker)) {
        throw new GitHubPublicationError(
          `GitHub marker conflicts with immutable mapping for ${operation.local_issue_id}`,
        );
      }
      if (remote) {
        claimMapping(
          mappingFor(operation,remote),
          context.repository,
          ownerFor(context.repository,currentPlan,operation.local_issue_id),
          numberClaims,
          urlClaims,
          "Remote preflight mapping",
        );
      }
      reconciled.push({operation,payload,recorded,remote});
    }

    for (const reconciliation of reconciled) {
      const {operation,payload,recorded}=reconciliation;
      let {remote}=reconciliation;
      try {
        if (!remote) {
          remote=normalizeRemoteIssue(await github.createIssue(payload),{
            repository:context.repository,
            marker:operation.marker,
            label:`GitHub create result for ${operation.local_issue_id}`,
          });
          if (!remoteMatches(remote,payload)) {
            throw new GitHubPublicationError(
              `GitHub create result does not exactly match desired issue for ${
                operation.local_issue_id}`,
            );
          }
        } else if (!remoteMatches(remote,payload)) {
          remote=normalizeRemoteIssue(await github.updateIssue(remote.number,payload),{
            repository:context.repository,
            marker:operation.marker,
            label:`GitHub update result for ${operation.local_issue_id}`,
          });
          if (!remoteMatches(remote,payload)) {
            throw new GitHubPublicationError(
              `GitHub update result does not exactly match desired issue for ${
                operation.local_issue_id}`,
            );
          }
        }
      } catch (error) {
        const failure=retryableFailure(error,operation.local_issue_id);
        if (!failure) throw error;
        return transientResult(failure);
      }
      const mapping=mappingFor(operation,remote);
      claimMapping(
        mapping,
        context.repository,
        ownerFor(context.repository,currentPlan,operation.local_issue_id),
        numberClaims,
        urlClaims,
        "Verified remote mapping",
      );
      if (recorded && !same(recorded,mapping)) {
        throw new GitHubPublicationError(
          `Verified remote fact conflicts with mapping for ${operation.local_issue_id}`,
        );
      }
      mappings.set(operation.local_issue_id,mapping);
      const status=mappings.size===desired.operations.length ? "complete" : "retryable";
      const content=publicationContent(context,trusted,mappings,[],status);
      latest=await persist(
        artifacts,context,gates,trusted.approval,current,history,
        configuredAuthority,content,
      );
    }
    return publicResult(context,desired,"complete",mappings,[],latest);
  }

  return Object.freeze({preview,publish});
}
