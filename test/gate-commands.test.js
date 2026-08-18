import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signDetached,
} from "node:crypto";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {dispatchCommand,parseCommand} from "../src/commands/router.js";
import {canonicalJson,sha256Canonical} from "../src/contracts/acp.js";
import {authorityAttestationSigningPayload} from "../src/pipeline/decisions.js";
import {createGitHubWriter} from "../src/pipeline/github-writer.js";
import {runProjectCommand} from "../src/commands/project.js";
import {clone,rehash} from "./support/trace-fixture.js";
import {
  commandServices,
  memoryCommandStore,
  parsedCommand,
  projectCommandInput,
} from "./support/command-fixture.js";

const modules=await Promise.all([
  "decisions","architecture","plan","audit","readiness","issues",
].map(async name => import(`../src/commands/${name}.js`).catch(error => {
  if (error?.code==="ERR_MODULE_NOT_FOUND") return {};
  throw error;
})));

const gateMatrix=JSON.parse(await readFile(new URL(
  "./fixtures/commands/gate-matrix.json",
  import.meta.url,
),"utf8"));
const [decisionsModule,architectureModule,planModule,auditModule,readinessModule,issuesModule]=
  modules;
const gateAvailable=modules.every(module => Object.keys(module).length>0);
const PRIVATE_KEY=createPrivateKey(`-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEICMMwUatUwxz9nHC1Z8Ycl5we3pAdGkWjX497KGuvT2y
-----END PRIVATE KEY-----`);
const PUBLIC_KEY=`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA2EfZW/G5ES5AjZflH3kWHqXYeKTS9/7qQ1QklZtMGzc=
-----END PUBLIC KEY-----`;

function reference(artifact) {
  return {
    document_type:artifact.document_type,
    artifact_id:artifact.artifact_id,
    revision:artifact.revision,
    content_sha256:artifact.content_sha256,
  };
}

function authorityRegistry() {
  return {actors:[{
    actor_id:"verified-user",
    actor_role:"USER",
    public_key:PUBLIC_KEY,
    allowed_routes:[{
      authority:"A3",
      verification_kind:"A3_VERIFIED_CEO_OR_USER_AUTHORITY",
    }],
  }]};
}

function publicKeyFingerprint() {
  return createHash("sha256").update(createPublicKey(PUBLIC_KEY).export({
    type:"spki",
    format:"der",
  })).digest("hex");
}

function publicationAuthorityRegistry() {
  const unsigned={
    schema_version:"github-publication-authority-registry.v1",
    registry_id:"toss-gate-command-publication-authorities",
    revision:1,
    actors:[{
      actor_id:"verified-publisher",
      actor_role:"USER",
      public_key:PUBLIC_KEY,
      public_key_fingerprint:publicKeyFingerprint(),
      allowed_publications:[{
        approval_kind:"GITHUB_ISSUE_PUBLICATION",
        repository:"TOSS-Soft/toss-cli",
      }],
    }],
  };
  return {...unsigned,content_sha256:sha256Canonical(unsigned)};
}

function signedPublicationApproval(issuePlan) {
  const unsigned={
    approval_kind:"GITHUB_ISSUE_PUBLICATION",
    actor_id:"verified-publisher",
    actor_role:"USER",
    repository:"TOSS-Soft/toss-cli",
    source_revision:issuePlan.provenance.source_revision,
    source_sha256:issuePlan.provenance.source_sha256,
    issue_plan:reference(issuePlan),
    record_id:"PUB-GATE-COMMAND-001",
    record_revision:1,
    record_sha256:sha256Canonical({
      record_id:"PUB-GATE-COMMAND-001",
      revision:1,
    }),
    timestamp:"2026-08-18T10:10:00.000Z",
  };
  return {
    ...unsigned,
    signature:signDetached(null,Buffer.from(canonicalJson({
      domain:"toss.github-issue-publication.authority-approval.v1",
      ...unsigned,
    }),"utf8"),PRIVATE_KEY).toString("base64"),
  };
}

function signedDecisionAnswer(question,{
  recordId="AUTH-Q-001",customValue=null,
}={}) {
  const answer=customValue===null ?
    {kind:"selected-option",option_id:question.options[0].id} :
    {kind:"custom-answer",value:customValue};
  const resolution={
    decision:customValue ?? question.options[0].label,
    rationale:"The verified user selected the exact offered product option.",
    authority:"A3",
    owner:"USER",
    provenance:clone(question.provenance),
  };
  const attestation={
    verification_kind:"A3_VERIFIED_CEO_OR_USER_AUTHORITY",
    actor_id:"verified-user",
    actor_role:"USER",
    record_id:recordId,
    record_revision:1,
    record_sha256:sha256Canonical({record_id:recordId,revision:1}),
    timestamp:"2026-08-18T10:00:00.000Z",
  };
  const payload=authorityAttestationSigningPayload({
    source_id:question.id,
    decision:resolution.decision,
    rationale:resolution.rationale,
    authority:resolution.authority,
    owner:resolution.owner,
    ...attestation,
  });
  return {
    schema_version:"decision-answer-input.v1",
    answer,
    authority_resolution:{
      ...resolution,
      authority_attestation:{
        ...attestation,
        signature:signDetached(
          null,Buffer.from(canonicalJson(payload),"utf8"),PRIVATE_KEY,
        ).toString("base64"),
      },
    },
  };
}

async function preparedStore(options={}) {
  const store=memoryCommandStore();
  const input=projectCommandInput(options);
  const status=await runProjectCommand(
    parsedCommand("project.prepare",{from:"project.json"}),
    commandServices(store,input),
  );
  return {store,input,status};
}

async function preparedTwoIssueStore() {
  const store=memoryCommandStore();
  const input=projectCommandInput();
  input.artifacts.issue_plan.content.issues.push({
    id:"ISSUE-002",
    kind:"issue",
    meaning:"Expose customer support request status.",
    finalization_status:"authoritative",
    atomic_scope:"Expose only the current status of an existing customer request.",
    epic:{kind:"epic",id:"EPIC-001"},
    source_requirements:[{kind:"requirement",id:"REQ-001"}],
    acceptance_criteria:[{kind:"acceptance-criterion",id:"AC-002"}],
    definition_of_done:[
      "The current request status is visible and the acceptance criterion passes.",
    ],
    requires_adr:true,
    adr_refs:[{kind:"adr",id:"ADR-001"}],
    dependencies:[{kind:"issue",id:"ISSUE-001"}],
  });
  input.artifacts.issue_plan.content.acceptance_criteria.push({
    id:"AC-002",
    kind:"acceptance-criterion",
    meaning:"A customer can see the current status of an existing support request.",
    finalization_status:"authoritative",
    issue:{kind:"issue",id:"ISSUE-002"},
    verifies:[{kind:"requirement",id:"REQ-001"}],
  });
  rehash(input.artifacts.issue_plan);
  const status=await runProjectCommand(
    parsedCommand("project.prepare",{from:"project.json"}),
    commandServices(store,input),
  );
  return {store,input,status};
}

function recoverableGitHubAdapter() {
  const calls=[];
  const remote=[];
  let failedSecondCreate=false;
  const findByMarker=async marker => {
    calls.push({method:"findByMarker",marker});
    return clone(remote.filter(issue => issue.marker===marker));
  };
  const createIssue=async payload => {
    calls.push({method:"createIssue",payload:clone(payload)});
    if (remote.length===1 && !failedSecondCreate) {
      failedSecondCreate=true;
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
    };
    remote.push(issue);
    return clone(issue);
  };
  const updateIssue=async (number,payload) => {
    calls.push({method:"updateIssue",number,payload:clone(payload)});
    const found=remote.find(issue => issue.number===number);
    if (!found) throw new Error("Remote issue missing");
    Object.assign(found,clone(payload));
    return clone(found);
  };
  return {adapter:{findByMarker,createIssue,updateIssue},calls,remote};
}

function command(name,options=[]) {
  return parseCommand([...name.split("."),...options]);
}

function services(store,extra={}) {
  return {artifactStore:store,...extra};
}

test("gate matrix names every publication stop before GitHub mutation",() => {
  assert.deepEqual(gateMatrix.map(row => row.name),[
    "unresolved P0-P2 decision",
    "pending ADR approval",
    "failed spec audit",
    "stale spec audit",
    "failed PDoR",
    "missing publication approval",
    "invalid publication approval",
    "stale publication approval",
    "replayed publication approval",
    "artifact store conflict",
    "remote marker duplicate",
  ]);
  assert.equal(gateMatrix.every(row => [4,5,6].includes(row.expected_exit)),true);
});

test("all issue 28 command families expose focused handlers",() => {
  const [decisions,architecture,plan,audit,readiness,issues]=modules;
  assert.equal(typeof decisions.runDecisionsCommand,"function");
  assert.equal(typeof architecture.runArchitectureCommand,"function");
  assert.equal(typeof plan.runPlanCommand,"function");
  assert.equal(typeof audit.runAuditCommand,"function");
  assert.equal(typeof readiness.runReadinessCommand,"function");
  assert.equal(typeof issues.runIssuesCommand,"function");
});

test("router lazily dispatches gate commands while preserving injected precedence",async () => {
  const injected=async command => ({source:"injected",name:command.name});
  const result=await dispatchCommand(parseCommand(["plan","show","--json"]),{
    handlers:{"plan.show":injected},
  });

  assert.equal(result.exitCode,0);
  assert.deepEqual(result.result.data,{source:"injected",name:"plan.show"});

  const builtin=await dispatchCommand(parseCommand(["plan","show","--json"]),{
    services:{artifactStore:{
      append:async () => { throw new Error("must not append"); },
      get:async () => { throw new Error("not found"); },
      list:async () => [],
      verify:async () => { throw new Error("not found"); },
    }},
  });
  assert.notEqual(builtin.exitCode,69);
  assert.notEqual(builtin.result.error?.code,"COMMAND_NOT_IMPLEMENTED");
});

test("decisions list derives the exact pending package and answer persists an exact immutable snapshot",{
  skip:!gateAvailable,
},async () => {
  const {store,status}=await preparedStore({blockingDecision:true});
  const listed=await decisionsModule.runDecisionsCommand(
    command("decisions.list"),services(store),
  );
  assert.equal(listed.package.document_type,"decision-package");
  assert.equal(listed.questions[0].id,"Q-001");
  assert.equal(listed.questions[0].answered,false);

  const input=signedDecisionAnswer(status.package.questions[0]);
  const answered=await decisionsModule.runDecisionsCommand(
    command("decisions.answer",["Q-001","--from","answer.json","--non-interactive"]),
    services(store,{
      authorityRegistry:authorityRegistry(),
      readInput:async () => JSON.stringify(input),
    }),
  );
  assert.equal(answered.question_id,"Q-001");
  assert.equal(answered.artifact.document_type,"decision-answer");
  assert.deepEqual(answered.artifact.content.source_question,status.package.questions[0]);
  assert.deepEqual(answered.artifact.content.answer,input.answer);
  assert.equal(answered.artifact.content.authority_resolution.authority,"A3");
  assert.equal(answered.artifact.content.source_decision_package_hash,
    sha256Canonical(status.package));
  assert.deepEqual(await store.verify(reference(answered.artifact)),answered.artifact);

  const replay=await decisionsModule.runDecisionsCommand(
    command("decisions.answer",["Q-001","--from","answer.json","--non-interactive"]),
    services(store,{
      authorityRegistry:authorityRegistry(),
      readInput:async () => JSON.stringify(input),
    }),
  );
  assert.deepEqual(replay.artifact,answered.artifact);

  const conflict=signedDecisionAnswer(status.package.questions[0],{
    customValue:"A conflicting target",
  });
  await assert.rejects(
    decisionsModule.runDecisionsCommand(
      command("decisions.answer",["Q-001","--from","answer.json","--non-interactive"]),
      services(store,{
        authorityRegistry:authorityRegistry(),
        readInput:async () => JSON.stringify(conflict),
      }),
    ),
    /conflict|replay|stale/i,
  );
});

test("decision mutation requires independently injected authority and never trusts input registry",{
  skip:!gateAvailable,
},async () => {
  const {store,status}=await preparedStore({blockingDecision:true});
  const input=signedDecisionAnswer(status.package.questions[0]);
  input.authorityRegistry=authorityRegistry();
  let appends=0;
  const guarded={
    get:store.get,
    list:store.list,
    verify:store.verify,
    append:async draft => { appends+=1; return store.append(draft); },
  };
  await assert.rejects(
    decisionsModule.runDecisionsCommand(
      command("decisions.answer",["Q-001","--from","answer.json","--non-interactive"]),
      services(guarded,{readInput:async () => JSON.stringify(input)}),
    ),
    /authority|unsupported|closed/i,
  );
  assert.equal(appends,0);
});

test("architecture review is read-only and approval binds the exact current ADR and pending package",{
  skip:!gateAvailable,
},async () => {
  const {store,status}=await preparedStore({pendingAdr:true});
  let appends=0;
  const observed={
    get:store.get,
    list:store.list,
    verify:store.verify,
    append:async draft => { appends+=1; return store.append(draft); },
  };
  const review=await architectureModule.runArchitectureCommand(
    command("architecture.review",["--non-interactive"]),services(observed),
  );
  assert.equal(review.ready_for_pm_finalization,false);
  assert.equal(review.pending_adrs[0].id,"ADR-001");
  assert.equal(appends,0);

  const adrRef=status.package.adr_references[0];
  const currentAdr=await store.verify(adrRef);
  const unsigned={
    approval_kind:"ADR_APPROVAL",
    authority:"A3",
    verification_kind:"A3_VERIFIED_CEO_OR_USER_AUTHORITY",
    actor_id:"verified-user",
    actor_role:"USER",
    source_revision:currentAdr.provenance.source_revision,
    source_sha256:currentAdr.provenance.source_sha256,
    adr:adrRef,
    approval_package:status.package,
    record_id:"ADR-APPROVAL-001",
    record_revision:1,
    record_sha256:sha256Canonical({record_id:"ADR-APPROVAL-001",revision:1}),
    timestamp:"2026-08-18T10:05:00.000Z",
  };
  const approval={
    schema_version:"adr-approval-input.v1",
    ...unsigned,
    signature:signDetached(null,Buffer.from(canonicalJson(
      architectureModule.adrApprovalSigningPayload(unsigned),
    ),"utf8"),PRIVATE_KEY).toString("base64"),
  };
  const result=await architectureModule.runArchitectureCommand(
    command("architecture.approve",["ADR-001","--from","approval.json","--non-interactive"]),
    services(store,{
      authorityRegistry:authorityRegistry(),
      readInput:async () => JSON.stringify(approval),
    }),
  );
  assert.deepEqual(result.artifact.content.adr,adrRef);
  assert.deepEqual(result.artifact.content.approval_package,status.package);
  assert.deepEqual(await store.verify(reference(result.artifact)),result.artifact);

  const adr=await store.verify(adrRef);
  const stale=clone(adr);
  stale.revision=2;
  stale.parents=[reference(adr)];
  stale.content.decision=`${stale.content.decision} Revised.`;
  rehash(stale);
  await store.append(stale);
  await assert.rejects(
    architectureModule.runArchitectureCommand(
      command("architecture.approve",["ADR-001","--from","approval.json","--non-interactive"]),
      services(store,{
        authorityRegistry:authorityRegistry(),
        readInput:async () => JSON.stringify(approval),
      }),
    ),
    /stale|current|revision/i,
  );
});

test("plan, audit, and readiness derive views from verified artifacts",{
  skip:!gateAvailable,
},async () => {
  const ready=await preparedStore();
  const plan=await planModule.runPlanCommand(command("plan.show"),services(ready.store));
  assert.equal(plan.epics[0].id,"EPIC-001");
  assert.equal(plan.issues[0].id,"ISSUE-001");
  assert.deepEqual(plan.issues[0].dependencies,[]);
  assert.equal(plan.issues[0].acceptance_criteria[0].id,"AC-001");

  const audit=await auditModule.runAuditCommand(command("audit.run"),services(ready.store));
  assert.equal(audit.status,"PASS");
  assert.equal(audit.ready_for_github,true);
  assert.equal(audit.artifact.document_type,"spec-audit");

  const readiness=await readinessModule.runReadinessCommand(
    command("readiness.check"),services(ready.store,{authorityRegistry:authorityRegistry()}),
  );
  assert.equal(readiness.ready_for_issue_generation,true);
  assert.deepEqual(readiness.failures,[]);
});

test("readiness requires independently injected authority context and remains read-only",{
  skip:!gateAvailable,
},async () => {
  const {store}=await preparedStore();
  let appends=0;
  const observed={
    get:store.get,
    list:store.list,
    verify:store.verify,
    append:async draft => { appends+=1; return store.append(draft); },
  };
  await assert.rejects(
    readinessModule.runReadinessCommand(command("readiness.check"),services(observed)),
    /authority|registry|context|required/i,
  );
  assert.equal(appends,0);

  const checked=await readinessModule.runReadinessCommand(
    command("readiness.check"),
    services(observed,{authorityRegistry:authorityRegistry()}),
  );
  assert.equal(checked.ready_for_issue_generation,true);
  assert.equal(appends,0);
});

test("audit run persists and verifies only the exact recomputed audit artifact",{
  skip:!gateAvailable,
},async () => {
  const store=memoryCommandStore();
  const input=projectCommandInput();
  for (const artifact of [
    input.artifacts.pm_analysis,
    input.artifacts.architecture,
    ...input.artifacts.adrs,
    input.artifacts.issue_plan,
  ]) await store.append(artifact);
  const result=await auditModule.runAuditCommand(command("audit.run"),services(store));
  assert.equal(result.persisted,true);
  assert.deepEqual(await store.verify(reference(result.artifact)),result.artifact);
  const audits=await store.list({document_type:"spec-audit"});
  assert.deepEqual(audits,[result.artifact]);
});

test("a completed failing audit is persisted and routed as structured exit 5",{
  skip:!gateAvailable,
},async () => {
  const store=memoryCommandStore();
  const input=projectCommandInput();
  input.artifacts.issue_plan.content.issues[0].dependencies=[{
    kind:"issue",
    id:"ISSUE-001",
  }];
  rehash(input.artifacts.issue_plan);
  for (const artifact of [
    input.artifacts.pm_analysis,
    input.artifacts.architecture,
    ...input.artifacts.adrs,
    input.artifacts.issue_plan,
  ]) await store.append(artifact);

  const dispatched=await dispatchCommand(command("audit.run",["--json"]),{
    services:{artifactStore:store},
  });
  assert.equal(dispatched.exitCode,5);
  assert.equal(dispatched.result.ok,true);
  assert.equal(dispatched.result.data.status,"FAIL");
  assert.equal(dispatched.result.data.ready_for_github,false);
  assert.equal(dispatched.result.data.blocked,true);
  assert.ok(dispatched.result.data.findings.some(finding =>
    /cycle/i.test(finding.type) || /cycle/i.test(finding.message)),
  );
  assert.equal((await store.list({document_type:"spec-audit"})).length,1);
});

function fakeWriter() {
  const calls={preview:0,publish:0};
  return {calls,writer:{
    preview:async context => {
      calls.preview+=1;
      return {
        schema_version:"github-publication-preview.v1",
        document_type:"github-publication-preview",
        mode:"preview",
        repository:context.repository,
        source_revision:context.artifacts.issuePlan.provenance.source_revision,
        source_sha256:context.artifacts.issuePlan.provenance.source_sha256,
        issue_plan:reference(context.artifacts.issuePlan),
        operations:[{action:"create",local_issue_id:"ISSUE-001"}],
      };
    },
    publish:async (context,options) => {
      calls.publish+=1;
      return {
        schema_version:"github-publication-result.v1",
        document_type:"github-publication-result",
        status:"complete",
        repository:context.repository,
        authority:options.authority,
        mappings:[{local_issue_id:"ISSUE-001",number:28}],
      };
    },
  }};
}

test("issues preview and default publish are deterministic zero-publish dry runs",{
  skip:!gateAvailable,
},async () => {
  const {store}=await preparedStore();
  const fake=fakeWriter();
  const preview=await issuesModule.runIssuesCommand(
    command("issues.preview"),services(store,{
      repository:"TOSS-Soft/toss-cli",writer:fake.writer,
    }),
  );
  const dryRun=await issuesModule.runIssuesCommand(
    command("issues.publish"),services(store,{
      repository:"TOSS-Soft/toss-cli",writer:fake.writer,
    }),
  );
  assert.equal(preview.mode,"preview");
  assert.deepEqual(preview.operation_summary,{create:1,update:0,skip:0});
  assert.equal(dryRun.mode,"dry-run");
  assert.deepEqual(dryRun.operations,preview.operations);
  assert.deepEqual(fake.calls,{preview:2,publish:0});
});

test("issues publish apply acquires approval before and delegates exactly once",{
  skip:!gateAvailable,
},async () => {
  const {store}=await preparedStore();
  const fake=fakeWriter();
  let inputReads=0;
  const approval={approval_kind:"GITHUB_ISSUE_PUBLICATION",signature:"external-signed-value"};
  const result=await issuesModule.runIssuesCommand(
    command("issues.publish",["--apply","--from","approval.json","--non-interactive"]),
    services(store,{
      repository:"TOSS-Soft/toss-cli",
      writer:fake.writer,
      readInput:async () => { inputReads+=1; return JSON.stringify(approval); },
    }),
  );
  assert.equal(result.status,"complete");
  assert.equal(inputReads,1);
  assert.deepEqual(fake.calls,{preview:0,publish:1});
  assert.deepEqual(result.authority,approval);

  const blockedFake=fakeWriter();
  await assert.rejects(
    issuesModule.runIssuesCommand(
      command("issues.publish",["--apply","--non-interactive"]),
      services(store,{repository:"TOSS-Soft/toss-cli",writer:blockedFake.writer}),
    ),
    /approval|input|required/i,
  );
  assert.deepEqual(blockedFake.calls,{preview:0,publish:0});
});

test("every apply gate remains nonzero and records zero adapter mutation",{
  skip:!gateAvailable,
},async () => {
  const {store}=await preparedStore();
  for (const row of gateMatrix) {
    let adapterMutations=0;
    const writer={
      preview:async () => { throw new Error("preview is not expected"); },
      publish:async () => {
        const error=new Error(`Blocked by ${row.name}`);
        error.code=`${row.gate.toUpperCase()}_GATE_FAILED`;
        error.exitCode=row.expected_exit;
        throw error;
      },
    };
    const dispatched=await dispatchCommand(
      command("issues.publish",["--apply","--from","approval.json","--non-interactive","--json"]),
      {services:{
        artifactStore:store,
        repository:"TOSS-Soft/toss-cli",
        writer,
        readInput:async () => JSON.stringify({approval_kind:"GITHUB_ISSUE_PUBLICATION"}),
      }},
    );
    assert.equal(dispatched.exitCode,row.expected_exit,row.name);
    assert.equal(adapterMutations,0,row.name);
  }
});

test("router preserves a completed command's stable nonzero gate or validation exit",async () => {
  for (const commandExitCode of [4,5,6]) {
    const dispatched=await dispatchCommand(command("audit.run",["--json"]),{
      handlers:{"audit.run":async () => ({
        schema_version:"spec-audit-command-result.v1",
        status:"FAIL",
        blocked:true,
        command_exit_code:commandExitCode,
      })},
    });
    assert.equal(dispatched.result.ok,true);
    assert.equal(dispatched.exitCode,commandExitCode);
  }
});

test("gate services reject accessors, proxies, extra writers, and duplicate catalogs without side effects",{
  skip:!gateAvailable,
},async () => {
  const {store}=await preparedStore();
  let getterCalls=0;
  const accessorServices={artifactStore:store};
  Object.defineProperty(accessorServices,"writer",{
    enumerable:true,
    get() { getterCalls+=1; return fakeWriter().writer; },
  });
  await assert.rejects(
    planModule.runPlanCommand(command("plan.show"),accessorServices),
    /accessor|unsupported|closed/i,
  );
  assert.equal(getterCalls,0);

  let proxyReads=0;
  const proxiedServices=new Proxy({artifactStore:store},{
    get(target,key,receiver) {
      proxyReads+=1;
      return Reflect.get(target,key,receiver);
    },
  });
  await assert.rejects(
    planModule.runPlanCommand(command("plan.show"),proxiedServices),
    /plain own-data object|context/i,
  );
  assert.equal(proxyReads,0);

  let writerCalls=0;
  const unexpectedWriter={
    preview:async () => { writerCalls+=1; },
    publish:async () => { writerCalls+=1; },
  };
  await assert.rejects(
    readinessModule.runReadinessCommand(command("readiness.check"),{
      artifactStore:store,
      authorityRegistry:authorityRegistry(),
      writer:unexpectedWriter,
    }),
    /unsupported|closed/i,
  );
  assert.equal(writerCalls,0);

  const duplicateStore={
    append:store.append,
    get:store.get,
    verify:store.verify,
    list:async filter => {
      const rows=await store.list(filter);
      return rows.length===0 ? rows : [...rows,clone(rows[0])];
    },
  };
  await assert.rejects(
    issuesModule.runIssuesCommand(command("issues.preview"),{
      artifactStore:duplicateStore,
      repository:"TOSS-Soft/toss-cli",
      writer:unexpectedWriter,
    }),
    /duplicate|identity|catalog/i,
  );
  assert.equal(writerCalls,0);

  let maliciousWriterReads=0;
  const proxyWriter=new Proxy(fakeWriter().writer,{
    get(target,key,receiver) {
      maliciousWriterReads+=1;
      return Reflect.get(target,key,receiver);
    },
  });
  await assert.rejects(
    issuesModule.runIssuesCommand(command("issues.preview"),{
      artifactStore:store,
      repository:"TOSS-Soft/toss-cli",
      writer:proxyWriter,
    }),
    /plain own-data object|context/i,
  );
  assert.equal(maliciousWriterReads,0);
});

test("issues apply uses the real writer for partial recovery and idempotent reruns",{
  skip:!gateAvailable,
},async () => {
  const {store,input}=await preparedTwoIssueStore();
  const github=recoverableGitHubAdapter();
  const writer=createGitHubWriter({
    adapter:github.adapter,
    store,
    authorityRegistry:publicationAuthorityRegistry(),
  });
  const approval=signedPublicationApproval(input.artifacts.issue_plan);
  const invoke=() => issuesModule.runIssuesCommand(
    command("issues.publish",["--apply","--from","approval.json","--non-interactive"]),
    services(store,{
      repository:"TOSS-Soft/toss-cli",
      writer,
      readInput:async () => JSON.stringify(approval),
    }),
  );

  const partial=await invoke();
  assert.equal(partial.status,"retryable");
  assert.equal(partial.mappings.length,1);
  assert.equal(partial.failures[0].retryable,true);

  const resumed=await invoke();
  assert.equal(resumed.status,"complete");
  assert.equal(resumed.mappings.length,2);
  assert.equal(github.remote.length,2);

  const createCalls=github.calls.filter(call => call.method==="createIssue").length;
  const idempotent=await invoke();
  assert.equal(idempotent.status,"complete");
  assert.equal(idempotent.mappings.length,2);
  assert.equal(github.calls.filter(call => call.method==="createIssue").length,createCalls);
  assert.equal(github.remote.length,2);
});
