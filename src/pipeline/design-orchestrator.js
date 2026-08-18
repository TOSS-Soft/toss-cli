import {createPublicKey,verify as verifyDetached} from "node:crypto";
import {types as utilTypes} from "node:util";

import {canonicalJson,sha256Canonical} from "../contracts/acp.js";
import {validateDesignSystemRules} from "./design-contracts.js";
import {classifyDesignLevel} from "./design-level.js";

const SIGNING_DOMAIN="toss.design-orchestration.authority-approval.v1";
const CONTEXT_KEYS=Object.freeze([
  "classification_input","design_artifacts","persisted_artifacts",
  "approval_records","target_command",
]);
const TARGET_COMMANDS=new Set([
  "design.init","design.analyze","design.prepare","design.flows",
  "design.wireframes","design.direction","design.system","design.screens",
  "design.prototype","design.audit","design.review","design.approve",
  "design.status",
]);
const REQUIRED_TYPES=Object.freeze({
  NOT_APPLICABLE:Object.freeze(["design-brief"]),
  LITE:Object.freeze([
    "design-brief","user-flow","design-system","screen-spec","design-audit",
    "design-approval",
  ]),
  STANDARD:Object.freeze([
    "design-brief","ux-analysis","user-flow","information-architecture",
    "wireframe-plan","visual-direction","design-system","screen-spec",
    "prototype-manifest","design-audit","design-approval",
  ]),
  CRITICAL:Object.freeze([
    "design-brief","ux-analysis","user-flow","information-architecture",
    "wireframe-plan","visual-direction","design-system","screen-spec",
    "prototype-manifest","usability-evidence","design-audit","design-approval",
  ]),
});
const REQUIRED_STAGES=Object.freeze({
  NOT_APPLICABLE:Object.freeze(["BRIEF"]),
  LITE:Object.freeze(["BRIEF","FLOWS","SCREENS","AUDIT","FINAL_APPROVAL"]),
  STANDARD:Object.freeze([
    "BRIEF","ANALYSIS","FLOWS","INFORMATION_ARCHITECTURE","WIREFRAMES",
    "DIRECTION","DESIGN_SYSTEM","SCREENS","PROTOTYPE","AUDIT",
    "FINAL_APPROVAL",
  ]),
  CRITICAL:Object.freeze([
    "BRIEF","ANALYSIS","FLOWS","INFORMATION_ARCHITECTURE","WIREFRAMES",
    "DIRECTION","DESIGN_SYSTEM","SCREENS","PROTOTYPE","USABILITY_EVIDENCE",
    "AUDIT","FINAL_APPROVAL",
  ]),
});
const STAGE_BY_TYPE=Object.freeze({
  "design-brief":"BRIEF",
  "ux-analysis":"ANALYSIS",
  "user-flow":"FLOWS",
  "information-architecture":"INFORMATION_ARCHITECTURE",
  "wireframe-plan":"WIREFRAMES",
  "visual-direction":"DIRECTION",
  "design-system":"DESIGN_SYSTEM",
  "screen-spec":"SCREENS",
  "prototype-manifest":"PROTOTYPE",
  "usability-evidence":"USABILITY_EVIDENCE",
  "design-audit":"AUDIT",
  "design-approval":"FINAL_APPROVAL",
});
const DIRECTION_TYPES=new Set([
  "design-brief","ux-analysis","information-architecture","user-flow",
  "wireframe-plan","visual-direction",
]);
const SYSTEM_TYPES=new Set([...DIRECTION_TYPES,"design-system"]);
const APPROVAL_KEYS=Object.freeze([
  "approval_kind","decision","design_id","source_revision","source_sha256",
  "recommended_level","effective_level","from_level","to_level","artifact_refs",
  "authority","verification_kind","actor_id","actor_role","record_id",
  "record_revision","record_sha256","timestamp","signature",
]);
const UNSIGNED_APPROVAL_KEYS=Object.freeze(APPROVAL_KEYS.filter(key => key!=="signature"));

function deepFreeze(value) {
  if (!value || typeof value!=="object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalCopy(value,label) {
  const visited=new Set();
  function rejectProxyTree(item) {
    if (!item || typeof item!=="object" || visited.has(item)) return;
    if (utilTypes.isProxy(item)) throw new TypeError("proxies are unsupported");
    visited.add(item);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))) {
      if ("value" in descriptor) rejectProxyTree(descriptor.value);
    }
  }
  try {
    rejectProxyTree(value);
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw new TypeError(`${label} must be canonical JSON`,{cause:error});
  }
}

function exactObject(value,label,keys) {
  if (!value || typeof value!=="object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a closed object`);
  }
  const actual=Object.keys(value).sort();
  const expected=[...keys].sort();
  if (canonicalJson(actual)!==canonicalJson(expected)) {
    throw new TypeError(`${label} is closed and contains an unexpected property`);
  }
  return value;
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
  return canonicalJson(left)===canonicalJson(right);
}

function sameReferenceSet(left,right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length!==right.length) return false;
  const leftKeys=left.map(reference => canonicalJson(reference));
  const rightKeys=right.map(reference => canonicalJson(reference));
  if (new Set(leftKeys).size!==leftKeys.length || new Set(rightKeys).size!==rightKeys.length) {
    return false;
  }
  return canonicalJson(leftKeys.sort())===canonicalJson(rightKeys.sort());
}

function uniqueDesignBrief(graph) {
  const briefs=graph.filter(row => row.document_type==="design-brief");
  if (briefs.length!==1) {
    throw new TypeError("design artifacts must contain exactly one design brief");
  }
  return briefs[0];
}

function canonicalPublicKey(value,label) {
  if (typeof value!=="string" || value.trim().length===0) {
    throw new TypeError(`${label} must be a non-blank string`);
  }
  if (value.replace(/\r\n/gu,"").includes("\r")) {
    throw new TypeError(`${label} must use LF or CRLF line endings`);
  }
  const input=value.replace(/\r\n/gu,"\n");
  const normalizedInput=input.endsWith("\n") ? input : `${input}\n`;
  let publicKey;
  let normalizedPublicKey;
  try {
    publicKey=createPublicKey(normalizedInput);
    normalizedPublicKey=publicKey.export({format:"pem",type:"spki"}).toString();
  } catch (error) {
    throw new TypeError(`${label} is not a valid public PEM key`,{cause:error});
  }
  if (publicKey.asymmetricKeyType!=="ed25519") {
    throw new TypeError(`${label} must be an Ed25519 public key`);
  }
  if (normalizedInput!==normalizedPublicKey) {
    throw new TypeError(
      `${label} must contain exactly one canonical Ed25519 SPKI public PEM block`,
    );
  }
  return publicKey;
}

function normalizedRegistry(value) {
  const registry=canonicalCopy(value ?? {actors:[]},"design authority registry");
  exactObject(registry,"design authority registry",["actors"]);
  if (!Array.isArray(registry.actors)) throw new TypeError("design authority actors must be an array");
  const actors=new Map();
  for (const actor of registry.actors) {
    exactObject(actor,"design authority actor",[
      "actor_id","actor_role","public_key","allowed_routes",
    ]);
    if (actors.has(actor.actor_id)) throw new TypeError("design authority actor IDs must be unique");
    if (!new Set(["CEO","USER"]).has(actor.actor_role)) {
      throw new TypeError("design authority actor role is not independently approvable");
    }
    if (!Array.isArray(actor.allowed_routes) || actor.allowed_routes.length!==1) {
      throw new TypeError("design authority actor must have one closed A3 route");
    }
    exactObject(actor.allowed_routes[0],"design authority route",[
      "authority","verification_kind",
    ]);
    if (actor.allowed_routes[0].authority!=="A3" ||
        actor.allowed_routes[0].verification_kind!=="A3_VERIFIED_CEO_OR_USER_AUTHORITY") {
      throw new TypeError("design authority registry only accepts the A3 verified route");
    }
    const publicKey=canonicalPublicKey(
      actor.public_key,"design authority public_key",
    );
    actors.set(actor.actor_id,{...actor,publicKey});
  }
  return actors;
}

export function designApprovalSigningPayload(value) {
  const unsigned=canonicalCopy(value,"design approval signing record");
  exactObject(unsigned,"design approval signing record",UNSIGNED_APPROVAL_KEYS);
  return deepFreeze({domain:SIGNING_DOMAIN,...unsigned});
}

function verifyApproval(value,actors) {
  const record=canonicalCopy(value,"design approval record");
  exactObject(record,"design approval record",APPROVAL_KEYS);
  if (record.decision!=="APPROVED" || record.authority!=="A3" ||
      record.verification_kind!=="A3_VERIFIED_CEO_OR_USER_AUTHORITY") {
    throw new TypeError("design approval must use independently verified A3 authority");
  }
  const actor=actors.get(record.actor_id);
  if (!actor || actor.actor_role!==record.actor_role) {
    throw new TypeError("design approval actor is not in the trusted authority registry");
  }
  const {signature,...unsigned}=record;
  const signatureBytes=Buffer.from(signature,"base64");
  if (signatureBytes.toString("base64")!==signature || !verifyDetached(
    null,
    Buffer.from(canonicalJson(designApprovalSigningPayload(unsigned)),"utf8"),
    actor.publicKey,
    signatureBytes,
  )) {
    throw new TypeError("design approval signature is invalid");
  }
  return record;
}

function normalizedGraph(value,label) {
  const graph=canonicalCopy(value,label);
  if (!Array.isArray(graph)) throw new TypeError(`${label} must be an array`);
  const identities=new Set();
  for (const artifact of graph) {
    const identity=`${artifact?.artifact_id}\u0000${artifact?.revision}`;
    if (identities.has(identity)) throw new TypeError(`${label} contains duplicate revisions`);
    identities.add(identity);
  }
  return graph;
}

function levelFromApprovedDowngrade(classification,approvals,graph) {
  if (!classification.requires_downgrade_approval) return classification.effective_level;
  const requested=classification.classification_input.requested_level;
  const record=approvals.find(row => row.approval_kind==="CRITICAL_DOWNGRADE");
  if (!record) {
    throw new TypeError("critical downgrade approval is required before design can advance");
  }
  const brief=uniqueDesignBrief(graph);
  if (record.recommended_level!=="CRITICAL" || record.from_level!=="CRITICAL" ||
      record.to_level!==requested || record.effective_level!==requested ||
      record.design_id!==brief?.content?.design_id ||
      record.source_revision!==brief?.provenance?.source_revision ||
      record.source_sha256!==brief?.provenance?.source_sha256 ||
      !sameReferenceSet(record.artifact_refs,graph.map(reference))) {
    throw new TypeError("critical downgrade approval is required before design can advance");
  }
  return requested;
}

function assertClassificationBrief(classification,graph) {
  const brief=uniqueDesignBrief(graph);
  const input=classification.classification_input;
  if (input.source!==brief.content.source || input.purpose!==brief.content.purpose ||
      !same(input.success_criteria,brief.content.success_criteria) ||
      !same(input.approval_owner,brief.content.approval_owner)) {
    throw new TypeError(
      "design classification must exactly match the authoritative design brief",
    );
  }
}

function assertExactLevelGraph(graph,level) {
  const required=REQUIRED_TYPES[level];
  if (!required) throw new TypeError("effective design level is unsupported");
  const actual=graph.map(row => row.document_type);
  if (new Set(actual).size!==actual.length || actual.length!==required.length ||
      required.some(type => !actual.includes(type))) {
    throw new TypeError(`${level} design artifacts must be the exact required level graph`);
  }
  const brief=uniqueDesignBrief(graph);
  if (brief?.document_type!=="design-brief" ||
      brief.content?.orchestration?.level!==level) {
    throw new TypeError("design brief orchestration level must match the verified level");
  }
}

function assertPersistedSubset(graph,persisted) {
  const candidateByIdentity=new Map(graph.map(artifact => [
    `${artifact.artifact_id}\u0000${artifact.revision}`,artifact,
  ]));
  for (const artifact of persisted) {
    const candidate=candidateByIdentity.get(`${artifact.artifact_id}\u0000${artifact.revision}`);
    if (!candidate || !same(candidate,artifact)) {
      throw new TypeError("persisted design artifact does not match the collected payload");
    }
  }
}

function assertApproval(record,kind,level,graph,types) {
  const expected=graph.filter(row => types.has(row.document_type)).map(reference);
  const brief=uniqueDesignBrief(graph);
  if (!record || record.approval_kind!==kind || record.design_id!==brief.content.design_id ||
      record.source_revision!==brief.provenance.source_revision ||
      record.source_sha256!==brief.provenance.source_sha256 ||
      record.recommended_level!==level || record.effective_level!==level ||
      record.from_level!==null || record.to_level!==null ||
      !sameReferenceSet(record.artifact_refs,expected)) {
    throw new TypeError(`${kind} approval is not bound to the exact design payload`);
  }
}

function expectedCommitmentReferences(content,allowed) {
  return content.payload_commitments.filter(row =>
    allowed.has(row.expected_document_type)).map(row => row.expected_artifact_ref);
}

function assertStateApproval(record,kind,level,content,provenance,types) {
  if (!record || record.approval_kind!==kind || record.design_id!==content.design_id ||
      record.source_revision!==provenance.source_revision ||
      record.source_sha256!==provenance.source_sha256 ||
      record.recommended_level!==level || record.effective_level!==level ||
      record.from_level!==null || record.to_level!==null ||
      !sameReferenceSet(record.artifact_refs,expectedCommitmentReferences(content,types))) {
    throw new TypeError(`${kind} state approval is not bound to the exact design source`);
  }
}

function assertStateDowngrade(record,classification,level,content,provenance) {
  if (!record || record.approval_kind!=="CRITICAL_DOWNGRADE" ||
      record.design_id!==content.design_id ||
      record.source_revision!==provenance.source_revision ||
      record.source_sha256!==provenance.source_sha256 ||
      record.recommended_level!=="CRITICAL" || record.from_level!=="CRITICAL" ||
      record.to_level!==level || record.effective_level!==level ||
      !sameReferenceSet(record.artifact_refs,expectedCommitmentReferences(
        content,new Set(content.required_artifact_types),
      ))) {
    throw new TypeError("critical downgrade state approval is stale or cross-source");
  }
  if (classification.classification_input.requested_level!==level) {
    throw new TypeError("critical downgrade state level contradicts its classification");
  }
}

function commitmentShape(content,{initialized}) {
  const expectedTypes=initialized ? ["design-brief"] : content.required_artifact_types;
  const actualTypes=content.payload_commitments.map(row => row.expected_document_type);
  const expectedReferences=content.payload_commitments.map(row =>
    row.expected_artifact_ref);
  if (new Set(actualTypes).size!==actualTypes.length ||
      new Set(expectedReferences.map(row => canonicalJson(row))).size!==
        expectedReferences.length ||
      !same([...actualTypes].sort(),[...expectedTypes].sort())) {
    throw new TypeError("design state commitments do not close the required artifact set");
  }
  for (const row of content.payload_commitments) {
    if (STAGE_BY_TYPE[row.expected_document_type]!==row.stage ||
        row.expected_artifact_ref.document_type!==row.expected_document_type ||
        (row.artifact_ref===null)!==(row.status!=="PERSISTED") ||
        (row.artifact_ref!==null &&
          !same(row.artifact_ref,row.expected_artifact_ref))) {
      throw new TypeError("design state commitment status or stage is inconsistent");
    }
  }
}

function commitments(graph,persisted,approvedKinds) {
  const persistedIds=new Set(persisted.map(row => `${row.artifact_id}\u0000${row.revision}`));
  return graph.map(artifact => {
    const artifactRef=reference(artifact);
    const isPersisted=persistedIds.has(`${artifact.artifact_id}\u0000${artifact.revision}`);
    const stage=STAGE_BY_TYPE[artifact.document_type];
    const isApproved=approvedKinds.includes("DESIGN_SYSTEM") ||
      (approvedKinds.includes("DIRECTION") && DIRECTION_TYPES.has(artifact.document_type));
    return {
      stage,
      expected_document_type:artifact.document_type,
      expected_artifact_ref:artifactRef,
      payload_sha256:sha256Canonical(artifact),
      status:isPersisted ? "PERSISTED" : isApproved ? "APPROVED" : "COLLECTED",
      artifact_ref:isPersisted ? artifactRef : null,
    };
  });
}

function outcome({classification,level,graph,persisted,approvals}) {
  const direction=approvals.find(row => row.approval_kind==="VISUAL_DIRECTION");
  const system=approvals.find(row => row.approval_kind==="DESIGN_SYSTEM");
  const approved=[];
  let state;
  let gate;
  let blocked;
  let readyToPersist=false;
  let nextAction;

  if (level==="NOT_APPLICABLE") {
    state="NOT_APPLICABLE";
    gate="NOT_APPLICABLE";
    blocked=false;
    nextAction={command:"toss design status",owner:"DESIGN_SPECIALIST",reason:"Design is not applicable."};
  } else if (!direction) {
    state="DIRECTION_PENDING";
    gate="DIRECTION_APPROVAL";
    blocked=true;
    nextAction={command:"toss design approve",owner:"USER",reason:"Visual direction approval is required."};
  } else {
    assertApproval(direction,"VISUAL_DIRECTION",level,graph,DIRECTION_TYPES);
    approved.push("DIRECTION");
    if (!system) {
      state="SYSTEM_PENDING";
      gate="DESIGN_SYSTEM_APPROVAL";
      blocked=true;
      nextAction={command:"toss design approve",owner:"USER",reason:"Design-system approval is required."};
    } else {
      assertApproval(system,"DESIGN_SYSTEM",level,graph,SYSTEM_TYPES);
      approved.push("DESIGN_SYSTEM");
      const validation=validateDesignSystemRules(graph);
      if (!validation.valid) throw new TypeError("design graph failed in-memory validation");
      const persistedTypes=new Set(persisted.map(row => row.document_type));
      const nonFinalTypes=graph.filter(row => row.document_type!=="design-approval")
        .map(row => row.document_type);
      const allNonFinalPersisted=nonFinalTypes.every(type => persistedTypes.has(type));
      if (persisted.length===0 || !allNonFinalPersisted) {
        state="SYSTEM_APPROVED";
        gate="NONE";
        blocked=false;
        readyToPersist=true;
        nextAction={
          command:"toss design prepare --from <FILE>",
          owner:"DESIGN_SPECIALIST",
          reason:persisted.length===0 ? "Replay the exact approved payload for persistence." :
            "Resume exact approved payload persistence.",
        };
      } else if (!persisted.some(row => row.document_type==="design-approval")) {
        state="FINAL_APPROVAL_PENDING";
        gate="FINAL_APPROVAL";
        blocked=true;
        nextAction={command:"toss design approve",owner:"USER",reason:"Final design approval is required."};
      } else if (persisted.length===graph.length) {
        state="APPROVED";
        gate="COMPLETE";
        blocked=false;
        nextAction={command:"toss design status",owner:"DESIGN_SPECIALIST",reason:"Design is complete."};
      }
    }
  }

  const refs=persisted.map(reference);
  const payloadCommitments=commitments(graph,persisted,approved);
  const result={
    level,
    recommended_level:classification.recommended_level,
    state,
    gate,
    blocked,
    ready_to_persist:readyToPersist,
    collected:[...new Set(graph.map(row =>
      DIRECTION_TYPES.has(row.document_type) ? "DIRECTION" :
        SYSTEM_TYPES.has(row.document_type) ? "DESIGN_SYSTEM" : STAGE_BY_TYPE[row.document_type]))],
    approved,
    persisted:[...new Set(persisted.map(row => STAGE_BY_TYPE[row.document_type]))],
    artifact_revisions:refs,
    payload_commitments:payloadCommitments,
    next_action:nextAction,
    next_state_content:{
      design_id:uniqueDesignBrief(graph).content.design_id,
      scope:classification.classification_input.scope,
      classification:{...classification,effective_level:level,requires_downgrade_approval:false},
      required_stages:REQUIRED_STAGES[level],
      required_artifact_types:REQUIRED_TYPES[level],
      state,
      gate,
      artifact_refs:refs,
      payload_commitments:payloadCommitments,
      approvals:approvals,
      next_action:nextAction,
      findings:[],
    },
  };
  return deepFreeze(result);
}

function assertTargetCommand(targetCommand,result) {
  if (!TARGET_COMMANDS.has(targetCommand)) {
    throw new TypeError("design target command is unsupported");
  }
  if (targetCommand==="design.approve" &&
      (result.gate==="NOT_APPLICABLE" ||
        (result.gate==="DIRECTION_APPROVAL" &&
          !result.next_state_content.approvals.some(row =>
            row.approval_kind==="CRITICAL_DOWNGRADE")))) {
    throw new TypeError("design approve cannot bypass the current legal gate");
  }
}

function verifyStateSnapshot(value,actors) {
  const snapshot=canonicalCopy(value,"design state snapshot");
  exactObject(snapshot,"design state snapshot",["content","provenance"]);
  const {content,provenance}=snapshot;
  const classified=classifyDesignLevel(content.classification.classification_input);
  const approvals=content.approvals.map(record => verifyApproval(record,actors));
  const kinds=approvals.map(record => record.approval_kind);
  if (new Set(kinds).size!==kinds.length) {
    throw new TypeError("design state approval kinds must be unique");
  }
  let level=classified.effective_level;
  const expectedKinds=[];
  let downgradePending=false;
  if (classified.requires_downgrade_approval) {
    const downgrade=approvals.find(row => row.approval_kind==="CRITICAL_DOWNGRADE");
    if (!downgrade) {
      downgradePending=true;
    } else {
      level=classified.classification_input.requested_level;
      assertStateDowngrade(downgrade,classified,level,content,provenance);
      expectedKinds.push("CRITICAL_DOWNGRADE");
    }
  } else if (kinds.includes("CRITICAL_DOWNGRADE")) {
    throw new TypeError("design state contains an unexpected critical downgrade approval");
  }
  const expectedClassification=downgradePending ? classified : {
    ...classified,effective_level:level,requires_downgrade_approval:false,
  };
  if (!same(content.classification,expectedClassification) ||
      !same(content.scope,classified.classification_input.scope) ||
      !same(content.required_stages,REQUIRED_STAGES[level]) ||
      !same(content.required_artifact_types,REQUIRED_TYPES[level]) ||
      content.findings.length!==0) {
    throw new TypeError("design state classification or level requirements are inconsistent");
  }
  const initialized=new Set(["INITIALIZED","DOWNGRADE_PENDING"]).has(content.state);
  commitmentShape(content,{initialized});
  if (downgradePending) {
    if (approvals.length!==0 || content.state!=="DOWNGRADE_PENDING" ||
        content.gate!=="CRITICAL_DOWNGRADE_APPROVAL" ||
        content.artifact_refs.length!==0 ||
        content.payload_commitments[0].status!=="COLLECTED" ||
        !same(content.next_action,{
          command:"toss design approve",
          owner:"USER",
          reason:"Critical downgrade approval is required.",
        })) {
      throw new TypeError("pending Critical downgrade state is inconsistent");
    }
    return deepFreeze(snapshot);
  }
  if (initialized) {
    if (level==="NOT_APPLICABLE" || approvals.length!==0 ||
        content.gate!=="NONE" || content.artifact_refs.length!==0 ||
        content.payload_commitments[0].status!=="COLLECTED" ||
        !same(content.next_action,{
          command:"toss design prepare --from <FILE>",
          owner:"DESIGN_SPECIALIST",
          reason:"Collect and replay the exact level-specific design graph.",
        })) {
      throw new TypeError("initialized feature design state is inconsistent");
    }
    return deepFreeze(snapshot);
  }
  if (level==="NOT_APPLICABLE") {
    if (approvals.length!==0 || content.state!=="NOT_APPLICABLE" ||
        content.gate!=="NOT_APPLICABLE" || !same(content.next_action,{
          command:"toss design status",
          owner:"DESIGN_SPECIALIST",
          reason:"Design is not applicable.",
        })) {
      throw new TypeError("NOT_APPLICABLE design state cannot contain approvals");
    }
  }
  const direction=approvals.find(row => row.approval_kind==="VISUAL_DIRECTION");
  const system=approvals.find(row => row.approval_kind==="DESIGN_SYSTEM");
  if (direction) {
    assertStateApproval(direction,"VISUAL_DIRECTION",level,content,provenance,DIRECTION_TYPES);
    expectedKinds.push("VISUAL_DIRECTION");
  }
  if (system) {
    if (!direction) throw new TypeError("design-system approval cannot precede direction");
    assertStateApproval(system,"DESIGN_SYSTEM",level,content,provenance,SYSTEM_TYPES);
    expectedKinds.push("DESIGN_SYSTEM");
  }
  if (!same(kinds,expectedKinds)) {
    throw new TypeError("design state approvals are not one canonical ordered history");
  }
  const persistedRefs=content.payload_commitments.filter(row =>
    row.artifact_ref!==null).map(row => row.artifact_ref);
  if (!sameReferenceSet(content.artifact_refs,persistedRefs)) {
    throw new TypeError("design state artifact references contradict persisted commitments");
  }
  for (const row of content.payload_commitments) {
    const expectedStatus=row.artifact_ref!==null ? "PERSISTED" : system ? "APPROVED" :
      direction && DIRECTION_TYPES.has(row.expected_document_type) ? "APPROVED" : "COLLECTED";
    if (row.status!==expectedStatus) {
      throw new TypeError("design state commitment status is not derived from verified facts");
    }
  }
  if (level!=="NOT_APPLICABLE") {
    const persistedTypes=new Set(content.payload_commitments.filter(row =>
      row.status==="PERSISTED").map(row => row.expected_document_type));
    const nonFinal=content.required_artifact_types.filter(type => type!=="design-approval");
    let expectedState;
    let expectedGate;
    let expectedAction;
    if (!direction) {
      if (persistedTypes.size!==0) throw new TypeError("pre-gate design state persisted artifacts");
      expectedState="DIRECTION_PENDING";
      expectedGate="DIRECTION_APPROVAL";
      expectedAction={
        command:"toss design approve",owner:"USER",
        reason:"Visual direction approval is required.",
      };
    } else if (!system) {
      if (persistedTypes.size!==0) throw new TypeError("pre-gate design state persisted artifacts");
      expectedState="SYSTEM_PENDING";
      expectedGate="DESIGN_SYSTEM_APPROVAL";
      expectedAction={
        command:"toss design approve",owner:"USER",
        reason:"Design-system approval is required.",
      };
    } else if (!nonFinal.every(type => persistedTypes.has(type))) {
      expectedState="SYSTEM_APPROVED";
      expectedGate="NONE";
      expectedAction={
        command:"toss design prepare --from <FILE>",owner:"DESIGN_SPECIALIST",
        reason:persistedTypes.size===0 ?
          "Replay the exact approved payload for persistence." :
          "Resume exact approved payload persistence.",
      };
    } else if (!persistedTypes.has("design-approval")) {
      expectedState="FINAL_APPROVAL_PENDING";
      expectedGate="FINAL_APPROVAL";
      expectedAction={
        command:"toss design approve",owner:"USER",
        reason:"Final design approval is required.",
      };
    } else {
      expectedState="APPROVED";
      expectedGate="COMPLETE";
      expectedAction={
        command:"toss design status",owner:"DESIGN_SPECIALIST",
        reason:"Design is complete.",
      };
    }
    if (content.state!==expectedState || content.gate!==expectedGate ||
        !same(content.next_action,expectedAction)) {
      throw new TypeError("design state and gate are not derived from verified approvals");
    }
  }
  return deepFreeze(snapshot);
}

function prepareWithActors(value,actors) {
  const context=canonicalCopy(value,"design preparation context");
  exactObject(context,"design preparation context",CONTEXT_KEYS);
  if (!Array.isArray(context.approval_records)) {
    throw new TypeError("design approval records must be an array");
  }
  const classification=classifyDesignLevel(context.classification_input);
  const graph=normalizedGraph(context.design_artifacts,"design artifacts");
  const persisted=normalizedGraph(context.persisted_artifacts,"persisted design artifacts");
  const approvals=context.approval_records.map(record => verifyApproval(record,actors));
  const recordIds=new Set();
  const kinds=new Set();
  for (const record of approvals) {
    const identity=`${record.record_id}\u0000${record.record_revision}`;
    if (recordIds.has(identity) || kinds.has(record.approval_kind)) {
      throw new TypeError("design approval records contain a duplicate or conflicting record");
    }
    recordIds.add(identity);
    kinds.add(record.approval_kind);
  }
  const level=levelFromApprovedDowngrade(classification,approvals,graph);
  assertClassificationBrief(classification,graph);
  assertExactLevelGraph(graph,level);
  assertPersistedSubset(graph,persisted);
  if (level==="NOT_APPLICABLE") {
    if (approvals.length!==0) {
      throw new TypeError("NOT_APPLICABLE design cannot contain approval records");
    }
    const validation=validateDesignSystemRules(graph);
    if (!validation.valid) throw new TypeError("N/A design brief failed validation");
  }
  const result=outcome({classification,level,graph,persisted,approvals});
  assertTargetCommand(context.target_command,result);
  return result;
}

const EMPTY_ACTORS=normalizedRegistry({actors:[]});

export function prepareDesign(context) {
  return prepareWithActors(context,EMPTY_ACTORS);
}

export function createDesignOrchestrator(options={}) {
  if (!options || typeof options!=="object" || Array.isArray(options) ||
      utilTypes.isProxy(options) ||
      !new Set([Object.prototype,null]).has(Object.getPrototypeOf(options))) {
    throw new TypeError("design orchestrator options must be a plain non-proxy object");
  }
  const descriptors=Object.getOwnPropertyDescriptors(options);
  const keys=Reflect.ownKeys(descriptors);
  if (keys.length!==1 || keys[0]!=="authorityRegistry" ||
      !descriptors.authorityRegistry.enumerable ||
      !("value" in descriptors.authorityRegistry)) {
    throw new TypeError("design orchestrator options require one authorityRegistry value");
  }
  const actors=normalizedRegistry(descriptors.authorityRegistry.value);
  return Object.freeze({
    prepareDesign:context => prepareWithActors(context,actors),
    verifyStateSnapshot:value => verifyStateSnapshot(value,actors),
  });
}
