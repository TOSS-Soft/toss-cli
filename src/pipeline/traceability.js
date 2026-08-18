import {
  assertStableEntityMeanings,
  canonicalJson,
} from "../contracts/acp.js";
import {validateDocument} from "../contracts/validator.js";
import {auditSpecification} from "./spec-auditor.js";

const INPUT_KEYS=Object.freeze(["architecture","issuePlan","pmAnalysis"]);
const OPTIONAL_INPUT_KEYS=new Set(["approvals","decisionAnswers","decisionPackage"]);
const ARCHITECTURE_KEYS=Object.freeze(["adrs","artifact"]);
const ROOT_TYPES=new Set(["REQ","NFR","BR"]);
const REQUIREMENT_TYPES=new Set(["REQ","NFR"]);
const TYPE_ORDER=new Map([
  "REQ","NFR","BR","ARCHQ","ADR","EPIC","ISSUE","AC",
].map((type,index) => [type,index]));
const EDGE_ENDPOINTS=Object.freeze({
  ADDRESSES:[new Set(["REQ","NFR"]),new Set(["ARCHQ"])],
  RESOLVED_BY:[new Set(["ARCHQ"]),new Set(["ADR"])],
  AFFECTS:[new Set(["REQ","NFR"]),new Set(["ADR"])],
  SCOPES:[new Set(["REQ","NFR"]),new Set(["EPIC"])],
  SOURCE_REQUIREMENT:[new Set(["REQ","NFR"]),new Set(["ISSUE"])],
  REQUIRES_DECISION:[new Set(["ADR"]),new Set(["ISSUE"])],
  CONTAINS:[new Set(["EPIC"]),new Set(["ISSUE"])],
  BLOCKS:[new Set(["ISSUE"]),new Set(["ISSUE"])],
  OWNS:[new Set(["ISSUE"]),new Set(["AC"])],
  VERIFIED_BY:[new Set(["REQ","NFR"]),new Set(["AC"])],
});
const NODE_SOURCE_DOCUMENT_TYPE=Object.freeze({
  REQ:"pm-analysis",
  NFR:"pm-analysis",
  BR:"pm-analysis",
  ARCHQ:"pm-analysis",
  ADR:"adr",
  EPIC:"issue-plan",
  ISSUE:"issue-plan",
  AC:"issue-plan",
});
const EDGE_SOURCE_DOCUMENT_TYPE=Object.freeze({
  ADDRESSES:"pm-analysis",
  RESOLVED_BY:"adr",
  AFFECTS:"adr",
  SCOPES:"issue-plan",
  SOURCE_REQUIREMENT:"issue-plan",
  REQUIRES_DECISION:"issue-plan",
  CONTAINS:"issue-plan",
  BLOCKS:"issue-plan",
  OWNS:"issue-plan",
  VERIFIED_BY:"issue-plan",
});
const authoritativeGraphs=new WeakSet();

export class TraceabilityInputError extends TypeError {
  constructor(message,{cause}={}) {
    super(message,{cause});
    this.name="TraceabilityInputError";
    this.code="TRACE_INPUT_INVALID";
  }
}

export class TraceEntityNotFoundError extends Error {
  constructor(entityId) {
    super(`Trace entity not found: ${String(entityId)}`);
    this.name="TraceEntityNotFoundError";
    this.code="TRACE_ENTITY_NOT_FOUND";
  }
}

function compareText(left,right) {
  if (left===right) return 0;
  return left<right ? -1 : 1;
}

function canonicalCopy(value,label="value") {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw new TraceabilityInputError(
      `${label} must be canonical JSON: ${error instanceof Error ? error.message : String(error)}`,
      {cause:error},
    );
  }
}

function deepFreeze(value) {
  if (!value || typeof value!=="object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isPlainObject(value) {
  if (!value || typeof value!=="object" || Array.isArray(value)) return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype || prototype===null;
}

function assertExactKeys(value,expected,label) {
  if (!isPlainObject(value)) {
    throw new TraceabilityInputError(`${label} must be a plain JSON object`);
  }
  const actual=Object.keys(value).sort(compareText);
  if (actual.length!==expected.length ||
      actual.some((key,index) => key!==expected[index])) {
    const extras=actual.filter(key => !expected.includes(key));
    const missing=expected.filter(key => !actual.includes(key));
    throw new TraceabilityInputError(
      `${label} has unknown, extra, or missing properties`+
      `${extras.length ? `; extra: ${extras.join(", ")}` : ""}`+
      `${missing.length ? `; missing: ${missing.join(", ")}` : ""}`,
    );
  }
}

function artifactReference(artifact) {
  return {
    document_type:artifact.document_type,
    artifact_id:artifact.artifact_id,
    revision:artifact.revision,
    content_sha256:artifact.content_sha256,
  };
}

function artifactIdentity(reference) {
  try {
    return canonicalJson({
      document_type:reference.document_type,
      artifact_id:reference.artifact_id,
      revision:reference.revision,
    });
  } catch (error) {
    throw new TraceabilityInputError(
      "Trace input snapshot identity must declare document_type, artifact_id, and revision",
      {cause:error},
    );
  }
}

function sourceFor(artifact,path) {
  return {artifact:artifactReference(artifact),path};
}

function nodeFor(entity,type,artifact,path) {
  return {
    id:entity.id,
    type,
    kind:entity.kind,
    meaning:entity.meaning,
    provenance:entity.provenance ?? artifact.provenance,
    source:sourceFor(artifact,path),
  };
}

function nodeSort(left,right) {
  return compareText(left.id,right.id);
}

function edgeSort(left,right) {
  return compareText(left.from,right.from) ||
    compareText(left.to,right.to) ||
    compareText(left.type,right.type) ||
    compareText(canonicalJson(left.source),canonicalJson(right.source));
}

function traversalSort(left,right) {
  return (TYPE_ORDER.get(left.type)-TYPE_ORDER.get(right.type)) ||
    compareText(left.id,right.id);
}

function formatValidationErrors(errors) {
  return errors.map(error => {
    const missing=error.keyword==="required" ? error.params?.missingProperty : undefined;
    const path=missing===undefined ? error.instancePath :
      `${error.instancePath}/${String(missing)}`;
    return `${path || "/"} ${error.message ?? "is invalid"}`;
  }).join("; ");
}

function assertNoCycle(nodes,edges) {
  const outgoing=new Map(nodes.map(node => [node.id,[]]));
  for (const edge of edges) outgoing.get(edge.from).push(edge.to);
  for (const targets of outgoing.values()) targets.sort(compareText);
  const visiting=new Set();
  const visited=new Set();

  function visit(id,trail) {
    if (visiting.has(id)) {
      const start=trail.indexOf(id);
      throw new TraceabilityInputError(
        `Traceability cycle detected: ${[...trail.slice(start),id].join(" -> ")}`,
      );
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of outgoing.get(id)) visit(target,[...trail,id]);
    visiting.delete(id);
    visited.add(id);
  }

  for (const node of nodes) visit(node.id,[]);
}

function hasEdge(edges,{from,to,type}) {
  return edges.some(edge =>
    (from===undefined || edge.from===from) &&
    (to===undefined || edge.to===to) &&
    (type===undefined || edge.type===type),
  );
}

function assertNoDownstreamOrphans(nodes,edges) {
  for (const node of nodes) {
    if (ROOT_TYPES.has(node.type)) continue;
    let traced=false;
    if (node.type==="ARCHQ") {
      traced=hasEdge(edges,{to:node.id,type:"ADDRESSES"}) &&
        hasEdge(edges,{from:node.id,type:"RESOLVED_BY"});
    } else if (node.type==="ADR") {
      traced=hasEdge(edges,{to:node.id,type:"RESOLVED_BY"}) &&
        hasEdge(edges,{from:node.id,type:"REQUIRES_DECISION"});
    } else if (node.type==="EPIC") {
      traced=hasEdge(edges,{to:node.id,type:"SCOPES"}) &&
        hasEdge(edges,{from:node.id,type:"CONTAINS"});
    } else if (node.type==="ISSUE") {
      traced=edges.some(edge => edge.to===node.id && [
        "SOURCE_REQUIREMENT","REQUIRES_DECISION","CONTAINS","BLOCKS",
      ].includes(edge.type)) && hasEdge(edges,{from:node.id,type:"OWNS"});
    } else if (node.type==="AC") {
      traced=hasEdge(edges,{to:node.id,type:"OWNS"}) &&
        hasEdge(edges,{to:node.id,type:"VERIFIED_BY"});
    }
    if (!traced) {
      throw new TraceabilityInputError(`Orphan traceability node ${node.id}`);
    }
  }
}

function assertExactSourceBindings(graph) {
  const snapshots=graph.input_snapshots;
  const references=[
    snapshots.pm_analysis,
    snapshots.architecture,
    ...snapshots.adrs,
    snapshots.issue_plan,
  ];
  const referenceKeys=new Set();
  const identityKeys=new Set();
  for (const reference of references) {
    const key=canonicalJson(reference);
    if (referenceKeys.has(key)) {
      throw new TraceabilityInputError("Duplicate exact trace input snapshot");
    }
    referenceKeys.add(key);
    const identityKey=artifactIdentity(reference);
    if (identityKeys.has(identityKey)) {
      throw new TraceabilityInputError(
        "Duplicate trace input snapshot identity independent of content hash",
      );
    }
    identityKeys.add(identityKey);
  }
  const adrNodeCounts=new Map(snapshots.adrs.map(adr => [canonicalJson(adr),0]));
  for (const [kind,items] of [["node",graph.nodes],["edge",graph.edges]]) {
    for (const item of items) {
      const source=item.source.artifact;
      if (!referenceKeys.has(canonicalJson(source))) {
        throw new TraceabilityInputError(
          `Trace ${kind} source is not bound to an exact input snapshot`,
        );
      }
      const expected=kind==="node" ?
        NODE_SOURCE_DOCUMENT_TYPE[item.type] : EDGE_SOURCE_DOCUMENT_TYPE[item.type];
      if (source.document_type!==expected) {
        throw new TraceabilityInputError(
          `Trace ${kind} source document type must be ${expected}`,
        );
      }
      if (kind==="node" && item.type==="ADR") {
        const key=canonicalJson(source);
        adrNodeCounts.set(key,(adrNodeCounts.get(key) ?? 0)+1);
      }
    }
  }
  for (const adr of snapshots.adrs) {
    const count=adrNodeCounts.get(canonicalJson(adr));
    if (count!==1) {
      throw new TraceabilityInputError(
        `ADR input snapshot ${adr.artifact_id}@${adr.revision} must back exactly one ADR node`,
      );
    }
  }
}

function assertGraph(graph) {
  const validation=validateDocument(graph,"trace-graph.v1");
  if (!validation.valid) {
    throw new TraceabilityInputError(
      `Invalid trace graph schema: ${formatValidationErrors(validation.errors)}`,
    );
  }
  assertExactSourceBindings(graph);
  const byId=new Map();
  for (const node of graph.nodes) {
    if (byId.has(node.id)) {
      const previous=byId.get(node.id);
      const same=canonicalJson({type:previous.type,kind:previous.kind,meaning:previous.meaning})===
        canonicalJson({type:node.type,kind:node.kind,meaning:node.meaning});
      throw new TraceabilityInputError(
        same ? `Duplicate trace node ID ${node.id}` :
          `Trace node ID ${node.id} has conflicting stable meaning`,
      );
    }
    byId.set(node.id,node);
  }
  const edgeKeys=new Set();
  for (const edge of graph.edges) {
    const from=byId.get(edge.from);
    const to=byId.get(edge.to);
    if (!from || !to) {
      throw new TraceabilityInputError(
        `Dangling trace edge ${edge.from} -> ${edge.to}`,
      );
    }
    if (edge.from===edge.to) {
      throw new TraceabilityInputError(`Self trace edge creates a cycle at ${edge.from}`);
    }
    const endpoints=EDGE_ENDPOINTS[edge.type];
    if (!endpoints?.[0].has(from.type) || !endpoints[1].has(to.type)) {
      throw new TraceabilityInputError(
        `Trace edge ${edge.type} has invalid typed endpoints ${from.type} -> ${to.type}`,
      );
    }
    const key=canonicalJson({from:edge.from,to:edge.to,type:edge.type});
    if (edgeKeys.has(key)) {
      throw new TraceabilityInputError(
        `Duplicate trace edge ${edge.from} -> ${edge.to} (${edge.type})`,
      );
    }
    edgeKeys.add(key);
  }
  assertNoCycle(graph.nodes,graph.edges);
  assertNoDownstreamOrphans(graph.nodes,graph.edges);
  return byId;
}

function normalizedInputs(artifacts) {
  const normalized=canonicalCopy(artifacts,"trace artifacts");
  const keys=Object.keys(normalized).sort();
  if (!INPUT_KEYS.every(key => Object.hasOwn(normalized,key)) ||
      keys.some(key => !INPUT_KEYS.includes(key) && !OPTIONAL_INPUT_KEYS.has(key))) {
    throw new TraceabilityInputError(
      "trace artifacts contain an unknown or extra property outside exact PM, architecture, plan, and optional approval evidence",
    );
  }
  normalized.approvals=normalized.approvals ?? [];
  normalized.decisionAnswers=normalized.decisionAnswers ?? [];
  assertExactKeys(normalized.architecture,ARCHITECTURE_KEYS,
    "trace artifacts architecture");
  if (!Array.isArray(normalized.architecture.adrs)) {
    throw new TraceabilityInputError("trace artifacts architecture.adrs must be an array");
  }
  return normalized;
}

function assertUniqueInputSnapshotIdentities(artifacts) {
  const references=[
    artifacts.pmAnalysis,
    artifacts.architecture.artifact,
    ...artifacts.architecture.adrs,
    ...artifacts.approvals,
    ...artifacts.decisionAnswers,
    artifacts.issuePlan,
  ];
  const identities=new Set();
  for (const reference of references) {
    const identity=artifactIdentity(reference);
    if (identities.has(identity)) {
      throw new TraceabilityInputError(
        "Duplicate trace input snapshot identity independent of content hash",
      );
    }
    identities.add(identity);
  }
}

function assertUpstream(artifacts) {
  let audit;
  try {
    audit=auditSpecification(artifacts);
  } catch (error) {
    throw new TraceabilityInputError(
      `Invalid trace upstream artifacts: ${error instanceof Error ? error.message : String(error)}`,
      {cause:error},
    );
  }
  if (audit.status==="FAIL") {
    const findings=audit.findings.map(finding =>
      `${finding.type}: ${finding.message ?? "specification audit failed"}`,
    );
    throw new TraceabilityInputError(
      `Invalid trace upstream artifacts: ${findings.join("; ")}`,
    );
  }
}

function assertStableInputs(artifacts) {
  const pm=artifacts.pmAnalysis.content;
  const architecture=artifacts.architecture;
  assertStableEntityMeanings([
    ...pm.functional_requirements,
    ...pm.non_functional_requirements,
    ...pm.constraints,
    ...pm.business_rules,
    ...pm.architecture_questions,
    ...pm.epic_candidates,
    ...architecture.adrs.map(adr => adr.content),
    ...artifacts.issuePlan.content.epics,
    ...artifacts.issuePlan.content.issues,
    ...artifacts.issuePlan.content.acceptance_criteria,
  ]);
}

export function buildTraceGraph(artifacts) {
  const input=normalizedInputs(artifacts);
  assertUniqueInputSnapshotIdentities(input);
  assertUpstream(input);
  try {
    assertStableInputs(input);
  } catch (error) {
    throw new TraceabilityInputError(
      `Trace identities must have globally stable meaning: ${error.message}`,
      {cause:error},
    );
  }

  const pm=input.pmAnalysis;
  const architecture=input.architecture.artifact;
  const adrs=[...input.architecture.adrs].sort((left,right) =>
    compareText(left.content.id,right.content.id));
  const plan=input.issuePlan;
  const nodes=[];
  for (const [section,type] of [
    ["functional_requirements","REQ"],
    ["non_functional_requirements","NFR"],
    ["constraints","NFR"],
    ["business_rules","BR"],
    ["architecture_questions","ARCHQ"],
  ]) {
    for (const [index,entity] of pm.content[section].entries()) {
      nodes.push(nodeFor(entity,type,pm,`/content/${section}/${index}`));
    }
  }
  for (const [index,adr] of adrs.entries()) {
    nodes.push(nodeFor(adr.content,"ADR",adr,"/content"));
  }
  for (const [section,type] of [
    ["epics","EPIC"],
    ["issues","ISSUE"],
    ["acceptance_criteria","AC"],
  ]) {
    for (const [index,entity] of plan.content[section].entries()) {
      nodes.push(nodeFor(entity,type,plan,`/content/${section}/${index}`));
    }
  }
  nodes.sort(nodeSort);
  const knownIds=new Set(nodes.map(node => node.id));
  if (knownIds.size!==nodes.length) {
    throw new TraceabilityInputError("Trace graph contains duplicate global entity IDs");
  }

  const edges=[];
  const edgeKeys=new Set();
  function addEdge(from,to,type,artifact,path) {
    if (!knownIds.has(from) || !knownIds.has(to)) {
      throw new TraceabilityInputError(`Dangling trace reference ${from} -> ${to} at ${path}`);
    }
    const key=canonicalJson({from,to,type});
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({from,to,type,source:sourceFor(artifact,path)});
  }

  for (const [index,question] of pm.content.architecture_questions.entries()) {
    for (const [referenceIndex,id] of question.affected_requirements.entries()) {
      addEdge(id,question.id,"ADDRESSES",pm,
        `/content/architecture_questions/${index}/affected_requirements/${referenceIndex}`);
    }
    for (const [referenceIndex,id] of question.affected_constraints.entries()) {
      addEdge(id,question.id,"ADDRESSES",pm,
        `/content/architecture_questions/${index}/affected_constraints/${referenceIndex}`);
    }
  }
  for (const adr of adrs) {
    for (const [referenceIndex,id] of
      adr.content.resolved_architecture_questions.entries()) {
      addEdge(id,adr.content.id,"RESOLVED_BY",adr,
        `/content/resolved_architecture_questions/${referenceIndex}`);
    }
    for (const [referenceIndex,id] of adr.content.affected_requirements.entries()) {
      addEdge(id,adr.content.id,"AFFECTS",adr,
        `/content/affected_requirements/${referenceIndex}`);
    }
  }
  for (const [index,epic] of plan.content.epics.entries()) {
    for (const [referenceIndex,reference] of epic.source_requirements.entries()) {
      addEdge(reference.id,epic.id,"SCOPES",plan,
        `/content/epics/${index}/source_requirements/${referenceIndex}`);
    }
  }
  for (const [index,issue] of plan.content.issues.entries()) {
    if (issue.epic) {
      addEdge(issue.epic.id,issue.id,"CONTAINS",plan,
        `/content/issues/${index}/epic`);
    }
    for (const [referenceIndex,reference] of
      (issue.source_requirements ?? []).entries()) {
      addEdge(reference.id,issue.id,"SOURCE_REQUIREMENT",plan,
        `/content/issues/${index}/source_requirements/${referenceIndex}`);
    }
    for (const [referenceIndex,reference] of issue.adr_refs.entries()) {
      addEdge(reference.id,issue.id,"REQUIRES_DECISION",plan,
        `/content/issues/${index}/adr_refs/${referenceIndex}`);
    }
    for (const [referenceIndex,reference] of issue.dependencies.entries()) {
      addEdge(reference.id,issue.id,"BLOCKS",plan,
        `/content/issues/${index}/dependencies/${referenceIndex}`);
    }
    for (const [referenceIndex,reference] of issue.acceptance_criteria.entries()) {
      addEdge(issue.id,reference.id,"OWNS",plan,
        `/content/issues/${index}/acceptance_criteria/${referenceIndex}`);
    }
  }
  for (const [index,criterion] of plan.content.acceptance_criteria.entries()) {
    for (const [referenceIndex,reference] of criterion.verifies.entries()) {
      addEdge(reference.id,criterion.id,"VERIFIED_BY",plan,
        `/content/acceptance_criteria/${index}/verifies/${referenceIndex}`);
    }
  }
  edges.sort(edgeSort);

  const graph={
    schema_version:"trace-graph.v1",
    document_type:"trace-graph",
    input_snapshots:{
      pm_analysis:artifactReference(pm),
      architecture:artifactReference(architecture),
      adrs:adrs.map(artifactReference),
      issue_plan:artifactReference(plan),
    },
    nodes,
    edges,
  };
  assertGraph(graph);
  const frozen=deepFreeze(graph);
  authoritativeGraphs.add(frozen);
  return frozen;
}

function authoritativeGraph(graph) {
  if (!graph || typeof graph!=="object" || !authoritativeGraphs.has(graph)) {
    throw new TraceabilityInputError(
      "Trace graph is not an authoritative build; rebuild it from authoritative artifacts",
    );
  }
  return graph;
}

export function calculateRequirementCoverage(graph) {
  const normalized=authoritativeGraph(graph);
  const requirements=normalized.nodes.filter(node => REQUIREMENT_TYPES.has(node.type));
  if (requirements.length===0) return 1;
  const sourceIssues=new Map(requirements.map(node => [node.id,new Set()]));
  const verifiedCriteria=new Map(requirements.map(node => [node.id,new Set()]));
  const ownedCriteria=new Map();
  for (const edge of normalized.edges) {
    if (edge.type==="SOURCE_REQUIREMENT") sourceIssues.get(edge.from)?.add(edge.to);
    else if (edge.type==="VERIFIED_BY") verifiedCriteria.get(edge.from)?.add(edge.to);
    else if (edge.type==="OWNS") {
      if (!ownedCriteria.has(edge.from)) ownedCriteria.set(edge.from,new Set());
      ownedCriteria.get(edge.from).add(edge.to);
    }
  }
  const covered=requirements.filter(requirement =>
    [...sourceIssues.get(requirement.id)].some(issueId =>
      [...(ownedCriteria.get(issueId) ?? [])].some(criterionId =>
        verifiedCriteria.get(requirement.id).has(criterionId),
      ),
    ),
  ).length;
  return covered/requirements.length;
}

function reachable(start,adjacency) {
  const found=new Set();
  const pending=[...(adjacency.get(start) ?? [])].sort(compareText);
  while (pending.length>0) {
    const current=pending.shift();
    if (found.has(current)) continue;
    found.add(current);
    for (const next of adjacency.get(current) ?? []) {
      if (!found.has(next)) pending.push(next);
    }
    pending.sort(compareText);
  }
  return found;
}

export function traceEntity(graph,entityId) {
  const normalized=authoritativeGraph(graph);
  if (typeof entityId!=="string") {
    throw new TraceEntityNotFoundError(entityId);
  }
  const byId=new Map(normalized.nodes.map(node => [node.id,node]));
  if (!byId.has(entityId)) throw new TraceEntityNotFoundError(entityId);
  const downstreamMap=new Map(normalized.nodes.map(node => [node.id,new Set()]));
  const upstreamMap=new Map(normalized.nodes.map(node => [node.id,new Set()]));
  for (const edge of normalized.edges) {
    downstreamMap.get(edge.from).add(edge.to);
    upstreamMap.get(edge.to).add(edge.from);
  }
  const result={
    schema_version:"trace-result.v1",
    document_type:"trace-result",
    entity:byId.get(entityId),
    upstream:[...reachable(entityId,upstreamMap)].map(id => byId.get(id)).sort(traversalSort),
    downstream:[...reachable(entityId,downstreamMap)].map(id => byId.get(id)).sort(traversalSort),
    requirement_coverage:calculateRequirementCoverage(normalized),
  };
  const validation=validateDocument(result,"trace-result.v1");
  if (!validation.valid) {
    throw new TraceabilityInputError(
      `Invalid trace result schema: ${formatValidationErrors(validation.errors)}`,
    );
  }
  return deepFreeze(result);
}
