import assert from "node:assert/strict";
import {createPrivateKey,sign as signDetached} from "node:crypto";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {canonicalJson,sha256Canonical} from "../src/contracts/acp.js";
import {validateDocument} from "../src/contracts/validator.js";

const levelModule=await import("../src/pipeline/design-level.js").catch(error => {
  if (error?.code==="ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const orchestratorModule=await import(
  "../src/pipeline/design-orchestrator.js"
).catch(error => {
  if (error?.code==="ERR_MODULE_NOT_FOUND") return {};
  throw error;
});

const classifyDesignLevel=levelModule.classifyDesignLevel;
const prepareDesign=orchestratorModule.prepareDesign;
const createDesignOrchestrator=orchestratorModule.createDesignOrchestrator;
const designApprovalSigningPayload=orchestratorModule.designApprovalSigningPayload;

const designFixture=JSON.parse(await readFile(new URL(
  "./fixtures/design-contracts/valid-graph.json",
  import.meta.url,
),"utf8"));
const PRIVATE_KEY=createPrivateKey(`-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEICMMwUatUwxz9nHC1Z8Ycl5we3pAdGkWjX497KGuvT2y
-----END PRIVATE KEY-----`);
const PUBLIC_KEY=`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA2EfZW/G5ES5AjZflH3kWHqXYeKTS9/7qQ1QklZtMGzc=
-----END PUBLIC KEY-----
`;

function classificationInput(overrides={}) {
  return {
    schema_version:"design-classification-input.v1",
    scope:{kind:"project",id:"PROJECT-CHECKOUT"},
    delivery_targets:["WEB"],
    affected_surfaces:["SCREEN"],
    risk_signals:[],
    requested_level:"AUTO",
    source:"company_system",
    purpose:"Provide an accessible checkout experience.",
    success_criteria:["A user can complete checkout without assistance."],
    approval_owner:{role:"CEO",identity:"authority:ceo"},
    ...overrides,
  };
}

function artifactReference(artifact) {
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
  CRITICAL:Object.freeze(designFixture.artifacts.map(row => row.document_type)),
});

function graphForLevel(level) {
  const graph=[];
  const byType=new Map();
  const allowed=new Set(level==="NOT_APPLICABLE" ? ["design-brief"] : TYPES_BY_LEVEL[level]);
  for (const descriptor of designFixture.artifacts) {
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
    const parents=(descriptor.parents ?? []).filter(type => byType.has(type)).map(type =>
      artifactReference(byType.get(type)));
    const artifact={
      schema_version:"acp.v1",
      document_type:descriptor.document_type,
      artifact_id:`${descriptor.document_type}:DESIGN-CHECKOUT`,
      revision:1,
      run_id:"run:design-orchestration:001",
      producer:{role:descriptor.producer_role,identity:`toss-${descriptor.producer_role}`},
      runtime_identity:{kind:"deterministic",name:"toss-cli",version:"2.1.0"},
      created_at:"2026-08-18T10:00:00.000Z",
      provenance:{
        source_revision:designFixture.source_revision,
        source_sha256:designFixture.source_sha256,
        locations:["project-brief.md#design"],
      },
      parents,
      inputs:parents,
      content_sha256:sha256Canonical(content),
      content,
    };
    graph.push(artifact);
    byType.set(artifact.document_type,artifact);
  }
  return structuredClone(graph);
}

function authorityRegistry() {
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

function trustedPrepareDesign(context) {
  assert.equal(typeof createDesignOrchestrator,"function");
  return createDesignOrchestrator({authorityRegistry:authorityRegistry()}).prepareDesign({
    source_artifact_refs:[],
    ...context,
  });
}

function signedStageApproval(kind,artifacts,overrides={}) {
  assert.equal(typeof designApprovalSigningPayload,"function");
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
    design_id:"DESIGN-CHECKOUT",
    source_revision:overrides.source_revision ?? designFixture.source_revision,
    source_sha256:overrides.source_sha256 ?? designFixture.source_sha256,
    recommended_level:overrides.recommended_level ?? level,
    effective_level:overrides.effective_level ?? level,
    from_level:overrides.from_level ?? null,
    to_level:overrides.to_level ?? null,
    artifact_refs:artifacts.map(artifactReference),
    artifact_commitments:overrides.artifact_commitments ?? artifactCommitments,
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

test("design level classification is deterministic for N/A, Lite, Standard, and Critical",() => {
  assert.equal(typeof classifyDesignLevel,"function");
  const cases=[
    {
      name:"API, CLI, and backend-only",
      input:classificationInput({
        delivery_targets:["API","CLI","BACKEND"],
        affected_surfaces:[],
        source:"NOT_APPLICABLE",
      }),
      recommended:"NOT_APPLICABLE",
      effective:"NOT_APPLICABLE",
    },
    {
      name:"one bounded screen",
      input:classificationInput(),
      recommended:"LITE",
      effective:"LITE",
    },
    {
      name:"multi-screen information architecture",
      input:classificationInput({
        affected_surfaces:["SCREEN","FLOW","INFORMATION_ARCHITECTURE"],
        risk_signals:["MULTI_SCREEN"],
      }),
      recommended:"STANDARD",
      effective:"STANDARD",
    },
    {
      name:"security and privacy UX",
      input:classificationInput({risk_signals:["SECURITY_PRIVACY"]}),
      recommended:"CRITICAL",
      effective:"CRITICAL",
    },
  ];

  for (const row of cases) {
    const original=structuredClone(row.input);
    const result=classifyDesignLevel(row.input);
    assert.equal(result.recommended_level,row.recommended,row.name);
    assert.equal(result.effective_level,row.effective,row.name);
    assert.deepEqual(row.input,original,row.name);
    assert.ok(Object.isFrozen(result),row.name);
    assert.ok(Object.isFrozen(result.basis),row.name);
  }
});

test("critical scope cannot be downgraded by a caller request",() => {
  assert.equal(typeof classifyDesignLevel,"function");
  const result=classifyDesignLevel(classificationInput({
    risk_signals:["FAILURE_RECOVERY"],
    requested_level:"LITE",
  }));
  assert.equal(result.recommended_level,"CRITICAL");
  assert.equal(result.effective_level,"CRITICAL");
  assert.equal(result.requires_downgrade_approval,true);
});

test("classification rejects invented trust and malformed closed inputs",() => {
  assert.equal(typeof classifyDesignLevel,"function");
  assert.throws(
    () => classifyDesignLevel({...classificationInput(),trusted:true}),
    /closed|unexpected|property/i,
  );
  assert.throws(
    () => classifyDesignLevel(classificationInput({affected_surfaces:["SCREEN","SCREEN"]})),
    /unique|duplicate/i,
  );
  assert.throws(
    () => classifyDesignLevel(classificationInput({risk_signals:["INVENTED_RISK"]})),
    /risk/i,
  );
});

test("prepareDesign fails closed before a critical downgrade can advance",() => {
  assert.equal(typeof prepareDesign,"function");
  assert.throws(
    () => prepareDesign({
      classification_input:classificationInput({
        risk_signals:["SECURITY_PRIVACY"],
        requested_level:"LITE",
      }),
      source_artifact_refs:[],
      design_artifacts:[],
      persisted_artifacts:[],
      approval_records:[],
      target_command:"design.prepare",
    }),
    /downgrade approval/i,
  );
});

test("prepareDesign rejects undeclared target commands",() => {
  const graph=graphForLevel("STANDARD");
  assert.throws(() => trustedPrepareDesign({
    classification_input:classificationInput({
      affected_surfaces:["SCREEN","FLOW","INFORMATION_ARCHITECTURE"],
      risk_signals:["MULTI_SCREEN"],
    }),
    design_artifacts:graph,
    persisted_artifacts:[],
    approval_records:[],
    target_command:"design.invented",
  }),/target command|unsupported/i);
});

test("design authority registry accepts only canonical Ed25519 SPKI public PEM",() => {
  const privatePem=PRIVATE_KEY.export({format:"pem",type:"pkcs8"}).toString();
  for (const publicKey of [
    privatePem,
    `${PUBLIC_KEY}junk`,
    `${PUBLIC_KEY}${PUBLIC_KEY}`,
  ]) assert.throws(() => createDesignOrchestrator({authorityRegistry:{actors:[{
    actor_id:"verified-ceo",actor_role:"CEO",public_key:publicKey,
    allowed_routes:[{
      authority:"A3",verification_kind:"A3_VERIFIED_CEO_OR_USER_AUTHORITY",
    }],
  }]}}),/public|SPKI|canonical/i);

  let reads=0;
  const actor={
    actor_id:"verified-ceo",actor_role:"CEO",
    allowed_routes:[{
      authority:"A3",verification_kind:"A3_VERIFIED_CEO_OR_USER_AUTHORITY",
    }],
  };
  Object.defineProperty(actor,"public_key",{
    enumerable:true,
    get() {
      reads+=1;
      return PUBLIC_KEY;
    },
  });
  assert.throws(() => createDesignOrchestrator({
    authorityRegistry:{actors:[actor]},
  }),/canonical|accessor/i);
  assert.throws(() => createDesignOrchestrator({
    authorityRegistry:new Proxy(authorityRegistry(),{
      get() {
        reads+=1;
        return undefined;
      },
    }),
  }),/canonical|proxies/i);
  const nestedActor=new Proxy(authorityRegistry().actors[0],{
    get() {
      reads+=1;
      return undefined;
    },
  });
  assert.throws(() => createDesignOrchestrator({
    authorityRegistry:{actors:[nestedActor]},
  }),/canonical|proxies/i);
  assert.equal(reads,0);
});

function stateArtifact() {
  const classification=classifyDesignLevel(classificationInput());
  const content={
    design_id:"DESIGN-CHECKOUT",
    scope:{kind:"project",id:"PROJECT-CHECKOUT"},
    classification,
    required_stages:["BRIEF","FLOWS","SCREENS","AUDIT","FINAL_APPROVAL"],
    required_artifact_types:[
      "design-brief","user-flow","design-system","screen-spec","design-audit",
      "design-approval",
    ],
    state:"INITIALIZED",
    gate:"NONE",
    source_artifact_refs:[],
    artifact_refs:[],
    payload_commitments:[{
      stage:"BRIEF",
      expected_document_type:"design-brief",
      expected_artifact_ref:{
        document_type:"design-brief",
        artifact_id:"design-brief:DESIGN-CHECKOUT",
        revision:1,
        content_sha256:"d".repeat(64),
      },
      payload_sha256:"c".repeat(64),
      status:"COLLECTED",
      artifact_ref:null,
    }],
    approvals:[],
    next_action:{command:"toss design flows",owner:"DESIGN_SPECIALIST",reason:"User flow is required."},
    findings:[],
  };
  return {
    schema_version:"acp.v1",
    document_type:"design-orchestration-state",
    artifact_id:"design-orchestration-state:DESIGN-CHECKOUT",
    revision:1,
    run_id:"run:design-orchestration:001",
    producer:{role:"orchestrator",identity:"toss-design-orchestrator"},
    runtime_identity:{kind:"deterministic",name:"toss-cli",version:"2.1.0"},
    created_at:"2026-08-18T10:00:00.000Z",
    provenance:{
      source_revision:"project-brief-r1",
      source_sha256:"a".repeat(64),
      locations:["project-brief.md#design"],
    },
    parents:[],
    inputs:[],
    content_sha256:sha256Canonical(content),
    content,
  };
}

test("design orchestration state is one closed ACP contract",() => {
  const artifact=stateArtifact();
  assert.equal(validateDocument(artifact,"design-orchestration-state.v1").valid,true);
  const forged=structuredClone(artifact);
  forged.content.caller_trusted=true;
  forged.content_sha256=sha256Canonical(forged.content);
  assert.equal(validateDocument(forged,"design-orchestration-state.v1").valid,false);
});

function artifactsOfTypes(graph,types) {
  const typeSet=new Set(types);
  return graph.filter(artifact => typeSet.has(artifact.document_type));
}

const DIRECTION_TYPES=Object.freeze([
  "design-brief","ux-analysis","information-architecture","user-flow",
  "wireframe-plan","visual-direction",
]);
const SYSTEM_TYPES=Object.freeze([...DIRECTION_TYPES,"design-system"]);

test("public preparation carries exact project and feature source lineage into verifier roundtrips",async t => {
  const graph=graphForLevel("STANDARD");
  const sourceReference={
    document_type:"feature-delta",
    artifact_id:"feature-delta:PROJECT-CHECKOUT:FEATURE-001",
    revision:3,
    content_sha256:"a".repeat(64),
  };
  const cases={
    project:{classification:classificationInput({
      affected_surfaces:["SCREEN","FLOW","INFORMATION_ARCHITECTURE"],
      risk_signals:["MULTI_SCREEN"],
    }),sourceRefs:[]},
    feature:{classification:classificationInput({
      scope:{kind:"feature",id:"FEATURE-001"},
      affected_surfaces:["SCREEN","FLOW","INFORMATION_ARCHITECTURE"],
      risk_signals:["MULTI_SCREEN"],
    }),sourceRefs:[sourceReference]},
  };
  for (const [name,{classification,sourceRefs}] of Object.entries(cases)) {
    await t.test(name,() => {
      const orchestrator=createDesignOrchestrator({authorityRegistry:authorityRegistry()});
      const outcome=orchestrator.prepareDesign({
        classification_input:classification,
        source_artifact_refs:sourceRefs,
        design_artifacts:graph,
        persisted_artifacts:[],
        approval_records:[],
        target_command:"design.prepare",
      });
      assert.deepEqual(outcome.next_state_content.source_artifact_refs,sourceRefs);
      assert.deepEqual(orchestrator.verifyStateSnapshot({
        content:outcome.next_state_content,
        provenance:graph[0].provenance,
      }).content.source_artifact_refs,sourceRefs);
      if (name==="feature") {
        const malformed=structuredClone(outcome.next_state_content);
        malformed.source_artifact_refs=[{
          document_type:"feature-delta",
          unexpected:"missing exact immutable identity",
        }];
        assert.throws(() => orchestrator.verifyStateSnapshot({
          content:malformed,
          provenance:graph[0].provenance,
        }),/source artifact reference|canonical|closed/i);
      }
    });
  }
});

test("Standard collection stops truthfully at direction and system approval gates",() => {
  assert.equal(typeof prepareDesign,"function");
  const graph=graphForLevel("STANDARD");
  const input=classificationInput({
    affected_surfaces:["SCREEN","FLOW","INFORMATION_ARCHITECTURE"],
    risk_signals:["MULTI_SCREEN"],
  });
  const directionBlocked=trustedPrepareDesign({
    classification_input:input,
    design_artifacts:graph,
    persisted_artifacts:[],
    approval_records:[],
    target_command:"design.prepare",
  });
  assert.equal(directionBlocked.state,"DIRECTION_PENDING");
  assert.equal(directionBlocked.gate,"DIRECTION_APPROVAL");
  assert.equal(directionBlocked.blocked,true);
  assert.equal(directionBlocked.next_action.command,"toss design approve");
  assert.deepEqual(directionBlocked.approved,[]);
  assert.deepEqual(directionBlocked.persisted,[]);
  assert.deepEqual(directionBlocked.artifact_revisions,[]);
  assert.ok(directionBlocked.collected.includes("DIRECTION"));
  assert.ok(directionBlocked.payload_commitments.length>0);

  const directionApproval=signedStageApproval(
    "VISUAL_DIRECTION",
    artifactsOfTypes(graph,DIRECTION_TYPES),
  );
  const systemBlocked=trustedPrepareDesign({
    classification_input:input,
    design_artifacts:graph,
    persisted_artifacts:[],
    approval_records:[directionApproval],
    target_command:"design.prepare",
  });
  assert.equal(systemBlocked.state,"SYSTEM_PENDING");
  assert.equal(systemBlocked.gate,"DESIGN_SYSTEM_APPROVAL");
  assert.deepEqual(systemBlocked.approved,["DIRECTION"]);
  assert.deepEqual(systemBlocked.persisted,[]);
});

test("both signed stage gates authorize in-memory validation and topological persistence",() => {
  assert.equal(typeof prepareDesign,"function");
  const graph=graphForLevel("STANDARD");
  const input=classificationInput({
    affected_surfaces:["SCREEN","FLOW","INFORMATION_ARCHITECTURE"],
    risk_signals:["MULTI_SCREEN"],
  });
  const approvals=[
    signedStageApproval("VISUAL_DIRECTION",artifactsOfTypes(graph,DIRECTION_TYPES)),
    signedStageApproval("DESIGN_SYSTEM",artifactsOfTypes(graph,SYSTEM_TYPES)),
  ];
  const ready=trustedPrepareDesign({
    classification_input:input,
    design_artifacts:graph,
    persisted_artifacts:[],
    approval_records:approvals,
    target_command:"design.prepare",
  });
  assert.equal(ready.state,"SYSTEM_APPROVED");
  assert.equal(ready.gate,"NONE");
  assert.equal(ready.ready_to_persist,true);
  assert.deepEqual(ready.approved,["DIRECTION","DESIGN_SYSTEM"]);
  assert.deepEqual(ready.persisted,[]);
  assert.equal(ready.next_action.command,"toss design prepare --from <FILE>");

  const withoutFinal=graph.filter(artifact => artifact.document_type!=="design-approval");
  const finalBlocked=trustedPrepareDesign({
    classification_input:input,
    design_artifacts:graph,
    persisted_artifacts:withoutFinal,
    approval_records:approvals,
    target_command:"design.prepare",
  });
  assert.equal(finalBlocked.state,"FINAL_APPROVAL_PENDING");
  assert.equal(finalBlocked.gate,"FINAL_APPROVAL");
  assert.equal(finalBlocked.next_action.command,"toss design approve");
  assert.deepEqual(
    finalBlocked.artifact_revisions,
    withoutFinal.map(artifactReference),
  );

  const approved=trustedPrepareDesign({
    classification_input:input,
    design_artifacts:graph,
    persisted_artifacts:graph,
    approval_records:[...approvals,signedStageApproval("FINAL",graph)],
    target_command:"design.approve",
  });
  assert.equal(approved.state,"APPROVED");
  assert.equal(approved.gate,"COMPLETE");
  assert.equal(approved.blocked,false);
});

test("signed gate reference sets reject duplicate, missing, and extra members",() => {
  const graph=graphForLevel("STANDARD");
  const input=classificationInput({
    affected_surfaces:["SCREEN","FLOW","INFORMATION_ARCHITECTURE"],
    risk_signals:["MULTI_SCREEN"],
  });
  const direction=artifactsOfTypes(graph,DIRECTION_TYPES);
  const invalid=[
    [...direction,direction[0]],
    direction.slice(1),
    [...direction,graph.find(row => row.document_type==="design-system")],
  ];
  for (const artifacts of invalid) {
    const approval=signedStageApproval("VISUAL_DIRECTION",artifacts);
    assert.throws(() => trustedPrepareDesign({
      classification_input:input,
      design_artifacts:graph,
      persisted_artifacts:[],
      approval_records:[approval],
      target_command:"design.prepare",
    }),/exact design payload/i);
  }
});

test("signed payload commitment tuples reject missing, extra, duplicate, and reordered members",() => {
  const graph=graphForLevel("STANDARD");
  const input=classificationInput({
    affected_surfaces:["SCREEN","FLOW","INFORMATION_ARCHITECTURE"],
    risk_signals:["MULTI_SCREEN"],
  });
  const direction=artifactsOfTypes(graph,DIRECTION_TYPES);
  const canonical=signedStageApproval("VISUAL_DIRECTION",direction)
    .artifact_commitments;
  const extra=signedStageApproval(
    "DESIGN_SYSTEM",artifactsOfTypes(graph,SYSTEM_TYPES),
  ).artifact_commitments.find(row =>
    row.artifact_ref.document_type==="design-system");
  const invalid=[
    canonical.slice(1),
    [...canonical,extra],
    [...canonical,canonical[0]],
    [...canonical].reverse(),
  ];
  for (const artifactCommitments of invalid) {
    const approval=signedStageApproval("VISUAL_DIRECTION",direction,{
      artifact_commitments:artifactCommitments,
    });
    assert.throws(() => trustedPrepareDesign({
      classification_input:input,
      design_artifacts:graph,
      persisted_artifacts:[],
      approval_records:[approval],
      target_command:"design.prepare",
    }),/exact design payload/i);
  }
});

test("N/A is complete without stage or final approval",() => {
  assert.equal(typeof prepareDesign,"function");
  const graph=graphForLevel("NOT_APPLICABLE");
  const input=classificationInput({
    delivery_targets:["API","CLI","BACKEND"],
    affected_surfaces:[],
    source:"NOT_APPLICABLE",
    purpose:"The verified feature scope has no user-interface impact.",
    success_criteria:["No UI design artifact is required for this source revision."],
  });
  const result=trustedPrepareDesign({
    classification_input:input,
    design_artifacts:graph,
    persisted_artifacts:graph,
    approval_records:[],
    target_command:"design.prepare",
  });
  assert.equal(result.level,"NOT_APPLICABLE");
  assert.equal(result.state,"NOT_APPLICABLE");
  assert.equal(result.gate,"NOT_APPLICABLE");
  assert.equal(result.blocked,false);
  assert.deepEqual(result.artifact_revisions,graph.map(artifactReference));
});

test("critical downgrade authority cannot replay a signature from another source",() => {
  const graph=graphForLevel("LITE");
  const input=classificationInput({
    risk_signals:["SECURITY_PRIVACY"],
    requested_level:"LITE",
  });
  const crossSource=signedStageApproval("CRITICAL_DOWNGRADE",graph,{
    level:"LITE",
    recommended_level:"CRITICAL",
    effective_level:"LITE",
    from_level:"CRITICAL",
    to_level:"LITE",
    source_revision:"other-source@9",
    source_sha256:"f".repeat(64),
  });
  assert.throws(() => trustedPrepareDesign({
    classification_input:input,
    design_artifacts:graph,
    persisted_artifacts:[],
    approval_records:[crossSource],
    target_command:"design.prepare",
  }),/source|provenance|downgrade/i);
});

test("classification input is exactly bound to the authoritative design brief",() => {
  const graph=graphForLevel("STANDARD");
  const cases=[
    {source:"new_system"},
    {purpose:"A different purpose under the same source revision."},
    {success_criteria:["A different success criterion."]},
    {approval_owner:{role:"USER",identity:"different-authority"}},
  ];
  for (const drift of cases) {
    assert.throws(() => trustedPrepareDesign({
      classification_input:classificationInput({
        affected_surfaces:["SCREEN","FLOW","INFORMATION_ARCHITECTURE"],
        risk_signals:["MULTI_SCREEN"],
        ...drift,
      }),
      design_artifacts:graph,
      persisted_artifacts:[],
      approval_records:[],
      target_command:"design.prepare",
    }),/brief|classification|source|purpose|criteria|owner/i);
  }
});

test("N/A rejects every approval record instead of persisting invented authority",() => {
  const graph=graphForLevel("NOT_APPLICABLE");
  const input=classificationInput({
    delivery_targets:["API","CLI","BACKEND"],
    affected_surfaces:[],
    source:"NOT_APPLICABLE",
    purpose:"The verified feature scope has no user-interface impact.",
    success_criteria:["No UI design artifact is required for this source revision."],
  });
  const approval=signedStageApproval("VISUAL_DIRECTION",graph,{
    level:"NOT_APPLICABLE",
  });
  assert.throws(() => trustedPrepareDesign({
    classification_input:input,
    design_artifacts:graph,
    persisted_artifacts:graph,
    approval_records:[approval],
    target_command:"design.prepare",
  }),/N\/A|NOT_APPLICABLE|approval/i);
});
