import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signDetached,
} from "node:crypto";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {createArtifactStore} from "../src/artifacts/store.js";
import {canonicalJson,sha256Canonical} from "../src/contracts/acp.js";
import {validateDocument} from "../src/contracts/validator.js";
import {auditSpecification} from "../src/pipeline/spec-auditor.js";
import {transition} from "../src/pipeline/state-machine.js";
import {buildTraceGraph} from "../src/pipeline/traceability.js";
import {
  artifactReference,
  appendArtifacts,
  clone,
  completeArtifacts,
  rehash,
} from "./support/trace-fixture.js";

const writerModule=await import("../src/pipeline/github-writer.js").catch(error => {
  if (error?.code==="ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const createGitHubWriter=writerModule.createGitHubWriter ?? (() => {
  throw new Error("createGitHubWriter is unavailable");
});

const PRIVATE_KEY=createPrivateKey(`-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEICMMwUatUwxz9nHC1Z8Ycl5we3pAdGkWjX497KGuvT2y
-----END PRIVATE KEY-----`);
const PUBLIC_KEY=`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA2EfZW/G5ES5AjZflH3kWHqXYeKTS9/7qQ1QklZtMGzc=
-----END PUBLIC KEY-----`;
const retryableErrors=JSON.parse(await readFile(new URL(
  "./fixtures/github/retryable-errors.json",
  import.meta.url,
),"utf8"));

function assertDeepFrozen(value) {
  if (!value || typeof value!=="object") return;
  assert.equal(Object.isFrozen(value),true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

function readyContext({twoIssues=false}={}) {
  const upstream=completeArtifacts();
  if (twoIssues) {
    upstream.issuePlan.content.issues.push({
      id:"ISSUE-002",
      kind:"issue",
      meaning:"Expose customer support request status.",
      finalization_status:"authoritative",
      atomic_scope:"Expose only the current status of an existing customer request.",
      epic:{kind:"epic",id:"EPIC-001"},
      source_requirements:[{kind:"requirement",id:"REQ-001"}],
      acceptance_criteria:[{kind:"acceptance-criterion",id:"AC-002"}],
      definition_of_done:["The current request status is visible and the acceptance criterion passes."],
      requires_adr:true,
      adr_refs:[{kind:"adr",id:"ADR-001"}],
      dependencies:[{kind:"issue",id:"ISSUE-001"}],
    });
    upstream.issuePlan.content.acceptance_criteria.push({
      id:"AC-002",
      kind:"acceptance-criterion",
      meaning:"A customer can see the current status of an existing support request.",
      finalization_status:"authoritative",
      issue:{kind:"issue",id:"ISSUE-002"},
      verifies:[{kind:"requirement",id:"REQ-001"}],
    });
    rehash(upstream.issuePlan);
  }
  const specAudit=auditSpecification(upstream).artifact;
  const artifacts={
    pm_analysis:upstream.pmAnalysis,
    architecture:upstream.architecture.artifact,
    adrs:upstream.architecture.adrs,
    issue_plan:upstream.issuePlan,
    spec_audit:specAudit,
  };
  const stateContent=transition("SPEC_AUDIT","AUDIT_PASSED",{
    source_revision:upstream.pmAnalysis.provenance.source_revision,
    source_sha256:upstream.pmAnalysis.provenance.source_sha256,
    artifacts,
  });
  const analysisState={
    schema_version:"acp.v1",
    document_type:"transition-event",
    artifact_id:"project-analysis-github-001",
    revision:1,
    run_id:"run-github-publication-001",
    producer:{role:"orchestrator",identity:"toss-analysis-orchestrator"},
    runtime_identity:clone(upstream.pmAnalysis.runtime_identity),
    created_at:"2026-08-17T14:00:00.000Z",
    provenance:clone(upstream.pmAnalysis.provenance),
    parents:[],
    inputs:clone(stateContent.input_artifacts),
    content_sha256:sha256Canonical(stateContent),
    content:clone(stateContent),
  };
  return {
    repository:"TOSS-Soft/toss-cli",
    artifacts:{
      ...upstream,
      specAudits:[specAudit],
      traceGraph:buildTraceGraph(upstream),
      analysisState,
    },
  };
}

function rebuildReadyContext(context) {
  const {artifacts}=context;
  const upstream={
    pmAnalysis:artifacts.pmAnalysis,
    architecture:artifacts.architecture,
    issuePlan:artifacts.issuePlan,
  };
  const specAudit=auditSpecification(upstream).artifact;
  artifacts.specAudits=[specAudit];
  artifacts.traceGraph=buildTraceGraph(upstream);
  const stateContent=transition("SPEC_AUDIT","AUDIT_PASSED",{
    source_revision:artifacts.pmAnalysis.provenance.source_revision,
    source_sha256:artifacts.pmAnalysis.provenance.source_sha256,
    artifacts:{
      pm_analysis:artifacts.pmAnalysis,
      architecture:artifacts.architecture.artifact,
      adrs:artifacts.architecture.adrs,
      issue_plan:artifacts.issuePlan,
      spec_audit:specAudit,
    },
  });
  artifacts.analysisState.inputs=clone(stateContent.input_artifacts);
  artifacts.analysisState.content=clone(stateContent);
  rehash(artifacts.analysisState);
  return context;
}

function publicKeyFingerprint(publicKey=PUBLIC_KEY) {
  return createHash("sha256").update(createPublicKey(publicKey).export({
    type:"spki",
    format:"der",
  })).digest("hex");
}

function trustedAuthorityRegistry(overrides={}) {
  const unsigned={
    schema_version:"github-publication-authority-registry.v1",
    registry_id:"toss-github-publication-authorities",
    revision:7,
    actors:[{
      actor_id:"verified-publisher",
      actor_role:"USER",
      public_key:PUBLIC_KEY,
      public_key_fingerprint:publicKeyFingerprint(),
      allowed_publications:[
        {approval_kind:"GITHUB_ISSUE_PUBLICATION",repository:"TOSS-Soft/toss-cli"},
        {approval_kind:"GITHUB_ISSUE_PUBLICATION",repository:"TOSS-Soft/other-repo"},
      ],
    }],
    ...overrides,
  };
  return {...unsigned,content_sha256:sha256Canonical(unsigned)};
}

function configuredWriter({adapter,store,authorityRegistry=trustedAuthorityRegistry()}) {
  return createGitHubWriter({adapter,store,authorityRegistry});
}

function signedApprovalFor(context,overrides={},privateKey=PRIVATE_KEY) {
  const plan=context.artifacts.issuePlan;
  const approval={
    approval_kind:"GITHUB_ISSUE_PUBLICATION",
    actor_id:"verified-publisher",
    actor_role:"USER",
    repository:context.repository,
    source_revision:plan.provenance.source_revision,
    source_sha256:plan.provenance.source_sha256,
    issue_plan:artifactReference(plan),
    record_id:"PUB-APPROVAL-001",
    record_revision:1,
    record_sha256:sha256Canonical({record_id:"PUB-APPROVAL-001",revision:1}),
    timestamp:"2026-08-17T14:05:00.000Z",
    ...overrides,
  };
  const payload={
    domain:"toss.github-issue-publication.authority-approval.v1",
    ...approval,
  };
  return {
    ...approval,
    signature:signDetached(
      null,
      Buffer.from(canonicalJson(payload),"utf8"),
      privateKey,
    ).toString("base64"),
  };
}

function authorityFor(context,overrides={},privateKey=PRIVATE_KEY) {
  return signedApprovalFor(context,overrides,privateKey);
}

function fakeAdapter({failCreateAt,seed=[]}={}) {
  const calls=[];
  const created=[];
  const updated=[];
  const remote=[...clone(seed)];
  return {
    calls,
    created,
    updated,
    remote,
    findByMarker:async marker => {
      calls.push({method:"findByMarker",marker});
      return clone(remote.filter(issue => issue.marker===marker));
    },
    createIssue:async payload => {
      calls.push({method:"createIssue",payload:clone(payload)});
      if (created.length+1===failCreateAt) {
        const error=new Error("GitHub rate limit exceeded");
        error.code="RATE_LIMITED";
        error.retryable=true;
        throw error;
      }
      const number=remote.length+101;
      const issue={
        ...clone(payload),
        number,
        url:`https://github.com/TOSS-Soft/toss-cli/issues/${number}`,
        marker:payload.marker,
      };
      remote.push(issue);
      created.push(issue);
      return clone(issue);
    },
    updateIssue:async (number,payload) => {
      calls.push({method:"updateIssue",number,payload:clone(payload)});
      const index=remote.findIndex(issue => issue.number===number);
      if (index<0) throw new Error("remote issue missing");
      remote[index]={...remote[index],...clone(payload)};
      updated.push(remote[index]);
      return clone(remote[index]);
    },
  };
}

function fakeStore({failAppendAt,seed=[]}={}) {
  const calls=[];
  const artifacts=clone(seed);
  let appends=0;
  return {
    calls,
    artifacts,
    list:async filter => {
      calls.push({method:"list",filter:clone(filter)});
      return clone(artifacts.filter(artifact => Object.entries(filter).every(
        ([key,value]) => artifact[key]===value,
      )));
    },
    verify:async reference => {
      calls.push({method:"verify",reference:clone(reference)});
      const artifact=artifacts.find(candidate =>
        candidate.document_type===reference.document_type &&
        candidate.artifact_id===reference.artifact_id &&
        candidate.revision===reference.revision &&
        candidate.content_sha256===reference.content_sha256,
      );
      if (!artifact) throw new Error("artifact not found");
      return clone(artifact);
    },
    append:async draft => {
      appends+=1;
      calls.push({method:"append",draft:clone(draft)});
      if (appends===failAppendAt) throw new Error("artifact store append interrupted");
      const previous=artifacts.filter(candidate =>
        candidate.document_type===draft.document_type &&
        candidate.artifact_id===draft.artifact_id,
      ).sort((left,right) => left.revision-right.revision).at(-1);
      const artifact={...clone(draft),revision:draft.revision ?? (previous?.revision ?? 0)+1};
      artifacts.push(artifact);
      return clone(artifact);
    },
  };
}

test("preview is deterministic, complete, deeply frozen, and makes no injected calls",async () => {
  const context=readyContext();
  const adapter=fakeAdapter();
  const store=fakeStore();
  const writer=configuredWriter({adapter,store});

  const first=await writer.preview(context);
  const second=await writer.preview(clone(context));

  assert.deepEqual(first,second);
  assert.equal(first.repository,"TOSS-Soft/toss-cli");
  assert.equal(first.operations[0].action,"create");
  assert.equal(first.operations[0].local_issue_id,"ISSUE-001");
  assert.deepEqual(first.operations[0].labels,["toss-generated"]);
  assert.equal(first.operations[0].milestone,null);
  assert.deepEqual(first.operations[0].dependencies,[]);
  assert.match(first.operations[0].body,/ISSUE-001/);
  assert.match(first.operations[0].body,/REQ-001/);
  assert.match(first.operations[0].body,/ADR-001/);
  assert.match(first.operations[0].body,/AC-001/);
  assert.match(first.operations[0].body,/toss:issue-plan=/);
  assert.deepEqual(adapter.calls,[]);
  assert.deepEqual(store.calls,[]);
  assertDeepFrozen(first);
});

test("blocked readiness and apply false cannot reach adapter or store",async () => {
  const blocked=readyContext();
  blocked.artifacts.analysisState.content.state="SPEC_AUDIT";
  rehash(blocked.artifacts.analysisState);
  const ready=readyContext();
  const adapter=fakeAdapter();
  const store=fakeStore();
  const writer=configuredWriter({adapter,store});

  await assert.rejects(
    writer.publish(blocked,{apply:true,authority:authorityFor(blocked)}),
    /readiness/i,
  );
  const dryRun=await writer.publish(ready,{apply:false});

  assert.equal(dryRun.mode,"preview");
  assert.deepEqual(adapter.calls,[]);
  assert.deepEqual(store.calls,[]);
});

test("apply requires a trusted source, plan, repository, role, record, and signature bound approval",async () => {
  const context=readyContext();
  for (const [name,mutate] of [
    ["authority|approval",authority => ({approved:true})],
    ["signature",authority => {
      authority.signature=`A${authority.signature.slice(1)}`;
      return authority;
    }],
    ["signature",authority => {
      authority.signature="invalid";
      return authority;
    }],
    ["source",authority => {
      authority.source_revision="another-source";
      return authority;
    }],
    ["plan",authority => {
      authority.issue_plan.revision=2;
      return authority;
    }],
    ["repository",authority => {
      authority.repository="TOSS-Soft/another-repo";
      return authority;
    }],
    ["role",authority => {
      authority.actor_role="CEO";
      return authority;
    }],
    ["signature",authority => {
      authority.record_revision=2;
      return authority;
    }],
  ]) {
    const adapter=fakeAdapter();
    const store=fakeStore();
    const writer=configuredWriter({adapter,store});
    const authority=mutate(authorityFor(context));
    await assert.rejects(
      writer.publish(context,{apply:true,authority}),
      new RegExp(name,"i"),
      name,
    );
    assert.deepEqual(adapter.calls,[],name);
    assert.deepEqual(store.calls,[],name);
  }
});

test("the configured authority registry rejects malformed decision routes and ambiguous keys",async () => {
  const context=readyContext();
  for (const [label,mutate,pattern] of [
    ["route",registry => {
      registry.actors[0].allowed_routes="package-selected";
      return registry;
    },/allowed_routes/i],
    ["key bundle",registry => {
      registry.actors[0].public_key=`${PUBLIC_KEY}${PUBLIC_KEY}`;
      return registry;
    },/exactly one canonical ed25519/i],
  ]) {
    const registry=mutate(trustedAuthorityRegistry());
    delete registry.content_sha256;
    registry.content_sha256=sha256Canonical(registry);
    const adapter=fakeAdapter();
    const store=fakeStore();
    await assert.rejects(
      async () => configuredWriter({adapter,store,authorityRegistry:registry})
        .publish(context,{apply:true,authority:authorityFor(context)}),
      pattern,
      label,
    );
    assert.deepEqual(adapter.calls,[],label);
    assert.deepEqual(store.calls,[],label);
  }
});

test("a caller-supplied Ed25519 key cannot establish publication trust",async () => {
  const context=readyContext();
  const {privateKey,publicKey}=generateKeyPairSync("ed25519");
  const attackerKey=publicKey.export({format:"pem",type:"spki"}).toString();
  const attackerAuthority={
    authorityRegistry:{
      actors:[{
        actor_id:"verified-publisher",
        actor_role:"USER",
        public_key:attackerKey,
        allowed_publications:[{
          approval_kind:"GITHUB_ISSUE_PUBLICATION",
          repository:context.repository,
        }],
      }],
    },
    approval:signedApprovalFor(context,{},privateKey),
  };
  const adapter=fakeAdapter();
  const store=fakeStore();

  await assert.rejects(
    configuredWriter({adapter,store}).publish(context,{
      apply:true,
      authority:attackerAuthority,
    }),
    /authority|approval|trusted|unsupported field/i,
  );
  assert.deepEqual(adapter.calls,[]);
  assert.deepEqual(store.calls,[]);
});

test("publication records exact immutable trusted registry and key provenance",async () => {
  const context=readyContext();
  const authorityRegistry=trustedAuthorityRegistry();
  const result=await configuredWriter({
    adapter:fakeAdapter(),
    store:fakeStore(),
    authorityRegistry,
  }).publish(context,{apply:true,authority:authorityFor(context)});

  assert.deepEqual(result.artifact.content.authority_registry,{
    registry_id:authorityRegistry.registry_id,
    revision:authorityRegistry.revision,
    content_sha256:authorityRegistry.content_sha256,
    actor_id:"verified-publisher",
    public_key_fingerprint:publicKeyFingerprint(),
  });
});

test("rerun discovers markers before mutation and never creates duplicate issues",async () => {
  const context=readyContext();
  const adapter=fakeAdapter();
  const store=fakeStore();
  const writer=configuredWriter({adapter,store});

  const first=await writer.publish(context,{apply:true,authority:authorityFor(context)});
  const second=await writer.publish(context,{apply:true,authority:authorityFor(context)});

  assert.equal(first.status,"complete");
  assert.equal(second.status,"complete");
  assert.equal(adapter.created.length,context.artifacts.issuePlan.content.issues.length);
  assert.equal(first.mappings[0].number,101);
  assert.equal(validateDocument(first.artifact,"github-publication-result.v1").valid,true);
  assertDeepFrozen(first);
  assert.ok(adapter.calls.findIndex(call => call.method==="findByMarker")<
    adapter.calls.findIndex(call => call.method==="createIssue"));
});

test("all markers reconcile before any mutation when a later issue is duplicated",async () => {
  const context=readyContext({twoIssues:true});
  const preview=await configuredWriter({adapter:fakeAdapter(),store:fakeStore()})
    .preview(context);
  const later=preview.operations[1];
  const duplicate={
    repository:later.repository,
    marker:later.marker,
    title:later.title,
    body:later.body,
    labels:later.labels,
    milestone:later.milestone,
    number:202,
    url:"https://github.com/TOSS-Soft/toss-cli/issues/202",
  };
  const adapter=fakeAdapter({seed:[
    duplicate,
    {...duplicate,number:203,url:"https://github.com/TOSS-Soft/toss-cli/issues/203"},
  ]});
  const store=fakeStore();

  await assert.rejects(
    configuredWriter({adapter,store}).publish(context,{
      apply:true,
      authority:authorityFor(context),
    }),
    /duplicate|multiple|conflict/i,
  );
  assert.equal(adapter.created.length,0);
  assert.equal(adapter.updated.length,0);
  assert.equal(store.calls.some(call => call.method==="append"),false);
});

test("two local markers cannot claim the same remote number or URL during preflight",async () => {
  const context=readyContext({twoIssues:true});
  const adapter=fakeAdapter();
  const store=fakeStore();
  const preview=await configuredWriter({adapter,store}).preview(context);
  const byMarker=new Map(preview.operations.map(operation => [operation.marker,operation]));
  adapter.findByMarker=async marker => {
    adapter.calls.push({method:"findByMarker",marker});
    const operation=byMarker.get(marker);
    return [{
      repository:operation.repository,
      marker,
      title:operation.title,
      body:operation.body,
      labels:operation.labels,
      milestone:operation.milestone,
      number:101,
      url:"https://github.com/TOSS-Soft/toss-cli/issues/101",
    }];
  };

  await assert.rejects(
    configuredWriter({adapter,store}).publish(context,{
      apply:true,
      authority:authorityFor(context),
    }),
    /remote.*number|remote.*url|multiple local|collision|conflict/i,
  );
  assert.equal(adapter.created.length,0);
  assert.equal(adapter.updated.length,0);
  assert.equal(store.calls.some(call => call.method==="append"),false);
});

test("preflight rejects a remote identity claimed by immutable history from another plan",async () => {
  const firstContext=readyContext();
  const store=fakeStore();
  await configuredWriter({adapter:fakeAdapter(),store}).publish(firstContext,{
    apply:true,
    authority:authorityFor(firstContext),
  });
  const appendCount=store.calls.filter(call => call.method==="append").length;

  const context=readyContext();
  context.artifacts.issuePlan.artifact_id="ISSUE-PLAN-002";
  rehash(context.artifacts.issuePlan);
  rebuildReadyContext(context);
  const preview=await configuredWriter({adapter:fakeAdapter(),store:fakeStore()})
    .preview(context);
  const operation=preview.operations[0];
  const adapter=fakeAdapter({seed:[{
    repository:operation.repository,
    marker:operation.marker,
    title:operation.title,
    body:operation.body,
    labels:operation.labels,
    milestone:operation.milestone,
    number:101,
    url:"https://github.com/TOSS-Soft/toss-cli/issues/101",
  }]});
  const record={record_id:"PUB-APPROVAL-002",revision:1};

  await assert.rejects(
    configuredWriter({adapter,store}).publish(context,{
      apply:true,
      authority:authorityFor(context,{
        record_id:record.record_id,
        record_sha256:sha256Canonical(record),
      }),
    }),
    /immutable.*number|immutable.*url|multiple local|collision|conflict/i,
  );
  assert.equal(adapter.created.length,0);
  assert.equal(adapter.updated.length,0);
  assert.equal(store.calls.filter(call => call.method==="append").length,appendCount);
});

test("a prospective create mapping is validated against whole history before append",async () => {
  const context=readyContext({twoIssues:true});
  const adapter=fakeAdapter();
  const store=fakeStore();
  adapter.createIssue=async payload => {
    adapter.calls.push({method:"createIssue",payload:clone(payload)});
    const issue={
      ...clone(payload),
      number:101,
      url:"https://github.com/TOSS-Soft/toss-cli/issues/101",
    };
    adapter.created.push(issue);
    return clone(issue);
  };

  await assert.rejects(
    configuredWriter({adapter,store}).publish(context,{
      apply:true,
      authority:authorityFor(context),
    }),
    /mapping.*number|mapping.*url|history|collision|conflict/i,
  );
  assert.equal(adapter.created.length,2);
  assert.equal(store.artifacts.length,1);
  assert.deepEqual(store.artifacts[0].content.mappings.map(mapping =>
    mapping.local_issue_id),["ISSUE-001"]);
});

test("create result must exactly match the desired remote issue before persistence",async () => {
  const context=readyContext();
  const adapter=fakeAdapter();
  const createIssue=adapter.createIssue;
  adapter.createIssue=async payload => ({
    ...await createIssue(payload),
    title:"GitHub returned a different title",
  });
  const store=fakeStore();

  await assert.rejects(
    configuredWriter({adapter,store}).publish(context,{
      apply:true,
      authority:authorityFor(context),
    }),
    /create result|desired|match/i,
  );
  assert.equal(store.artifacts.length,0);
});

test("update result must exactly match desired fields and an exact update reruns idempotently",async () => {
  const context=readyContext();
  const preview=await configuredWriter({adapter:fakeAdapter(),store:fakeStore()})
    .preview(context);
  const desired=preview.operations[0];
  const stale={
    repository:desired.repository,
    marker:desired.marker,
    title:"stale title",
    body:desired.body,
    labels:desired.labels,
    milestone:desired.milestone,
    number:101,
    url:"https://github.com/TOSS-Soft/toss-cli/issues/101",
  };
  const mismatched=fakeAdapter({seed:[stale]});
  const updateIssue=mismatched.updateIssue;
  mismatched.updateIssue=async (number,payload) => ({
    ...await updateIssue(number,payload),
    body:"GitHub returned a different body",
  });
  const mismatchedStore=fakeStore();
  await assert.rejects(
    configuredWriter({adapter:mismatched,store:mismatchedStore}).publish(context,{
      apply:true,
      authority:authorityFor(context),
    }),
    /update result|desired|match/i,
  );
  assert.equal(mismatchedStore.artifacts.length,0);

  const adapter=fakeAdapter({seed:[stale]});
  const store=fakeStore();
  const writer=configuredWriter({adapter,store});
  const first=await writer.publish(context,{apply:true,authority:authorityFor(context)});
  const second=await writer.publish(context,{apply:true,authority:authorityFor(context)});
  assert.equal(first.status,"complete");
  assert.deepEqual(second.mappings,first.mappings);
  assert.equal(adapter.updated.length,1);
  assert.equal(adapter.created.length,0);
});

test("a find outage after completion retains the complete artifact and reruns cleanly",async () => {
  const context=readyContext();
  const adapter=fakeAdapter();
  const store=fakeStore();
  const complete=await configuredWriter({adapter,store})
    .publish(context,{apply:true,authority:authorityFor(context)});
  const appendCount=store.calls.filter(call => call.method==="append").length;
  const findByMarker=adapter.findByMarker;
  adapter.findByMarker=async marker => {
    adapter.calls.push({method:"findByMarker",marker});
    const error=new Error("temporary find outage");
    error.code="API_UNAVAILABLE";
    error.retryable=true;
    throw error;
  };

  const outage=await configuredWriter({adapter,store})
    .publish(context,{apply:true,authority:authorityFor(context)});
  assert.equal(outage.status,"retryable");
  assert.deepEqual(outage.artifact,complete.artifact);
  assert.equal(store.calls.filter(call => call.method==="append").length,appendCount);

  adapter.findByMarker=findByMarker;
  const rerun=await configuredWriter({adapter,store})
    .publish(context,{apply:true,authority:authorityFor(context)});
  assert.equal(rerun.status,"complete");
  assert.deepEqual(rerun.artifact,complete.artifact);
  assert.equal(store.calls.filter(call => call.method==="append").length,appendCount);
});

test("an update outage after completion retains the complete artifact and reruns cleanly",async () => {
  const context=readyContext();
  const adapter=fakeAdapter();
  const store=fakeStore();
  const complete=await configuredWriter({adapter,store})
    .publish(context,{apply:true,authority:authorityFor(context)});
  const appendCount=store.calls.filter(call => call.method==="append").length;
  adapter.remote[0].title="stale after completion";
  const updateIssue=adapter.updateIssue;
  adapter.updateIssue=async (number,payload) => {
    adapter.calls.push({method:"updateIssue",number,payload:clone(payload)});
    const error=new Error("temporary update outage");
    error.code="RATE_LIMITED";
    error.retryable=true;
    throw error;
  };

  const outage=await configuredWriter({adapter,store})
    .publish(context,{apply:true,authority:authorityFor(context)});
  assert.equal(outage.status,"retryable");
  assert.deepEqual(outage.artifact,complete.artifact);
  assert.equal(store.calls.filter(call => call.method==="append").length,appendCount);

  adapter.updateIssue=updateIssue;
  const rerun=await configuredWriter({adapter,store})
    .publish(context,{apply:true,authority:authorityFor(context)});
  assert.equal(rerun.status,"complete");
  assert.deepEqual(rerun.artifact,complete.artifact);
  assert.equal(adapter.updated.length,1);
  assert.equal(store.calls.filter(call => call.method==="append").length,appendCount);
});

test("a partial rate-limit failure persists verified facts and resumes only missing creates",async () => {
  const context=readyContext({twoIssues:true});
  const adapter=fakeAdapter({failCreateAt:2});
  const store=fakeStore();
  const writer=configuredWriter({adapter,store});

  const partial=await writer.publish(context,{apply:true,authority:authorityFor(context)});
  assert.equal(partial.status,"retryable");
  assert.deepEqual(partial.mappings.map(mapping => mapping.local_issue_id),["ISSUE-001"]);
  assert.equal(partial.failures[0].code,"RATE_LIMITED");

  const resumedAdapter={...adapter};
  resumedAdapter.createIssue=async payload => {
    const number=adapter.remote.length+101;
    const issue={
      ...clone(payload),number,
      url:`https://github.com/TOSS-Soft/toss-cli/issues/${number}`,
      marker:payload.marker,
    };
    adapter.calls.push({method:"createIssue",payload:clone(payload)});
    adapter.remote.push(issue);
    adapter.created.push(issue);
    return clone(issue);
  };
  const resumed=configuredWriter({adapter:resumedAdapter,store});
  const complete=await resumed.publish(context,{apply:true,authority:authorityFor(context)});

  assert.equal(complete.status,"complete");
  assert.deepEqual(complete.mappings.map(mapping => mapping.local_issue_id),[
    "ISSUE-001","ISSUE-002",
  ]);
  assert.equal(adapter.created.filter(issue => issue.marker.includes("ISSUE-001")).length,1);
  assert.equal(adapter.created.filter(issue => issue.marker.includes("ISSUE-002")).length,1);
});

test("remote create success followed by local append failure recovers by marker",async () => {
  const context=readyContext();
  const adapter=fakeAdapter();
  const failingStore=fakeStore({failAppendAt:1});
  const writer=configuredWriter({adapter,store:failingStore});

  await assert.rejects(
    writer.publish(context,{apply:true,authority:authorityFor(context)}),
    /artifact store/i,
  );
  assert.equal(adapter.created.length,1);

  const recoveredStore=fakeStore();
  const recovered=configuredWriter({adapter,store:recoveredStore});
  const result=await recovered.publish(context,{apply:true,authority:authorityFor(context)});

  assert.equal(result.status,"complete");
  assert.equal(adapter.created.length,1);
  assert.equal(result.mappings[0].number,101);
});

test("duplicate markers and conflicting local history fail closed before mutation",async () => {
  const context=readyContext();
  const preview=await configuredWriter({adapter:fakeAdapter(),store:fakeStore()})
    .preview(context);
  const operation=preview.operations[0];
  const duplicate={
    repository:operation.repository,
    marker:operation.marker,
    title:operation.title,
    body:operation.body,
    labels:operation.labels,
    milestone:operation.milestone,
    number:101,
    url:"https://github.com/TOSS-Soft/toss-cli/issues/101",
    marker:operation.marker,
  };
  const adapter=fakeAdapter({seed:[duplicate,{...duplicate,number:102,url:"https://github.com/TOSS-Soft/toss-cli/issues/102"}]});
  const store=fakeStore();
  const writer=configuredWriter({adapter,store});

  await assert.rejects(
    writer.publish(context,{apply:true,authority:authorityFor(context)}),
    /duplicate|multiple|conflict/i,
  );
  assert.equal(adapter.created.length,0);
  assert.equal(adapter.updated.length,0);
});

test("adapter and store contracts reject accessor methods without triggering them",() => {
  let accessorCalls=0;
  const adapter={
    get findByMarker() {
      accessorCalls+=1;
      return async () => [];
    },
    createIssue:async () => ({}),
    updateIssue:async () => ({}),
  };

  assert.throws(
    () => configuredWriter({adapter,store:fakeStore()}),
    /accessor|data property/i,
  );
  assert.equal(accessorCalls,0);

  const nonEnumerable=fakeAdapter();
  Object.defineProperty(nonEnumerable,"findByMarker",{
    value:nonEnumerable.findByMarker,
    enumerable:false,
  });
  assert.throws(
    () => configuredWriter({adapter:nonEnumerable,store:fakeStore()}),
    /enumerable data property/i,
  );
});

test("classified API, permission, and rate-limit failures return stable retryable artifacts",async () => {
  for (const failure of retryableErrors) {
    const context=readyContext();
    const before=clone(context);
    const adapter=fakeAdapter();
    adapter.createIssue=async () => {
      const error=new Error(failure.message);
      error.code=failure.code;
      error.retryable=failure.retryable;
      throw error;
    };
    const store=fakeStore();
    const result=await configuredWriter({adapter,store}).publish(context,{
      apply:true,
      authority:authorityFor(context),
    });

    assert.equal(result.status,"retryable",failure.code);
    assert.equal(result.failures[0].code,failure.code);
    assert.equal(result.artifact.content.status,"retryable");
    assert.equal(validateDocument(result.artifact,"github-publication-result.v1").valid,true);
    assert.deepEqual(context,before);
  }
});

test("adapter retryable booleans cannot expand the closed retryable code registry",async () => {
  const context=readyContext();
  const adapter=fakeAdapter();
  adapter.createIssue=async () => {
    const error=new Error("adapter called a validation failure retryable");
    error.code="VALIDATION_FAILED";
    error.retryable=true;
    throw error;
  };
  const store=fakeStore();

  await assert.rejects(
    configuredWriter({adapter,store}).publish(context,{
      apply:true,
      authority:authorityFor(context),
    }),
    error => error?.code==="VALIDATION_FAILED" &&
      !Object.hasOwn(error,"result"),
  );
  assert.equal(store.artifacts.length,0);

  const validStore=fakeStore();
  const validAdapter=fakeAdapter();
  validAdapter.createIssue=async () => {
    const error=new Error("rate limit");
    error.code="RATE_LIMITED";
    error.retryable=true;
    throw error;
  };
  const valid=await configuredWriter({adapter:validAdapter,store:validStore})
    .publish(context,{apply:true,authority:authorityFor(context)});
  const forged=clone(valid.artifact);
  forged.content.failures[0].code="VALIDATION_FAILED";
  rehash(forged);
  const validation=validateDocument(forged,"github-publication-result.v1");
  assert.equal(validation.valid,false);
  assert.match(
    validation.errors.map(error => error.message).join("\n"),
    /allowed values|enum/i,
  );
});

test("an append echo without exact verified persistence is rejected",async () => {
  const context=readyContext();
  const store=fakeStore();
  store.append=async draft => {
    store.calls.push({method:"append",draft:clone(draft)});
    return clone(draft);
  };

  await assert.rejects(
    configuredWriter({adapter:fakeAdapter(),store}).publish(context,{
      apply:true,
      authority:authorityFor(context),
    }),
    /verify|persist|artifact store/i,
  );
  assert.equal(store.calls.filter(call => call.method==="append").length,1);
  assert.ok(store.calls.some(call => call.method==="verify"));
  assert.equal(store.artifacts.length,0);
});

test("remote issue boundaries reject unknown enumerable fields",async () => {
  const context=readyContext();
  const adapter=fakeAdapter();
  const createIssue=adapter.createIssue;
  adapter.createIssue=async payload => ({
    ...await createIssue(payload),
    unexpected_remote_fact:true,
  });
  const store=fakeStore();

  await assert.rejects(
    configuredWriter({adapter,store}).publish(context,{
      apply:true,
      authority:authorityFor(context),
    }),
    /unsupported field|unknown field|closed/i,
  );
  assert.equal(store.artifacts.length,0);
});

test("malformed adapter and store return accessors fail closed without triggering them",async () => {
  const context=readyContext();
  let adapterAccessorCalls=0;
  const badRemote={
    get number() {
      adapterAccessorCalls+=1;
      return 101;
    },
    url:"https://github.com/TOSS-Soft/toss-cli/issues/101",
    repository:context.repository,
    marker:"wrong",
    title:"wrong",
    body:"wrong",
    labels:[],
    milestone:null,
  };
  const adapter=fakeAdapter();
  adapter.findByMarker=async () => [badRemote];
  await assert.rejects(
    configuredWriter({adapter,store:fakeStore()}).publish(context,{
      apply:true,authority:authorityFor(context),
    }),
    /canonical json/i,
  );
  assert.equal(adapterAccessorCalls,0);

  let storeAccessorCalls=0;
  const listed=[];
  Object.defineProperty(listed,"0",{
    enumerable:true,
    get() {
      storeAccessorCalls+=1;
      return {};
    },
  });
  listed.length=1;
  const store=fakeStore();
  store.list=async () => listed;
  const untouched=fakeAdapter();
  await assert.rejects(
    configuredWriter({adapter:untouched,store}).publish(context,{
      apply:true,authority:authorityFor(context),
    }),
    /canonical json|history/i,
  );
  assert.equal(storeAccessorCalls,0);
  assert.deepEqual(untouched.calls,[]);
});

test("immutable approval records cannot replay across repositories",async () => {
  const firstContext=readyContext();
  const store=fakeStore();
  await configuredWriter({adapter:fakeAdapter(),store}).publish(firstContext,{
    apply:true,authority:authorityFor(firstContext),
  });
  const secondContext=readyContext();
  secondContext.repository="TOSS-Soft/other-repo";
  const adapter=fakeAdapter();

  await assert.rejects(
    configuredWriter({adapter,store}).publish(secondContext,{
      apply:true,authority:authorityFor(secondContext),
    }),
    /approval record.*replay|approval record.*conflict/i,
  );
  assert.deepEqual(adapter.calls,[]);
});

test("conflicting mapping revisions and unknown publication versions fail before GitHub access",async () => {
  const context=readyContext();
  const firstStore=fakeStore();
  const first=await configuredWriter({adapter:fakeAdapter(),store:firstStore})
    .publish(context,{apply:true,authority:authorityFor(context)});
  const conflicting=clone(first.artifact);
  conflicting.revision=2;
  conflicting.parents=[artifactReference(first.artifact)];
  conflicting.content.mappings[0].number=999;
  conflicting.content.mappings[0].url="https://github.com/TOSS-Soft/toss-cli/issues/999";
  rehash(conflicting);
  const adapter=fakeAdapter();
  await assert.rejects(
    configuredWriter({adapter,store:fakeStore({seed:[first.artifact,conflicting]})
      })
      .publish(context,{apply:true,authority:authorityFor(context)}),
    /mapping conflicts/i,
  );
  assert.deepEqual(adapter.calls,[]);

  const unknown=clone(first.artifact);
  unknown.schema_version="acp.v2";
  const unknownAdapter=fakeAdapter();
  await assert.rejects(
    configuredWriter({adapter:unknownAdapter,store:fakeStore({seed:[unknown]})})
      .publish(context,{apply:true,authority:authorityFor(context)}),
    /unknown publication-result version|corrupt/i,
  );
  assert.deepEqual(unknownAdapter.calls,[]);
});

test("every historical approval is authenticated against immutable registry provenance",async () => {
  const context=readyContext();
  const firstStore=fakeStore();
  const first=await configuredWriter({adapter:fakeAdapter(),store:firstStore})
    .publish(context,{apply:true,authority:authorityFor(context)});
  const tampered=clone(first.artifact);
  tampered.content.approval_record.signature=
    `A${tampered.content.approval_record.signature.slice(1)}`;
  rehash(tampered);
  const adapter=fakeAdapter();

  await assert.rejects(
    configuredWriter({adapter,store:fakeStore({seed:[tampered]})}).publish(context,{
      apply:true,
      authority:authorityFor(context,{record_id:"PUB-APPROVAL-002"}),
    }),
    /historical approval|signature|registry provenance/i,
  );
  assert.deepEqual(adapter.calls,[]);
});

test("history requires exact gate inputs, cumulative sorted mappings, and coherent failures",async () => {
  const context=readyContext({twoIssues:true});
  const partialStore=fakeStore();
  await configuredWriter({adapter:fakeAdapter({failCreateAt:2}),store:partialStore})
    .publish(context,{apply:true,authority:authorityFor(context)});
  assert.equal(partialStore.artifacts.length,2);

  const inputTamper=clone(partialStore.artifacts.at(-1));
  inputTamper.inputs=[artifactReference(context.artifacts.issuePlan)];
  const inputAdapter=fakeAdapter();
  await assert.rejects(
    configuredWriter({adapter:inputAdapter,store:fakeStore({seed:[
      partialStore.artifacts[0],inputTamper,
    ]})}).publish(context,{
      apply:true,
      authority:authorityFor(context,{record_id:"PUB-APPROVAL-INPUTS"}),
    }),
    /exact.*plan.*audit.*state|gate inputs/i,
  );
  assert.deepEqual(inputAdapter.calls,[]);

  const dropped=clone(partialStore.artifacts.at(-1));
  dropped.content.mappings=[];
  rehash(dropped);
  const droppedAdapter=fakeAdapter();
  await assert.rejects(
    configuredWriter({adapter:droppedAdapter,store:fakeStore({seed:[
      partialStore.artifacts[0],dropped,
    ]})}).publish(context,{
      apply:true,
      authority:authorityFor(context,{record_id:"PUB-APPROVAL-DROPPED"}),
    }),
    /cumulative|mapping.*superset/i,
  );
  assert.deepEqual(droppedAdapter.calls,[]);

  const conflictingFailure=clone(partialStore.artifacts.at(-1));
  conflictingFailure.content.failures[0].local_issue_id="ISSUE-001";
  rehash(conflictingFailure);
  const failureAdapter=fakeAdapter();
  await assert.rejects(
    configuredWriter({adapter:failureAdapter,store:fakeStore({seed:[
      partialStore.artifacts[0],conflictingFailure,
    ]})}).publish(context,{
      apply:true,
      authority:authorityFor(context,{record_id:"PUB-APPROVAL-FAILURE"}),
    }),
    /failure.*mapped|status.*failure/i,
  );
  assert.deepEqual(failureAdapter.calls,[]);

  const completeStore=fakeStore();
  await configuredWriter({adapter:fakeAdapter(),store:completeStore})
    .publish(context,{apply:true,authority:authorityFor(context)});
  const reversed=clone(completeStore.artifacts.at(-1));
  reversed.content.mappings.reverse();
  rehash(reversed);
  const sortedAdapter=fakeAdapter();
  await assert.rejects(
    configuredWriter({adapter:sortedAdapter,store:fakeStore({seed:[
      ...completeStore.artifacts.slice(0,-1),reversed,
    ]})}).publish(context,{
      apply:true,
      authority:authorityFor(context,{record_id:"PUB-APPROVAL-SORT"}),
    }),
    /mapping.*sorted|canonical.*mapping/i,
  );
  assert.deepEqual(sortedAdapter.calls,[]);
});

test("corrupt completion claims and missing plan lineage fail before GitHub access",async () => {
  const context=readyContext({twoIssues:true});
  const partialStore=fakeStore();
  await configuredWriter({adapter:fakeAdapter({failCreateAt:2}),store:partialStore})
    .publish(context,{apply:true,authority:authorityFor(context)});
  const forgedComplete=clone(partialStore.artifacts[0]);
  forgedComplete.content.status="complete";
  rehash(forgedComplete);
  const completionAdapter=fakeAdapter();
  await assert.rejects(
    configuredWriter({
      adapter:completionAdapter,
      store:fakeStore({seed:[forgedComplete]}),
    }).publish(context,{apply:true,authority:authorityFor(context)}),
    /complete.*mapping|completion.*mapping/i,
  );
  assert.deepEqual(completionAdapter.calls,[]);

  const missingInput=clone(partialStore.artifacts[0]);
  missingInput.inputs=[];
  const lineageAdapter=fakeAdapter();
  await assert.rejects(
    configuredWriter({
      adapter:lineageAdapter,
      store:fakeStore({seed:[missingInput]}),
    }).publish(context,{apply:true,authority:authorityFor(context)}),
    /gate inputs.*exact plan.*audit.*state/i,
  );
  assert.deepEqual(lineageAdapter.calls,[]);
});

test("repository identity rejects URL and whitespace variants before injected calls",async () => {
  for (const repository of [
    "https://github.com/TOSS-Soft/toss-cli",
    " TOSS-Soft/toss-cli",
    "TOSS-Soft/toss-cli ",
  ]) {
    const context=readyContext();
    context.repository=repository;
    const adapter=fakeAdapter();
    const store=fakeStore();
    const writer=configuredWriter({adapter,store});
    await assert.rejects(writer.preview(context),/canonical owner\/name/i);
    assert.deepEqual(adapter.calls,[]);
    assert.deepEqual(store.calls,[]);
  }
});

test("publication result persists through the real immutable artifact store",async (t) => {
  const root=await mkdtemp(join(tmpdir(),"toss-github-writer-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  const store=createArtifactStore({
    root,
    now:() => new Date("2026-08-17T14:05:00.000Z"),
    randomId:() => "github-writer-test",
  });
  const context=readyContext();
  await appendArtifacts(store,context.artifacts);
  const recordedProvenance=artifact => ({
    ...clone(artifact),
    provenance:{
      source_revision:artifact.provenance.source_revision,
      source_sha256:artifact.provenance.source_sha256,
      locations:[`${artifact.document_type}:${artifact.artifact_id}`],
    },
  });
  await store.append(recordedProvenance(context.artifacts.specAudits[0]));
  await store.append(recordedProvenance(context.artifacts.analysisState));

  const result=await configuredWriter({adapter:fakeAdapter(),store}).publish(context,{
    apply:true,authority:authorityFor(context),
  });
  const persisted=await store.verify(artifactReference(result.artifact));

  assert.deepEqual(persisted,result.artifact);
  assert.equal(persisted.content.status,"complete");
  assert.equal(persisted.parents.length,0);
  assert.equal(persisted.inputs.length,3);
});
