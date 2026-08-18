import {createPrivateKey,sign as signDetached} from "node:crypto";
import {readFile} from "node:fs/promises";

import {canonicalJson,sha256Canonical} from "../../src/contracts/acp.js";
import {designApprovalSigningPayload} from "../../src/pipeline/design-orchestrator.js";

const fixture=JSON.parse(await readFile(new URL(
  "../fixtures/design-contracts/valid-graph.json",
  import.meta.url,
),"utf8"));

const PRIVATE_KEY=createPrivateKey(`-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEICMMwUatUwxz9nHC1Z8Ycl5we3pAdGkWjX497KGuvT2y
-----END PRIVATE KEY-----`);

const PUBLIC_KEY=`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA2EfZW/G5ES5AjZflH3kWHqXYeKTS9/7qQ1QklZtMGzc=
-----END PUBLIC KEY-----
`;

const TYPES_BY_LEVEL=Object.freeze({
  LITE:Object.freeze([
    "design-brief","user-flow","design-system","screen-spec","design-audit",
    "design-approval",
  ]),
  STANDARD:Object.freeze([
    "design-brief","ux-analysis","user-flow","information-architecture",
    "wireframe-plan","visual-direction","design-system","screen-spec",
    "prototype-manifest","design-audit","design-approval",
  ]),
  CRITICAL:Object.freeze(fixture.artifacts.map(row => row.document_type)),
});

export const DIRECTION_TYPES=Object.freeze([
  "design-brief","ux-analysis","information-architecture","user-flow",
  "wireframe-plan","visual-direction",
]);

export const SYSTEM_TYPES=Object.freeze([...DIRECTION_TYPES,"design-system"]);

export function artifactReference(artifact) {
  return {
    document_type:artifact.document_type,
    artifact_id:artifact.artifact_id,
    revision:artifact.revision,
    content_sha256:artifact.content_sha256,
  };
}

function replaceHashTokens(value,byType) {
  if (Array.isArray(value)) return value.map(item => replaceHashTokens(item,byType));
  if (!value || typeof value!=="object") return value;
  return Object.fromEntries(Object.entries(value).map(([key,item]) => [
    key,
    key==="content_sha256" && typeof item==="string" && item.startsWith("@") ?
      byType.get(item.slice(1)).content_sha256 : replaceHashTokens(item,byType),
  ]));
}

export function classificationInput(overrides={}) {
  return {
    schema_version:"design-classification-input.v1",
    scope:{kind:"project",id:"PROJECT-CHECKOUT"},
    delivery_targets:["WEB"],
    affected_surfaces:["SCREEN","FLOW","INFORMATION_ARCHITECTURE"],
    risk_signals:["MULTI_SCREEN"],
    requested_level:"AUTO",
    source:"company_system",
    purpose:"Provide an accessible checkout experience.",
    success_criteria:["A user can complete checkout without assistance."],
    approval_owner:{role:"CEO",identity:"authority:ceo"},
    ...overrides,
  };
}

export function graphForLevel(level="STANDARD") {
  const graph=[];
  const byType=new Map();
  const allowed=new Set(level==="NOT_APPLICABLE" ? ["design-brief"] : TYPES_BY_LEVEL[level]);
  for (const descriptor of fixture.artifacts) {
    if (!allowed.has(descriptor.document_type)) continue;
    const content=replaceHashTokens(descriptor.content,byType);
    if (descriptor.document_type==="design-brief") {
      content.orchestration={
        level,
        basis:[`${level} is the exact PM-classified design depth for this source revision.`],
      };
      if (level==="NOT_APPLICABLE") {
        content.source="NOT_APPLICABLE";
        content.purpose="The verified feature scope has no user-interface impact.";
        content.success_criteria=["No UI design artifact is required for this source revision."];
      }
    }
    if (descriptor.document_type==="design-approval") {
      content.graph_manifest=graph.map(artifactReference).sort((left,right) =>
        canonicalJson(left).localeCompare(canonicalJson(right)));
      content.graph_root_sha256=sha256Canonical(content.graph_manifest);
    }
    const dependencyRefs=(descriptor.parents ?? []).filter(type => byType.has(type)).map(type =>
      artifactReference(byType.get(type)));
    const artifact={
      schema_version:"acp.v1",
      document_type:descriptor.document_type,
      artifact_id:`${descriptor.document_type}:DESIGN-CHECKOUT`,
      revision:1,
      run_id:"run:design-command:001",
      producer:{role:descriptor.producer_role,identity:`toss-${descriptor.producer_role}`},
      runtime_identity:{kind:"deterministic",name:"toss-cli",version:"2.1.0"},
      created_at:"2026-08-18T10:00:00.000Z",
      provenance:{
        source_revision:fixture.source_revision,
        source_sha256:fixture.source_sha256,
        locations:["project-brief.md#design"],
      },
      parents:[],
      inputs:dependencyRefs,
      content_sha256:sha256Canonical(content),
      content,
    };
    graph.push(artifact);
    byType.set(artifact.document_type,artifact);
  }
  return structuredClone(graph);
}

export function authorityRegistry() {
  return {actors:[{
    actor_id:"verified-ceo",
    actor_role:"CEO",
    public_key:PUBLIC_KEY,
    allowed_routes:[{
      authority:"A3",
      verification_kind:"A3_VERIFIED_CEO_OR_USER_AUTHORITY",
    }],
  }]};
}

export function signedStageApproval(kind,artifacts,overrides={}) {
  const level=overrides.level ?? "STANDARD";
  const artifactCommitments=artifacts.map(artifact => ({
    artifact_ref:artifactReference(artifact),
    payload_sha256:sha256Canonical(artifact),
  })).sort((left,right) => {
    const leftKey=canonicalJson(left);
    const rightKey=canonicalJson(right);
    return leftKey<rightKey ? -1 : leftKey>rightKey ? 1 : 0;
  });
  const unsigned={
    approval_kind:kind,
    decision:"APPROVED",
    design_id:overrides.design_id ?? "DESIGN-CHECKOUT",
    source_revision:overrides.source_revision ?? fixture.source_revision,
    source_sha256:overrides.source_sha256 ?? fixture.source_sha256,
    recommended_level:overrides.recommended_level ?? level,
    effective_level:overrides.effective_level ?? level,
    from_level:overrides.from_level ?? null,
    to_level:overrides.to_level ?? null,
    artifact_refs:artifacts.map(artifactReference),
    artifact_commitments:artifactCommitments,
    authority:"A3",
    verification_kind:"A3_VERIFIED_CEO_OR_USER_AUTHORITY",
    actor_id:"verified-ceo",
    actor_role:"CEO",
    record_id:overrides.record_id ?? `DESIGN-${kind}-001`,
    record_revision:1,
    record_sha256:sha256Canonical({kind,revision:1}),
    timestamp:"2026-08-18T10:00:00.000Z",
  };
  return {
    ...unsigned,
    signature:signDetached(
      null,
      Buffer.from(canonicalJson(designApprovalSigningPayload(unsigned)),"utf8"),
      PRIVATE_KEY,
    ).toString("base64"),
  };
}

export function designCommandInput({
  artifacts=graphForLevel(),approvalRecords=[],classification=classificationInput(),
}={}) {
  return {
    schema_version:"design-command-input.v1",
    design_id:"DESIGN-CHECKOUT",
    created_at:"2026-08-18T10:00:00.000Z",
    run_id:"run:design-command:001",
    runtime_identity:{kind:"deterministic",name:"toss-cli",version:"2.1.0"},
    provenance:{
      source_revision:fixture.source_revision,
      source_sha256:fixture.source_sha256,
      locations:["project-brief.md#design"],
    },
    classification_input:classification,
    artifacts,
    approval_records:approvalRecords,
  };
}

export function approvalsFor(graph) {
  const byTypes=types => graph.filter(artifact => types.includes(artifact.document_type));
  return [
    signedStageApproval("VISUAL_DIRECTION",byTypes(DIRECTION_TYPES)),
    signedStageApproval("DESIGN_SYSTEM",byTypes(SYSTEM_TYPES)),
  ];
}

export function finalApprovalFor(graph) {
  return signedStageApproval("FINAL",graph);
}
