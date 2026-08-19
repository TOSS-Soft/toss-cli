import fs from "node:fs";

import {canonicalJson,sha256Canonical} from "../contracts/acp.js";
import {validateDocument} from "../contracts/validator.js";
import {auditDesign} from "./design-auditor.js";
import {validateDesignArtifact} from "./design-contracts.js";

const RULES=JSON.parse(fs.readFileSync(new URL(
  "../../contracts/design/ui-design-dor.v1.json",
  import.meta.url,
),"utf8"));
const RULE_BY_ID=new Map(RULES.rules.map(row => [row.id,row]));
const BLOCKING_SEVERITIES=new Set(["P0","P1","P2"]);

function deepFreeze(value) {
  if (!value || typeof value!=="object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function copy(value) {
  return JSON.parse(canonicalJson(value));
}

function reference(artifact) {
  return {
    document_type:artifact.document_type,
    artifact_id:artifact.artifact_id,
    revision:artifact.revision,
    content_sha256:artifact.content_sha256,
  };
}

function same(left,right) {
  try {
    return canonicalJson(left)===canonicalJson(right);
  } catch {
    return false;
  }
}

function evidence(artifact,path,message) {
  return {
    artifact:artifact ? `${artifact.document_type}:${artifact.artifact_id}@${artifact.revision}#${artifact.content_sha256}` : "design-graph",
    path:path.startsWith("/") ? path : `/${path}`,
    message,
  };
}

function rule(ruleId,items) {
  return {
    rule_id:ruleId,
    message:RULE_BY_ID.get(ruleId).description,
    evidence:items,
  };
}

function boundary(message) {
  return result({
    sourceRevision:null,sourceSha256:null,level:null,graphRoot:null,uiIssueIds:[],
    failures:[rule("UIDOR-010-GRAPH-INTEGRITY",[evidence(undefined,"/",message)])],
    warnings:[],
  });
}

function result({sourceRevision,sourceSha256,level,graphRoot,uiIssueIds,failures,warnings}) {
  const value={
    schema_version:"ui-design-dor-result.v1",
    document_type:"ui-design-dor-result",
    rules_version:RULES.schema_version,
    source_revision:sourceRevision,
    source_sha256:sourceSha256,
    design_level:level,
    graph_root_sha256:graphRoot,
    ready_for_ui_issue_generation:failures.length===0,
    ui_issue_ids:[...uiIssueIds].sort(),
    failures:[...failures].sort((left,right) => left.rule_id.localeCompare(right.rule_id)),
    warnings:[...warnings].sort((left,right) => left.rule_id.localeCompare(right.rule_id)),
  };
  const validation=validateDocument(value,"ui-design-dor-result.v1");
  if (!validation.valid) {
    throw new TypeError(`UI Design DoR result construction failed: ${validation.errors[0]?.message}`);
  }
  return deepFreeze(value);
}

function exactGraphMember(graph,supplied,type) {
  if (!supplied || supplied.document_type!==type) return undefined;
  const matches=graph.filter(row => row.document_type===type &&
    row.artifact_id===supplied.artifact_id && row.revision===supplied.revision &&
    row.content_sha256===supplied.content_sha256);
  return matches.length===1 && same(matches[0],supplied) ? matches[0] : undefined;
}

function auditFailures(graph,audit,fresh) {
  const failures=[];
  const exact=exactGraphMember(graph,audit,"design-audit");
  if (!exact) {
    failures.push(evidence(audit,"/","Supplied Design Audit is not one exact current graph member."));
    return failures;
  }
  const expected={
    audited_artifacts:fresh.audited_artifacts,
    findings:fresh.findings,
  };
  if (!same(exact.content?.audited_artifacts,expected.audited_artifacts) ||
      !same(exact.content?.findings,expected.findings)) {
    failures.push(evidence(exact,"/content","Design Audit does not equal the fresh independent audit."));
  }
  const validation=validateDesignArtifact(exact,graph);
  if (!validation.valid) {
    failures.push(...validation.findings.map(row => evidence(
      exact,row.path ?? "/",row.message ?? row.type,
    )));
  }
  if (fresh.status==="FAIL") {
    failures.push(evidence(exact,"/content/findings","Fresh Design Audit contains blocking findings."));
  }
  return failures;
}

function approvalFailures(graph,approval) {
  const failures=[];
  const exact=exactGraphMember(graph,approval,"design-approval");
  if (!exact) {
    failures.push(evidence(approval,"/","Supplied design approval is not one exact current graph member."));
    return failures;
  }
  const manifest=graph.filter(row => row.document_type!=="design-approval").map(reference)
    .sort((left,right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  if (exact.content?.decision!=="APPROVED" ||
      !same(exact.content?.graph_manifest,manifest) ||
      exact.content?.graph_root_sha256!==sha256Canonical(manifest)) {
    failures.push(evidence(exact,"/content","Human approval is not bound to the exact current graph manifest and root."));
  }
  const validation=validateDesignArtifact(exact,graph);
  if (!validation.valid) {
    failures.push(...validation.findings.map(row => evidence(
      exact,row.path ?? "/",row.message ?? row.type,
    )));
  }
  return failures;
}

function exactArtifactForReference(graph,reference,documentType) {
  if (!reference || reference.document_type!==documentType) return undefined;
  const lineage=graph.filter(row => row.document_type===documentType &&
    row.artifact_id===reference.artifact_id);
  const latestRevision=Math.max(0,...lineage.map(row => row.revision));
  const matches=lineage.filter(row => row.revision===latestRevision &&
    row.revision===reference.revision && row.content_sha256===reference.content_sha256);
  return matches.length===1 ? matches[0] : undefined;
}

function auditRuleId(type) {
  if (type==="USERS_AND_NEEDS_MISSING") return "UIDOR-020-USERS-AND-NEEDS";
  if (new Set(["SCREEN_STATE_COVERAGE","ORPHAN_SCREEN_STATE"]).has(type)) {
    return "UIDOR-030-FLOWS-AND-STATES";
  }
  if (new Set([
    "INFORMATION_ARCHITECTURE_MISSING","RESPONSIVE_COVERAGE_GAP",
    "ACCESSIBILITY_TARGET_MISSING",
  ]).has(type)) return "UIDOR-040-IA-RESPONSIVE-A11Y";
  if (type.includes("BINDING_RULE") || type.includes("DESIGN_SYSTEM") ||
      type.includes("APPROVED_EXCEPTION")) return "UIDOR-050-DESIGN-SYSTEM";
  if (type==="CRITICAL_EVIDENCE_MISSING") return "UIDOR-060-CRITICAL-EVIDENCE";
  return "UIDOR-010-GRAPH-INTEGRITY";
}

function entityIds(artifact,kind) {
  if (!artifact) return new Set();
  if (kind==="flow") return new Set([artifact.content?.flow_id].filter(Boolean));
  if (kind==="screen") return new Set([artifact.content?.screen_id].filter(Boolean));
  if (kind==="component") return new Set((artifact.content?.components ?? []).map(row => row.component_id));
  if (kind==="state") return new Set((artifact.content?.states ?? []).map(row => row.state_id));
  if (kind==="responsive") return new Set((artifact.content?.responsive ?? []).map(row => row.target_id));
  if (kind==="accessibility") return new Set((artifact.content?.accessibility ?? []).map(row => row.criterion_id));
  return new Set();
}

function issueTraceFailures(graph,issuePlan,sourceRevision,sourceSha256,level) {
  if (issuePlan===undefined) return {items:[],uiIssueIds:[]};
  const items=[];
  const validation=validateDocument(issuePlan,"issue-plan.v1");
  if (!validation.valid) {
    items.push(...validation.errors.map(error => evidence(
      issuePlan,error.instancePath || "/",error.message ?? "Issue plan schema validation failed.",
    )));
    return {items,uiIssueIds:[]};
  }
  if (issuePlan.content_sha256!==sha256Canonical(issuePlan.content)) {
    items.push(evidence(issuePlan,"/content_sha256","Issue plan content hash does not match canonical content."));
  }
  if (issuePlan.provenance?.source_revision!==sourceRevision ||
      issuePlan.provenance?.source_sha256!==sourceSha256) {
    items.push(evidence(issuePlan,"/provenance","Issue plan is not bound to the exact current design source."));
  }
  const uiIssues=(issuePlan.content?.issues ?? []).filter(issue =>
    Object.hasOwn(issue,"ui_design_trace"));
  if (uiIssues.length>0 && level==="NOT_APPLICABLE") {
    items.push(evidence(issuePlan,"/content/issues","A NOT_APPLICABLE design cannot authorize UI issue traces."));
  }
  const specs={
    flow_refs:["user-flow","flow"],
    screen_refs:["screen-spec","screen"],
    component_refs:["design-system","component"],
    state_refs:["screen-spec","state"],
    responsive_refs:["screen-spec","responsive"],
    accessibility_refs:["screen-spec","accessibility"],
  };
  for (const issue of uiIssues) {
    const trace=issue.ui_design_trace;
    if (!exactArtifactForReference(graph,trace.design_system_ref,"design-system")) {
      items.push(evidence(issuePlan,`/content/issues/${issue.id}/ui_design_trace/design_system_ref`,
        "UI issue Design System reference is not one exact current graph revision."));
    }
    for (const [field,[documentType,kind]] of Object.entries(specs)) {
      for (const [index,ref] of (trace[field] ?? []).entries()) {
        const artifact=exactArtifactForReference(graph,ref,documentType);
        if (!artifact || !entityIds(artifact,kind).has(ref.entity_id)) {
          items.push(evidence(issuePlan,
            `/content/issues/${issue.id}/ui_design_trace/${field}/${index}`,
            `UI issue ${field} entry does not resolve to one exact current design entity.`));
        }
      }
    }
  }
  return {items,uiIssueIds:uiIssues.map(issue => issue.id)};
}

export function evaluateDesignReadiness(value) {
  let input;
  try {
    input=copy(value);
  } catch (error) {
    return boundary(error instanceof Error ? error.message : "UI Design DoR input is not canonical JSON.");
  }
  if (!input || typeof input!=="object" || Array.isArray(input) ||
      !Array.isArray(input.designGraph)) {
    return boundary("UI Design DoR requires an exact designGraph array.");
  }
  const allowed=new Set(["approval","audit","designGraph","issuePlan"]);
  if (Object.keys(input).some(key => !allowed.has(key))) {
    return boundary("UI Design DoR input contains unsupported caller state.");
  }
  const graph=input.designGraph;
  const briefRows=graph.filter(row => row.document_type==="design-brief");
  const brief=briefRows.length===1 ? briefRows[0] : undefined;
  const level=brief?.content?.orchestration?.level ?? null;
  const sourceRevision=brief?.provenance?.source_revision ?? null;
  const sourceSha256=brief?.provenance?.source_sha256 ?? null;
  const manifest=graph.filter(row => row.document_type!=="design-approval").map(reference)
    .sort((left,right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const graphRoot=manifest.length>0 ? sha256Canonical(manifest) : null;
  const fresh=auditDesign(graph);
  const failures=[];
  const warnings=[];
  if (!brief || !["LITE","STANDARD","CRITICAL","NOT_APPLICABLE"].includes(level)) {
    failures.push(rule("UIDOR-010-GRAPH-INTEGRITY",[
      evidence(brief,"/content/orchestration/level","One exact level-aware design brief is required."),
    ]));
  }
  if (fresh.status==="FAIL") {
    const byRule=new Map();
    for (const finding of fresh.findings.filter(row =>
      BLOCKING_SEVERITIES.has(row.severity))) {
      const ruleId=auditRuleId(finding.type);
      const items=byRule.get(ruleId) ?? [];
      items.push(evidence(finding.affected_refs[0],"/",`${finding.type}: ${finding.message}`));
      byRule.set(ruleId,items);
    }
    for (const [ruleId,items] of byRule) failures.push(rule(ruleId,items));
  }
  if (level==="NOT_APPLICABLE") {
    if ((input.audit!==null && input.audit!==undefined) ||
        (input.approval!==null && input.approval!==undefined)) {
      failures.push(rule("UIDOR-080-EXACT-APPROVAL",[
        evidence(brief,"/","NOT_APPLICABLE design cannot contain audit or approval authority."),
      ]));
    }
  } else {
    const auditItems=auditFailures(graph,input.audit,fresh);
    if (auditItems.length>0) failures.push(rule("UIDOR-070-LATEST-AUDIT",auditItems));
    const approvalItems=approvalFailures(graph,input.approval);
    if (approvalItems.length>0) failures.push(rule("UIDOR-080-EXACT-APPROVAL",approvalItems));
  }
  const trace=issueTraceFailures(
    graph,input.issuePlan,sourceRevision,sourceSha256,level,
  );
  if (trace.items.length>0) failures.push(rule("UIDOR-090-ISSUE-TRACE",trace.items));
  if (fresh.status==="WARN") {
    warnings.push(rule("UIDOR-100-NONBLOCKING-FINDINGS",fresh.findings.map(row =>
      evidence(row.affected_refs[0],"/",`${row.type}: ${row.message}`))));
  }
  return result({
    sourceRevision,sourceSha256,level,graphRoot,uiIssueIds:trace.uiIssueIds,failures,warnings,
  });
}
