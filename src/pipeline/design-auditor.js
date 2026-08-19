import fs from "node:fs";

import {canonicalJson,sha256Canonical} from "../contracts/acp.js";
import {
  validateDesignArtifact,
  validateDesignSystemRules,
} from "./design-contracts.js";

const RULES=JSON.parse(fs.readFileSync(new URL(
  "../../contracts/design/ui-design-dor.v1.json",
  import.meta.url,
),"utf8"));
const BLOCKING_SEVERITIES=new Set(["P0","P1","P2"]);
const DESIGN_TYPES=new Set([
  "design-brief","ux-analysis","user-flow","information-architecture",
  "wireframe-plan","visual-direction","design-system","screen-spec",
  "prototype-manifest","usability-evidence",
]);
const REQUIRED_WORK_TYPES=Object.freeze({
  LITE:Object.freeze(["design-brief","user-flow","design-system","screen-spec"]),
  STANDARD:Object.freeze([
    "design-brief","ux-analysis","user-flow","information-architecture",
    "wireframe-plan","visual-direction","design-system","screen-spec",
    "prototype-manifest",
  ]),
  CRITICAL:Object.freeze([
    "design-brief","ux-analysis","user-flow","information-architecture",
    "wireframe-plan","visual-direction","design-system","screen-spec",
    "prototype-manifest","usability-evidence",
  ]),
  NOT_APPLICABLE:Object.freeze(["design-brief"]),
});

function deepFreeze(value) {
  if (!value || typeof value!=="object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function copy(value) {
  return JSON.parse(canonicalJson(value));
}

function reference(artifact,entityId) {
  return {
    document_type:artifact.document_type,
    artifact_id:artifact.artifact_id,
    revision:artifact.revision,
    content_sha256:artifact.content_sha256,
    ...(entityId===undefined ? {} : {entity_id:entityId}),
  };
}

function finding({type,severity="P1",owner="DESIGN_SPECIALIST",artifact,entityId,path="/",message,evidence=[]}) {
  const affected=artifact ? [reference(artifact,entityId)] : [{
    document_type:"design-brief",artifact_id:"design-brief:UNKNOWN",revision:1,
    content_sha256:"0".repeat(64),
  }];
  const facts=evidence.length>0 ? evidence : [
    `${artifact?.document_type ?? "design-graph"}${path}: ${message}`,
  ];
  const identity={type,severity,owner,message,affected_refs:affected,evidence:facts};
  return {finding_id:`FINDING-${sha256Canonical(identity).slice(0,16).toUpperCase()}`,...identity};
}

function graphFinding(row,artifact) {
  return finding({
    type:row.type,
    severity:["BINDING_RULE_VIOLATION","APPROVED_EXCEPTION_INVALID"].includes(row.type) ? "P1" : "P0",
    owner:row.type.includes("APPROVAL") ? "USER" : "DESIGN_SPECIALIST",
    artifact,
    path:row.path ?? "/",
    message:row.message ?? "Design graph validation failed",
  });
}

function normalizeStateName(value) {
  return typeof value==="string" ? value.trim().toLowerCase() : "";
}

function auditCoverage(graph,level) {
  const findings=[];
  const ux=graph.find(row => row.document_type==="ux-analysis");
  if (["STANDARD","CRITICAL"].includes(level) &&
      (!ux || !Array.isArray(ux.content?.users) || ux.content.users.length===0 ||
       ux.content.users.some(user => !Array.isArray(user.needs) || user.needs.length===0 ||
         !Array.isArray(user.evidence) || user.evidence.length===0))) {
    findings.push(finding({
      type:"USERS_AND_NEEDS_MISSING",artifact:ux ?? graph[0],path:"/content/users",
      message:"Standard and Critical design work requires evidenced users and needs.",
    }));
  }

  const flowStateKeys=new Set();
  for (const flow of graph.filter(row => row.document_type==="user-flow")) {
    for (const step of flow.content?.steps ?? []) {
      flowStateKeys.add(`${step.screen_id}\u0000${step.state_id}`);
    }
  }
  for (const screen of graph.filter(row => row.document_type==="screen-spec")) {
    const states=Array.isArray(screen.content?.states) ? screen.content.states : [];
    const names=new Set(states.map(state => normalizeStateName(state.name)));
    const missing=RULES.required_state_names.filter(name => !names.has(name));
    if (missing.length>0) {
      findings.push(finding({
        type:"SCREEN_STATE_COVERAGE",artifact:screen,entityId:screen.content?.screen_id,
        path:"/content/states",message:"Required normal and exception screen states are missing.",
        evidence:[`Missing states: ${missing.join(", ")}`],
      }));
    }
    for (const [index,state] of states.entries()) {
      if (!flowStateKeys.has(`${screen.content?.screen_id}\u0000${state.state_id}`)) {
        findings.push(finding({
          type:"ORPHAN_SCREEN_STATE",severity:"P3",artifact:screen,entityId:state.state_id,
          path:`/content/states/${index}`,
          message:"Screen state is not traversed by an exact user-flow step.",
        }));
      }
    }
    const responsive=[...(screen.content?.responsive ?? [])].sort((left,right) =>
      left.min_width-right.min_width || left.max_width-right.max_width);
    let cursor=RULES.responsive_range.min_width;
    for (const target of responsive) {
      if (target.min_width>cursor || target.max_width<target.min_width) break;
      cursor=Math.max(cursor,target.max_width+1);
    }
    if (cursor<=RULES.responsive_range.max_width) {
      findings.push(finding({
        type:"RESPONSIVE_COVERAGE_GAP",artifact:screen,entityId:screen.content?.screen_id,
        path:"/content/responsive",message:"Responsive targets do not continuously cover the required width range.",
        evidence:[`Required ${RULES.responsive_range.min_width}-${RULES.responsive_range.max_width}px; first uncovered width ${cursor}px`],
      }));
    }
    if (!(screen.content?.accessibility ?? []).some(row =>
      row.standard===RULES.accessibility_standard)) {
      findings.push(finding({
        type:"ACCESSIBILITY_TARGET_MISSING",artifact:screen,entityId:screen.content?.screen_id,
        path:"/content/accessibility",message:`Accessibility target ${RULES.accessibility_standard} is required.`,
      }));
    }
  }

  if (["STANDARD","CRITICAL"].includes(level) &&
      !graph.some(row => row.document_type==="information-architecture")) {
    findings.push(finding({
      type:"INFORMATION_ARCHITECTURE_MISSING",artifact:graph[0],
      message:"Standard and Critical design work requires approved information architecture.",
    }));
  }
  if (level==="CRITICAL") {
    const critical=graph.find(row => row.document_type==="usability-evidence");
    const kinds=new Set((critical?.content?.critical_evidence ?? []).filter(row =>
      Array.isArray(row.evidence) && row.evidence.length>0).map(row => row.kind));
    for (const kind of RULES.critical_evidence_kinds) {
      if (!kinds.has(kind)) findings.push(finding({
        type:"CRITICAL_EVIDENCE_MISSING",severity:"P1",artifact:critical ?? graph[0],
        path:"/content/critical_evidence",
        message:"Critical design work requires complete level-specific evidence.",
        evidence:[`Missing Critical evidence kind: ${kind}`],
      }));
    }
  }
  return findings;
}

function finalResult(graph,findings) {
  const byIdentity=new Map(findings.map(row => [canonicalJson(row),row]));
  const ordered=[...byIdentity.values()].sort((left,right) =>
    left.severity.localeCompare(right.severity) || left.type.localeCompare(right.type) ||
    left.finding_id.localeCompare(right.finding_id));
  const status=ordered.some(row => BLOCKING_SEVERITIES.has(row.severity)) ? "FAIL" :
    ordered.length>0 ? "WARN" : "PASS";
  return deepFreeze({
    status,
    audited_artifacts:graph.map(artifact => reference(artifact)).sort((left,right) =>
      canonicalJson(left).localeCompare(canonicalJson(right))),
    findings:ordered,
  });
}

export function auditDesign(value) {
  let supplied;
  try {
    supplied=copy(value);
  } catch (error) {
    return finalResult([], [finding({
      type:"CANONICAL_JSON",severity:"P0",message:error instanceof Error ? error.message :
        "Design graph is not canonical JSON.",
    })]);
  }
  if (!Array.isArray(supplied)) {
    return finalResult([], [finding({
      type:"MALFORMED_GRAPH",severity:"P0",message:"Design graph must be an array.",
    })]);
  }
  const graph=supplied.filter(row => DESIGN_TYPES.has(row?.document_type));
  const findings=[];
  if (graph.length!==supplied.filter(row =>
    !["design-audit","design-approval"].includes(row?.document_type)).length) {
    findings.push(finding({
      type:"UNKNOWN_DESIGN_ARTIFACT",severity:"P0",artifact:graph[0],
      message:"Design graph contains an unsupported document type.",
    }));
  }
  for (const artifact of graph) {
    const validation=validateDesignArtifact(artifact,graph);
    findings.push(...validation.findings.map(row => graphFinding(row,artifact)));
  }
  const rules=validateDesignSystemRules(graph);
  const system=graph.find(row => row.document_type==="design-system") ?? graph[0];
  findings.push(...rules.findings.map(row => graphFinding(row,system)));
  const briefs=graph.filter(row => row.document_type==="design-brief");
  const level=briefs.length===1 ? briefs[0].content?.orchestration?.level : undefined;
  if (!["LITE","STANDARD","CRITICAL","NOT_APPLICABLE"].includes(level)) {
    findings.push(finding({
      type:"DESIGN_LEVEL_INVALID",severity:"P0",artifact:briefs[0] ?? graph[0],
      path:"/content/orchestration/level",message:"Design graph requires one exact level-aware design brief.",
    }));
  } else {
    const actual=graph.map(row => row.document_type).sort();
    const required=[...REQUIRED_WORK_TYPES[level]].sort();
    if (!sameArrays(actual,required)) findings.push(finding({
      type:"LEVEL_GRAPH_INCOMPLETE",severity:"P0",artifact:briefs[0],
      path:"/content/orchestration/level",
      message:`${level} audit requires its exact level-aware design artifact graph.`,
      evidence:[`Expected ${required.join(", ")}; received ${actual.join(", ")}`],
    }));
    if (level!=="NOT_APPLICABLE") findings.push(...auditCoverage(graph,level));
  }
  return finalResult(graph,findings);
}

function sameArrays(left,right) {
  return left.length===right.length && left.every((value,index) => value===right[index]);
}
