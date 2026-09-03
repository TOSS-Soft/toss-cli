import assert from "node:assert/strict";
import test from "node:test";

import {sha256Canonical} from "../src/contracts/acp.js";
import {validateDocument} from "../src/contracts/validator.js";
import {CoreConflictError,CoreValidationError} from "../src/core/errors.js";

const RELEASE_EVENTS=Object.freeze([
  "ACTIVATE","PAUSE_FOR_PATCH","RESUME_AFTER_PATCH","SCOPE_DONE","APPROVE",
  "VERIFY_PUBLICATION",
]);
const RELEASE_PHASES=Object.freeze([
  "DRAFT","ACTIVE","PAUSED","READY_FOR_APPROVAL","PUBLISHING","RELEASED",
]);
const TIMESTAMP="2026-09-02T10:00:00.000Z";
const COMMIT="a".repeat(40);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deeplyFrozen(value,seen=new Set()) {
  if (value===null || typeof value!=="object" || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Reflect.ownKeys(value)
    .every(key => deeplyFrozen(value[key],seen));
}

function publicationEvidence({
  repository="TOSS-Soft/toss-cli",
  releaseId="REL-toss-cli-2.2.0",
  version="2.2.0",
  assets=null,
  sourceReceipt="RECEIPT-20260902-0004",
  verifiedAt="2026-09-02T09:03:00.000Z",
}={}) {
  const evidence={
    schema_version:"publication-evidence.v1",
    evidence_id:"PUB-20260902-0001",
    release_id:releaseId,
    repository,
    version,
    expected_revision:COMMIT,
    tag:{name:`v${version}`,target_revision:COMMIT},
    package:{name:"@toss-software/cli",version,integrity:"sha512-dGVzdA=="},
    github_release:{
      release_id:"R_kgDORelease1",
      tag_name:`v${version}`,
      target_revision:COMMIT,
      draft:false,
      prerelease:false,
      assets:assets ?? [{name:`toss-cli-${version}.tgz`,sha256:"b".repeat(64)}],
    },
    source_receipt:sourceReceipt,
    verified_at:verifiedAt,
  };
  return {...evidence,evidence_sha256:sha256Canonical(evidence)};
}

function releasePrIntent(version="2.2.0") {
  return {
    intent_id:"RELEASE-PR-INTENT-0001",
    head:`release/v${version}`,
    base:"main",
    expected_head_revision:COMMIT,
    recorded_at:TIMESTAMP,
  };
}

function releaseApproval({repository="TOSS-Soft/toss-cli",releaseId="REL-toss-cli-2.2.0",
  programId="TOSS-OS-R0007",version="2.2.0",manifestRevision="REV-0041",
  scopeId=`${repository}#42`,approvedAt="2026-09-02T09:02:00.000Z",
  sourceReceipt="RECEIPT-20260902-0003"}={}) {
  const commits=[{revision:COMMIT,author:"implementation-author",committer:"release-committer"}];
  const result={schema_version:"review-result.v1",review_id:"REVIEW-20260902-0017",
    repository,pull_request_number:17,reviewed_revision:COMMIT,
    reviewer:{identity:"reviewer",role:"independent-reviewer"},verdict:"APPROVED",
    freshness:"CURRENT",findings:[],unresolved:[],verification_evidence:["test:release-state"],
    follow_up_issues:[],reviewed_at:TIMESTAMP,recorded_at:TIMESTAMP};
  return {
    schema_version:"release-approval.v1",source_receipt:sourceReceipt,
    authority:{record_id:"AUTH-20260902-0001",sha256:"c".repeat(64)},
    program_id:programId,release_id:releaseId,manifest_revision:manifestRevision,
    manifest_sha256:"d".repeat(64),
    pull_request:{number:17,revision:"pr-17",head:`release/v${version}`,
      head_sha:COMMIT,base:"main",base_sha:"0".repeat(40),base_revision:"base-main-17"},
    review:{revision:"review-revision-17",result,
      formal_review:{state:"APPROVED",review_id:result.review_id,
        reviewed_revision:COMMIT,revision:"formal-review-17"},
      implementation_identity:{base_revision:"0".repeat(40),revision:COMMIT,
        pull_request_author:"implementation-author",commit_count:commits.length,
        commits_sha256:sha256Canonical(commits),commits}},
    scope:[{id:scopeId,revision:"issue-10-17",project_item_id:"PVTI_10",
      project_revision:"project-item-10-17",status:"Done",gate:"RELEASE_APPROVAL_REQUIRED"}],
    required_checks:["build"],
    checks:[{name:"build",revision:"check-build-17",head_sha:COMMIT,
      conclusion:"SUCCESS"}],
    rules_revision:"rules-17",policy_revision:"POLICY-0001",
    publication:{package_name:"@toss-software/cli",workflow:"publish.yml",
      required_assets:[`toss-cli-${version}.tgz`]},
    merge_result_revision:COMMIT,approved_at:approvedAt,
  };
}

function releaseHistory(phase) {
  const activate={
    event:"ACTIVATE",
    source_phase:"DRAFT",
    target_phase:"ACTIVE",
    timestamp:"2026-09-02T09:00:00.000Z",
    source_receipt:"RECEIPT-20260902-0001",
  };
  const scopeDone={
    event:"SCOPE_DONE",
    source_phase:"ACTIVE",
    target_phase:"READY_FOR_APPROVAL",
    timestamp:"2026-09-02T09:01:00.000Z",
    source_receipt:"RECEIPT-20260902-0002",
  };
  const approve={
    event:"APPROVE",
    source_phase:"READY_FOR_APPROVAL",
    target_phase:"PUBLISHING",
    timestamp:"2026-09-02T09:02:00.000Z",
    source_receipt:"RECEIPT-20260902-0003",
  };
  const verify={
    event:"VERIFY_PUBLICATION",
    source_phase:"PUBLISHING",
    target_phase:"RELEASED",
    timestamp:"2026-09-02T09:03:00.000Z",
    source_receipt:"RECEIPT-20260902-0004",
  };
  const pause={
    event:"PAUSE_FOR_PATCH",
    source_phase:"ACTIVE",
    target_phase:"PAUSED",
    timestamp:"2026-09-02T09:04:00.000Z",
    source_receipt:"RECEIPT-20260902-0005",
  };

  if (phase==="DRAFT") return [];
  if (phase==="ACTIVE") return [activate];
  if (phase==="PAUSED") return [activate,pause];
  if (phase==="READY_FOR_APPROVAL") return [activate,scopeDone];
  if (phase==="PUBLISHING") return [activate,scopeDone,approve];
  if (phase==="RELEASED") return [activate,scopeDone,approve,verify];
  throw new Error(`Unsupported fixture phase: ${phase}`);
}

function repositoryRelease({
  repository="TOSS-Soft/toss-cli",
  releaseId="REL-toss-cli-2.2.0",
  programId="TOSS-OS-R0007",
  phase="DRAFT",
  revision="REV-0042",
  version="2.2.0",
  transitions,
  evidence=null,
  approval,
  scope,
}={}) {
  const materialized=phase!=="DRAFT";
  return {
    schema_version:"repository-release.v1",
    release_id:releaseId,
    program_id:programId,
    repository,
    phase,
    revision,
    version:materialized ? version : null,
    milestone:materialized ? `v${version}` : null,
    branch:materialized ? `release/v${version}` : null,
    release_pr_intent:materialized ? releasePrIntent(version) : null,
    scope:scope ?? [`${repository}#42`],
    approval:approval===undefined && ["PUBLISHING","RELEASED"].includes(phase)
      ? releaseApproval({repository,releaseId,programId,version})
      : (approval ?? null),
    publication_evidence:evidence,
    transitions:transitions ?? releaseHistory(phase),
  };
}

function releaseProgram({
  programId="TOSS-OS-R0007",
  phase="ACTIVE",
  revision="REV-0007",
  releases=[repositoryRelease({phase:"ACTIVE"})],
  interrupts=null,
  deferredScope=[],
}={}) {
  return {
    schema_version:"release-program.v1",
    program_id:programId,
    phase,
    revision,
    repository_releases:releases,
    dependency_stages:releases.length===0 ? [] : [{
      stage:1,
      repository_release_ids:releases.map(release => release.release_id),
    }],
    selected_scope:releases.flatMap(release => release.scope.map(epicId => ({
      epic_id:epicId,
      outcome:"organizational-lifecycle",
      eligibility:{
        approved:true,
        unversioned:true,
        decomposed:true,
        registered_repository:true,
        unassigned:true,
      },
    }))),
    deferred_scope:deferredScope,
    rationale:releases.map(release => ({
      repository:release.repository,
      version:release.version ?? (release.repository==="TOSS-Soft/toss-cli" ? "2.2.0" : "1.4.0"),
      change_class:"minor",
      reasons:[{
        rule:"backward_compatible_feature",
        scope_ids:[...release.scope],
      }],
    })),
    interrupts,
    created_at:"2026-09-02T09:00:00.000Z",
    updated_at:"2026-09-02T10:00:00.000Z",
  };
}

function transitionEvent(event,expectedRevision,overrides={}) {
  return {
    event,
    expected_revision:expectedRevision,
    timestamp:TIMESTAMP,
    source_receipt:"RECEIPT-20260902-0001",
    activation:event==="ACTIVATE" ? {
      version:"2.2.0",
      milestone:"v2.2.0",
      branch:"release/v2.2.0",
      release_pr_intent:releasePrIntent(),
    } : null,
    ...overrides,
  };
}

async function releaseState() {
  return import("../src/core/release/state.js");
}

test("release contracts accept closed release, program, and publication evidence",() => {
  const evidence=publicationEvidence();
  const released=repositoryRelease({phase:"RELEASED",evidence});
  const program=releaseProgram({phase:"RELEASED",releases:[released]});

  for (const [schemaId,value] of [
    ["publication-evidence.v1",evidence],
    ["repository-release.v1",released],
    ["release-program.v1",program],
  ]) {
    assert.equal(validateDocument(value,schemaId).valid,true,schemaId);
  }
});

test("approval source-program and current release revisions may share the same canonical text",async () => {
  const {assertRepositoryConcurrency}=await releaseState();
  const publishing=repositoryRelease({phase:"PUBLISHING",revision:"REV-0042",
    approval:releaseApproval({manifestRevision:"REV-0042"})});
  assert.equal(assertRepositoryConcurrency([
    releaseProgram({phase:"PUBLISHING",revision:"REV-0042",releases:[publishing]}),
  ]),true);
});

test("program contracts preserve structured selected eligibility and lossless version rationale",async () => {
  const {assertRepositoryConcurrency}=await releaseState();
  const draft=releaseProgram({
    phase:"DRAFT",
    releases:[repositoryRelease()],
  });

  assert.equal(validateDocument(draft,"release-program.v1").valid,true);
  assert.equal(assertRepositoryConcurrency([draft]),true);
  assert.deepEqual(draft.selected_scope,[{
    epic_id:"TOSS-Soft/toss-cli#42",
    outcome:"organizational-lifecycle",
    eligibility:{
      approved:true,
      unversioned:true,
      decomposed:true,
      registered_repository:true,
      unassigned:true,
    },
  }]);
  assert.deepEqual(draft.rationale,[{
    repository:"TOSS-Soft/toss-cli",
    version:"2.2.0",
    change_class:"minor",
    reasons:[{
      rule:"backward_compatible_feature",
      scope_ids:["TOSS-Soft/toss-cli#42"],
    }],
  }]);
  assert.equal(draft.repository_releases[0].version,null);
});

test("program contracts reject legacy and lossy planning rationale shapes",() => {
  const program=releaseProgram();
  for (const candidate of [
    {...program,selected_scope:["TOSS-Soft/toss-cli#42"]},
    {...program,rationale:["Selected the highest-priority coherent outcome."]},
    {...program,rationale:[{
      ...program.rationale[0],
      reasons:["backward_compatible_feature:TOSS-Soft/toss-cli#42"],
    }]},
    {...program,selected_scope:[{
      ...program.selected_scope[0],
      eligibility:{...program.selected_scope[0].eligibility,approved:false},
    }]},
  ]) {
    assert.equal(validateDocument(candidate,"release-program.v1").valid,false);
  }
});

test("Draft and waiting records own no activated repository release resources",() => {
  const draft=repositoryRelease();
  assert.equal(validateDocument(draft,"repository-release.v1").valid,true);
  for (const field of ["version","milestone","branch","release_pr_intent"]) {
    assert.equal(validateDocument({...draft,[field]:field==="release_pr_intent"
      ? releasePrIntent()
      : "2.2.0"},"repository-release.v1").valid,false,field);
  }

  const active=repositoryRelease({phase:"ACTIVE"});
  assert.equal(validateDocument(active,"repository-release.v1").valid,true);
  for (const field of ["version","milestone","branch","release_pr_intent"]) {
    assert.equal(validateDocument({...active,[field]:null},"repository-release.v1").valid,false,field);
  }

  const waiting=releaseProgram({phase:"WAITING_FOR_EPIC",releases:[]});
  assert.equal(validateDocument(waiting,"release-program.v1").valid,true);
  for (const field of ["repository_releases","dependency_stages","selected_scope"]) {
    const populated={...waiting,[field]:field==="repository_releases"
      ? [repositoryRelease()]
      : field==="dependency_stages"
        ? [{stage:1,repository_release_ids:["REL-toss-cli-2.2.0"]}]
        : [releaseProgram().selected_scope[0]]};
    assert.equal(validateDocument(populated,"release-program.v1").valid,false,field);
  }
  assert.deepEqual(waiting.rationale,[]);
});

test("release contract nested records fail closed",() => {
  const active=repositoryRelease({phase:"ACTIVE"});
  assert.equal(validateDocument({
    ...active,
    release_pr_intent:{...active.release_pr_intent,unexpected:true},
  },"repository-release.v1").valid,false);

  const evidence=publicationEvidence();
  assert.equal(validateDocument({
    ...evidence,
    github_release:{...evidence.github_release,unexpected:true},
  },"publication-evidence.v1").valid,false);
  assert.equal(validateDocument({
    ...evidence,
    github_release:{
      ...evidence.github_release,
      assets:[{...evidence.github_release.assets[0],unexpected:true}],
    },
  },"publication-evidence.v1").valid,false);

  const program=releaseProgram();
  assert.equal(validateDocument({
    ...program,
    dependency_stages:[{...program.dependency_stages[0],unexpected:true}],
  },"release-program.v1").valid,false);
  assert.equal(validateDocument({
    ...program,
    deferred_scope:[{
      epic_id:"TOSS-Soft/toss-cli#99",
      reason_code:"UNAPPROVED",
      explanation:"Approval is missing.",
      blocking_ids:[],
      unexpected:true,
    }],
  },"release-program.v1").valid,false);
  assert.equal(validateDocument({
    ...program,
    selected_scope:[{
      ...program.selected_scope[0],
      eligibility:{...program.selected_scope[0].eligibility,unexpected:true},
    }],
  },"release-program.v1").valid,false);
  assert.equal(validateDocument({
    ...program,
    rationale:[{
      ...program.rationale[0],
      reasons:[{...program.rationale[0].reasons[0],unexpected:true}],
    }],
  },"release-program.v1").valid,false);
});

test("program contracts keep independent versions and exact patch interruption links",() => {
  const cli=repositoryRelease({phase:"ACTIVE"});
  const consoleRelease=repositoryRelease({
    repository:"TOSS-Soft/toss-console",
    releaseId:"REL-toss-console-1.4.0",
    phase:"ACTIVE",
    version:"1.4.0",
  });
  const coordinated=releaseProgram({releases:[cli,consoleRelease]});
  assert.equal(validateDocument(coordinated,"release-program.v1").valid,true);
  assert.equal(validateDocument({...coordinated,version:"2.2.0"},"release-program.v1").valid,false);

  const patch=repositoryRelease({
    releaseId:"REL-toss-cli-2.1.3",
    programId:"TOSS-OS-R0008",
    phase:"ACTIVE",
    version:"2.1.3",
  });
  const interrupted=releaseProgram({
    programId:"TOSS-OS-R0008",
    releases:[patch],
    interrupts:{
      program_id:"TOSS-OS-R0007",
      repository_release_id:"REL-toss-cli-2.2.0",
      paused_release_revision:"REV-0042",
    },
  });
  assert.equal(validateDocument(interrupted,"release-program.v1").valid,true);
  assert.equal(validateDocument({
    ...interrupted,
    interrupts:{...interrupted.interrupts,paused_release_revision:"42"},
  },"release-program.v1").valid,false);
});

test("repository release transitions follow only the six exact event pairs",async () => {
  const {approveRepositoryRelease,transitionRepositoryRelease}=await releaseState();
  const byPhase=new Map();
  let current=repositoryRelease();
  byPhase.set(current.phase,current);
  const expected=[
    ["ACTIVATE","ACTIVE"],
    ["PAUSE_FOR_PATCH","PAUSED"],
    ["RESUME_AFTER_PATCH","ACTIVE"],
    ["SCOPE_DONE","READY_FOR_APPROVAL"],
    ["APPROVE","PUBLISHING"],
    ["VERIFY_PUBLICATION","RELEASED"],
  ];

  for (const [event,target] of expected) {
    if (event==="VERIFY_PUBLICATION") {
      current={...current,publication_evidence:publicationEvidence({
        sourceReceipt:"RECEIPT-20260902-0001",verifiedAt:TIMESTAMP})};
    }
    const source=current;
    current=event==="APPROVE"
      ? approveRepositoryRelease(source,transitionEvent(event,source.revision),
        releaseApproval({releaseId:source.release_id,programId:source.program_id,
          version:source.version,manifestRevision:source.revision,scopeId:source.scope[0],
          approvedAt:TIMESTAMP,sourceReceipt:"RECEIPT-20260902-0001"}))
      : transitionRepositoryRelease(source,transitionEvent(event,source.revision));
    assert.equal(current.phase,target,event);
    assert.equal(current.revision,`REV-${String(42+current.transitions.length).padStart(4,"0")}`,event);
    assert.deepEqual(current.transitions.at(-1),{
      event,
      source_phase:source.phase,
      target_phase:target,
      timestamp:TIMESTAMP,
      source_receipt:"RECEIPT-20260902-0001",
    });
    assert.ok(deeplyFrozen(current),event);
    byPhase.set(target,current);
  }

  assert.equal(byPhase.get("PAUSED").branch,"release/v2.2.0");
  assert.equal(byPhase.get("RELEASED").publication_evidence.evidence_id,"PUB-20260902-0001");
});

test("persisted release history is anchored to DRAFT and the materialized phase",async () => {
  const {assertRepositoryConcurrency,transitionRepositoryRelease}=await releaseState();
  const invalidReleases=[
    repositoryRelease({phase:"DRAFT",transitions:releaseHistory("ACTIVE")}),
    repositoryRelease({phase:"ACTIVE",transitions:[]}),
    repositoryRelease({
      phase:"PAUSED",
      transitions:[{
        event:"PAUSE_FOR_PATCH",
        source_phase:"ACTIVE",
        target_phase:"PAUSED",
        timestamp:"2026-09-02T09:04:00.000Z",
        source_receipt:"RECEIPT-20260902-0005",
      }],
    }),
    repositoryRelease({phase:"PUBLISHING",transitions:releaseHistory("READY_FOR_APPROVAL")}),
  ];

  for (const release of invalidReleases) {
    assert.throws(
      () => assertRepositoryConcurrency([releaseProgram({releases:[release]})]),
      error => error instanceof CoreValidationError && error.exitCode===5,
    );
  }

  const forgedPublishing=repositoryRelease({
    phase:"PUBLISHING",
    evidence:publicationEvidence(),
    transitions:[],
  });
  assert.throws(
    () => transitionRepositoryRelease(
      forgedPublishing,transitionEvent("VERIFY_PUBLICATION",forgedPublishing.revision),
    ),
    error => error instanceof CoreValidationError && error.exitCode===5,
  );
});

test("every release event rejects every illegal source phase",async () => {
  const {transitionRepositoryRelease}=await releaseState();
  const validSourceByEvent=new Map([
    ["ACTIVATE","DRAFT"],
    ["PAUSE_FOR_PATCH","ACTIVE"],
    ["RESUME_AFTER_PATCH","PAUSED"],
    ["SCOPE_DONE","ACTIVE"],
    ["APPROVE","READY_FOR_APPROVAL"],
    ["VERIFY_PUBLICATION","PUBLISHING"],
  ]);

  for (const event of RELEASE_EVENTS) {
    for (const phase of RELEASE_PHASES) {
      if (phase===validSourceByEvent.get(event)) continue;
      const release=repositoryRelease({
        phase,
        evidence:phase==="RELEASED" ? publicationEvidence() : null,
      });
      assert.throws(
        () => transitionRepositoryRelease(release,transitionEvent(event,release.revision)),
        error => error instanceof CoreValidationError && error.exitCode===5 &&
          /illegal repository release transition/i.test(error.message),
        `${event} from ${phase}`,
      );
    }
  }
});

test("transitions enforce revision binding, canonical increments, evidence, and exact events",async () => {
  const {transitionRepositoryRelease}=await releaseState();
  const draft=repositoryRelease();

  assert.throws(
    () => transitionRepositoryRelease(draft,transitionEvent("ACTIVATE","REV-0041")),
    error => error instanceof CoreConflictError && error.exitCode===6,
  );
  for (const revision of ["42","REV-42","REV-0042x","REV-0000"] ) {
    assert.throws(
      () => transitionRepositoryRelease({...draft,revision},transitionEvent("ACTIVATE",revision)),
      CoreValidationError,
      revision,
    );
  }
  const overflow={...draft,revision:`REV-${Number.MAX_SAFE_INTEGER}`};
  assert.throws(
    () => transitionRepositoryRelease(overflow,transitionEvent("ACTIVATE",overflow.revision)),
    CoreValidationError,
  );
  assert.throws(
    () => transitionRepositoryRelease(draft,transitionEvent("SKIP",draft.revision)),
    CoreValidationError,
  );
  assert.throws(
    () => transitionRepositoryRelease(draft,{
      ...transitionEvent("ACTIVATE",draft.revision),unexpected:true,
    }),
    CoreValidationError,
  );
  assert.throws(
    () => transitionRepositoryRelease(draft,transitionEvent("ACTIVATE",draft.revision,{
      activation:{...transitionEvent("ACTIVATE",draft.revision).activation,milestone:"v2.2.1"},
    })),
    CoreValidationError,
  );
  assert.throws(
    () => transitionRepositoryRelease(repositoryRelease({phase:"ACTIVE"}),
      transitionEvent("PAUSE_FOR_PATCH","REV-0042",{
        activation:transitionEvent("ACTIVATE","REV-0042").activation,
      })),
    CoreValidationError,
  );

  const publishing=repositoryRelease({phase:"PUBLISHING"});
  assert.throws(
    () => transitionRepositoryRelease(
      publishing,transitionEvent("VERIFY_PUBLICATION",publishing.revision),
    ),
    CoreValidationError,
  );
});

test("state inputs are trap-safe and transition outputs are detached",async () => {
  const {transitionRepositoryRelease}=await releaseState();
  let traps=0;
  const hostile=new Proxy({}, {
    get() { traps+=1; throw new Error("get trap"); },
    getOwnPropertyDescriptor() { traps+=1; throw new Error("descriptor trap"); },
    getPrototypeOf() { traps+=1; throw new Error("prototype trap"); },
    ownKeys() { traps+=1; throw new Error("keys trap"); },
  });
  assert.throws(() => transitionRepositoryRelease(hostile,hostile),CoreValidationError);
  assert.equal(traps,0);

  let getterCalls=0;
  const draft=repositoryRelease();
  Object.defineProperty(draft,"phase",{
    enumerable:true,
    get() { getterCalls+=1; return "DRAFT"; },
  });
  assert.throws(
    () => transitionRepositoryRelease(draft,transitionEvent("ACTIVATE","REV-0042")),
    CoreValidationError,
  );
  assert.equal(getterCalls,0);

  const mutable=repositoryRelease();
  const inputEvent=transitionEvent("ACTIVATE",mutable.revision);
  const result=transitionRepositoryRelease(mutable,inputEvent);
  mutable.scope[0]="TOSS-Soft/toss-cli#99";
  inputEvent.activation.release_pr_intent.base="develop";
  assert.deepEqual(result.scope,["TOSS-Soft/toss-cli#42"]);
  assert.equal(result.release_pr_intent.base,"main");
  assert.ok(deeplyFrozen(result));
});

test("ordinary closed hostile event names fail typed without primitive coercion",async () => {
  const {transitionRepositoryRelease}=await releaseState();
  const release=repositoryRelease();
  const event=transitionEvent("ACTIVATE",release.revision,{
    event:{toString:"not-callable",valueOf:"not-callable"},
  });

  assert.throws(
    () => transitionRepositoryRelease(release,event),
    error => error instanceof CoreValidationError && error.exitCode===5 &&
      !/Cannot convert object to primitive/.test(error.message),
  );
});

test("repository concurrency permits independent repositories and a retained paused branch",async () => {
  const {assertRepositoryConcurrency}=await releaseState();
  const cli=repositoryRelease({phase:"ACTIVE"});
  const consoleRelease=repositoryRelease({
    repository:"TOSS-Soft/toss-console",
    releaseId:"REL-toss-console-1.4.0",
    programId:"TOSS-OS-R0007",
    phase:"PUBLISHING",
    version:"1.4.0",
  });
  assert.equal(assertRepositoryConcurrency([
    releaseProgram({phase:"PUBLISHING",releases:[cli,consoleRelease]}),
  ]),true);

  const paused=repositoryRelease({phase:"PAUSED"});
  const patch=repositoryRelease({
    releaseId:"REL-toss-cli-2.1.3",
    programId:"TOSS-OS-R0008",
    phase:"ACTIVE",
    version:"2.1.3",
  });
  assert.equal(assertRepositoryConcurrency([
    releaseProgram({phase:"PAUSED",releases:[paused]}),
    releaseProgram({programId:"TOSS-OS-R0008",releases:[patch],interrupts:{
      program_id:"TOSS-OS-R0007",
      repository_release_id:"REL-toss-cli-2.2.0",
      paused_release_revision:"REV-0042",
    }}),
  ]),true);
  assert.equal(paused.branch,"release/v2.2.0");
});

test("repository concurrency rejects overlapping and duplicate repository tracks",async () => {
  const {assertRepositoryConcurrency}=await releaseState();
  const active=repositoryRelease({phase:"ACTIVE"});
  const publishing=repositoryRelease({
    releaseId:"REL-toss-cli-2.1.3",
    programId:"TOSS-OS-R0008",
    phase:"PUBLISHING",
    version:"2.1.3",
  });
  assert.throws(
    () => assertRepositoryConcurrency([
      releaseProgram({releases:[active]}),
      releaseProgram({programId:"TOSS-OS-R0008",phase:"PUBLISHING",releases:[publishing]}),
    ]),
    error => error instanceof CoreConflictError && error.exitCode===6 &&
      /TOSS-Soft\/toss-cli.*REL-toss-cli-2\.1\.3.*REL-toss-cli-2\.2\.0/i.test(error.message),
  );

  const duplicateDrafts=[
    repositoryRelease(),
    repositoryRelease({releaseId:"REL-toss-cli-next",revision:"REV-0001"}),
  ];
  assert.throws(
    () => assertRepositoryConcurrency([
      releaseProgram({phase:"DRAFT",releases:duplicateDrafts}),
    ]),
    CoreValidationError,
  );
});

test("release scope identities must belong to the release repository",async () => {
  const {assertRepositoryConcurrency}=await releaseState();
  const release=repositoryRelease({
    phase:"ACTIVE",
    scope:["TOSS-Soft/toss-console#42"],
  });

  assert.throws(
    () => assertRepositoryConcurrency([releaseProgram({releases:[release]})]),
    error => error instanceof CoreValidationError && error.exitCode===5,
  );
});

test("nested set-like release collections require canonical logical identity order",async () => {
  const {assertRepositoryConcurrency}=await releaseState();
  const invalidPrograms=[
    releaseProgram({deferredScope:[
      {
        epic_id:"TOSS-Soft/toss-cli#99",
        reason_code:"DEPENDENCY_MISSING",
        blocking_ids:[],
        explanation:"Later work first.",
      },
      {
        epic_id:"TOSS-Soft/toss-cli#98",
        reason_code:"OUTCOME_NOT_SELECTED",
        blocking_ids:[],
        explanation:"Earlier work second.",
      },
    ]}),
    releaseProgram({deferredScope:[
      {
        epic_id:"TOSS-Soft/toss-cli#99",
        reason_code:"DEPENDENCY_MISSING",
        blocking_ids:[],
        explanation:"First explanation.",
      },
      {
        epic_id:"TOSS-Soft/toss-cli#99",
        reason_code:"OUTCOME_NOT_SELECTED",
        blocking_ids:[],
        explanation:"Different object with the same identity.",
      },
    ]}),
    releaseProgram({deferredScope:[{
      epic_id:"TOSS-Soft/toss-cli#99",
      reason_code:"DEPENDENCY_MISSING",
      blocking_ids:["TOSS-Soft/toss-cli#42","TOSS-Soft/toss-cli#41"],
      explanation:"Blocking identities are descending.",
    }]}),
    releaseProgram({deferredScope:[{
      epic_id:"TOSS-Soft/toss-cli#99",
      reason_code:"DEPENDENCY_MISSING",
      blocking_ids:["TOSS-Soft/toss-cli#41","TOSS-Soft/toss-cli#41"],
      explanation:"Blocking identities are duplicated.",
    }]}),
  ];

  for (const program of invalidPrograms) {
    assert.throws(
      () => assertRepositoryConcurrency([program]),
      error => error instanceof CoreValidationError && error.exitCode===5,
    );
  }

  for (const assets of [
    [
      {name:"z-package.tgz",sha256:"c".repeat(64)},
      {name:"a-package.tgz",sha256:"d".repeat(64)},
    ],
    [
      {name:"package.tgz",sha256:"c".repeat(64)},
      {name:"package.tgz",sha256:"d".repeat(64)},
    ],
  ]) {
    const release=repositoryRelease({
      phase:"RELEASED",
      evidence:publicationEvidence({assets}),
    });
    assert.throws(
      () => assertRepositoryConcurrency([releaseProgram({releases:[release]})]),
      error => error instanceof CoreValidationError && error.exitCode===5,
    );
  }

  const canonicalRelease=repositoryRelease({
    phase:"RELEASED",
    approval:{...releaseApproval(),publication:{package_name:"@toss-software/cli",
      workflow:"publish.yml",required_assets:["a-package.tgz","z-package.tgz"]}},
    evidence:publicationEvidence({assets:[
      {name:"a-package.tgz",sha256:"c".repeat(64)},
      {name:"z-package.tgz",sha256:"d".repeat(64)},
    ]}),
  });
  assert.equal(assertRepositoryConcurrency([releaseProgram({
    phase:"RELEASED",
    releases:[canonicalRelease],
    deferredScope:[
      {
        epic_id:"TOSS-Soft/toss-cli#98",
        reason_code:"OUTCOME_NOT_SELECTED",
        blocking_ids:[],
        explanation:"Earlier epic first.",
      },
      {
        epic_id:"TOSS-Soft/toss-cli#99",
        reason_code:"DEPENDENCY_MISSING",
        blocking_ids:["TOSS-Soft/toss-cli#41","TOSS-Soft/toss-cli#42"],
        explanation:"Later epic second.",
      },
    ],
  })]),true);
});

test("program version rationale is repository-bound lossless and raw-order canonical",async () => {
  const {assertRepositoryConcurrency}=await releaseState();
  const cli=repositoryRelease({
    phase:"ACTIVE",
    scope:["TOSS-Soft/toss-cli#41","TOSS-Soft/toss-cli#42"],
  });
  const consoleRelease=repositoryRelease({
    repository:"TOSS-Soft/toss-console",
    releaseId:"REL-toss-console-1.4.0",
    phase:"ACTIVE",
    version:"1.4.0",
    scope:["TOSS-Soft/toss-console#7"],
  });
  const multi=releaseProgram({releases:[cli,consoleRelease]});
  const single=releaseProgram({releases:[cli]});
  const withExcludedDefect={
    ...single,
    rationale:[{
      ...single.rationale[0],
      reasons:[
        ...single.rationale[0].reasons,
        {
          rule:"unreleased_defect_excluded",
          scope_ids:["TOSS-Soft/toss-cli#99"],
        },
      ],
    }],
  };
  assert.equal(assertRepositoryConcurrency([withExcludedDefect]),true);

  const cases=[
    {...multi,rationale:[...multi.rationale].reverse()},
    {...single,rationale:[
      single.rationale[0],
      {...single.rationale[0],version:"2.3.0"},
    ]},
    {...single,rationale:[{...single.rationale[0],version:"2.3.0"}]},
    {...single,rationale:[{
      ...single.rationale[0],
      reasons:[{
        rule:"backward_compatible_feature",
        scope_ids:["TOSS-Soft/toss-console#7"],
      }],
    }]},
    {...single,rationale:[{
      ...single.rationale[0],
      reasons:[{
        rule:"backward_compatible_feature",
        scope_ids:["TOSS-Soft/toss-cli#42","TOSS-Soft/toss-cli#41"],
      }],
    }]},
    {...single,rationale:[{
      ...single.rationale[0],
      reasons:[{
        rule:"backward_compatible_feature",
        scope_ids:["TOSS-Soft/toss-cli#41"],
      }],
    }]},
    {...single,rationale:[{
      ...single.rationale[0],
      reasons:[
        {rule:"breaking_public_boundary",scope_ids:["TOSS-Soft/toss-cli#41"]},
        {rule:"backward_compatible_feature",scope_ids:["TOSS-Soft/toss-cli#41","TOSS-Soft/toss-cli#42"]},
      ],
    }]},
    {...single,rationale:[{...single.rationale[0],change_class:"patch"}]},
    {...single,rationale:[{
      ...single.rationale[0],
      change_class:"major",
      reasons:[
        {rule:"backward_compatible_feature",scope_ids:["TOSS-Soft/toss-cli#42"]},
        {rule:"breaking_public_boundary",scope_ids:["TOSS-Soft/toss-cli#41"]},
      ],
    }]},
  ];

  for (const program of cases) {
    assert.throws(
      () => assertRepositoryConcurrency([program]),
      error => error instanceof CoreValidationError && error.exitCode===5,
    );
  }
});

test("only selected work may determine the first selectable rationale rule",async () => {
  const {assertRepositoryConcurrency}=await releaseState();
  const release=repositoryRelease({
    phase:"DRAFT",
    scope:["TOSS-Soft/toss-cli#41","TOSS-Soft/toss-cli#42"],
  });
  const base=releaseProgram({phase:"DRAFT",releases:[release]});
  const invalidPrograms=[
    {
      ...base,
      rationale:[{
        repository:"TOSS-Soft/toss-cli",
        version:"3.0.0",
        change_class:"major",
        reasons:[
          {rule:"breaking_public_boundary",scope_ids:["TOSS-Soft/toss-cli#99"]},
          {rule:"backward_compatible_feature",scope_ids:["TOSS-Soft/toss-cli#41","TOSS-Soft/toss-cli#42"]},
        ],
      }],
    },
    {
      ...base,
      rationale:[{
        repository:"TOSS-Soft/toss-cli",
        version:"2.3.0",
        change_class:"minor",
        reasons:[
          {rule:"backward_compatible_feature",scope_ids:["TOSS-Soft/toss-cli#99"]},
          {rule:"published_product_fix",scope_ids:["TOSS-Soft/toss-cli#41","TOSS-Soft/toss-cli#42"]},
        ],
      }],
    },
    {
      ...base,
      rationale:[{
        repository:"TOSS-Soft/toss-cli",
        version:"2.3.0",
        change_class:"minor",
        reasons:[
          {rule:"backward_compatible_feature",scope_ids:["TOSS-Soft/toss-cli#41","TOSS-Soft/toss-cli#42"]},
          {rule:"published_product_fix",scope_ids:["TOSS-Soft/toss-cli#99"]},
        ],
      }],
    },
    {
      ...base,
      rationale:[{
        repository:"TOSS-Soft/toss-cli",
        version:"2.2.1",
        change_class:"patch",
        reasons:[
          {rule:"backward_compatible_feature",scope_ids:["TOSS-Soft/toss-cli#41"]},
          {rule:"published_product_fix",scope_ids:["TOSS-Soft/toss-cli#42"]},
        ],
      }],
    },
  ];
  for (const program of invalidPrograms) {
    assert.throws(
      () => assertRepositoryConcurrency([program]),
      error => error instanceof CoreValidationError && error.exitCode===5 &&
        /selected scope|selection precedence/i.test(error.message),
    );
  }

  const withExcluded={
    ...base,
    rationale:[{
      ...base.rationale[0],
      reasons:[
        ...base.rationale[0].reasons,
        {rule:"unreleased_defect_excluded",scope_ids:["TOSS-Soft/toss-cli#99"]},
      ],
    }],
  };
  assert.equal(assertRepositoryConcurrency([withExcluded]),true);
});

test("selected and deferred program scope identities are disjoint",async () => {
  const {assertRepositoryConcurrency}=await releaseState();
  const program=releaseProgram({deferredScope:[{
    epic_id:"TOSS-Soft/toss-cli#42",
    reason_code:"DEPENDENCY_MISSING",
    explanation:"The selected epic must not also be deferred.",
    blocking_ids:["TOSS-Soft/toss-console#99"],
  }]});
  assert.throws(
    () => assertRepositoryConcurrency([program]),
    error => error instanceof CoreValidationError && error.exitCode===5,
  );
});

test("program and repository release phases obey the staged coherence matrix",async () => {
  const {assertRepositoryConcurrency}=await releaseState();
  const repositories=["TOSS-Soft/toss-a","TOSS-Soft/toss-b"];
  const programFor=(programPhase,trackPhases) => {
    const releases=trackPhases.map((phase,index) => {
      const repository=repositories[index];
      const releaseId=`REL-${repository.slice(repository.indexOf("/")+1)}-1.4.0`;
      return repositoryRelease({
        repository,
        releaseId,
        phase,
        version:"1.4.0",
        evidence:phase==="RELEASED" ? publicationEvidence({
          repository,
          releaseId,
          version:"1.4.0",
        }) : null,
      });
    });
    return releaseProgram({phase:programPhase,releases});
  };

  for (const [programPhase,trackPhases] of [
    ["DRAFT",["DRAFT","DRAFT"]],
    ["ACTIVE",["DRAFT","ACTIVE"]],
    ["ACTIVE",["ACTIVE","READY_FOR_APPROVAL"]],
    ["ACTIVE",["RELEASED","DRAFT"]],
    ["PAUSED",["PAUSED","DRAFT"]],
    ["PAUSED",["PAUSED","ACTIVE"]],
    ["PAUSED",["PAUSED","READY_FOR_APPROVAL"]],
    ["PAUSED",["PAUSED","RELEASED"]],
    ["PUBLISHING",["PUBLISHING","DRAFT"]],
    ["PUBLISHING",["PUBLISHING","ACTIVE"]],
    ["PUBLISHING",["PUBLISHING","PAUSED"]],
    ["PUBLISHING",["PUBLISHING","READY_FOR_APPROVAL"]],
    ["PUBLISHING",["PUBLISHING","PUBLISHING"]],
    ["PUBLISHING",["PUBLISHING","RELEASED"]],
    ["RELEASED",["RELEASED","RELEASED"]],
  ]) {
    assert.equal(
      assertRepositoryConcurrency([programFor(programPhase,trackPhases)]),
      true,
      `${programPhase}: ${trackPhases.join(",")}`,
    );
  }

  for (const [programPhase,trackPhases] of [
    ["DRAFT",["DRAFT","ACTIVE"]],
    ["RELEASED",["RELEASED","ACTIVE"]],
    ["ACTIVE",["DRAFT","DRAFT"]],
    ["ACTIVE",["RELEASED","RELEASED"]],
    ["ACTIVE",["PUBLISHING","DRAFT"]],
    ["ACTIVE",["PAUSED","DRAFT"]],
    ["PAUSED",["DRAFT","ACTIVE"]],
    ["PAUSED",["PAUSED","PUBLISHING"]],
    ["PUBLISHING",["DRAFT","ACTIVE"]],
  ]) {
    assert.throws(
      () => assertRepositoryConcurrency([programFor(programPhase,trackPhases)]),
      error => error instanceof CoreValidationError && error.exitCode===5,
      `${programPhase}: ${trackPhases.join(",")}`,
    );
  }
});

test("program rationale versions enforce Task 2 safe-integer SemVer",async () => {
  const {assertRepositoryConcurrency}=await releaseState();
  const draft=releaseProgram({phase:"DRAFT",releases:[repositoryRelease()]});
  const unsafe={
    ...draft,
    rationale:[{
      ...draft.rationale[0],
      version:"9007199254740992.0.0",
    }],
  };
  assert.equal(validateDocument(unsafe,"release-program.v1").valid,true);
  assert.throws(
    () => assertRepositoryConcurrency([unsafe]),
    error => error instanceof CoreValidationError && error.exitCode===5,
  );
});

test("deferred reason codes use only the exact Task 3 vocabulary",async () => {
  const {assertRepositoryConcurrency}=await releaseState();
  const program=releaseProgram({deferredScope:[{
    epic_id:"TOSS-Soft/toss-cli#99",
    reason_code:"CAPACITY",
    explanation:"An arbitrary extension code is not a Task 3 reason.",
    blocking_ids:[],
  }]});
  assert.equal(validateDocument(program,"release-program.v1").valid,false);
  assert.throws(
    () => assertRepositoryConcurrency([program]),
    error => error instanceof CoreValidationError && error.exitCode===5,
  );
});

test("patch concurrency binds the exact paused program, release, and revision",async () => {
  const {assertRepositoryConcurrency}=await releaseState();
  const paused=releaseProgram({
    phase:"PAUSED",
    releases:[repositoryRelease({phase:"PAUSED"})],
  });
  const patchRelease=repositoryRelease({
    releaseId:"REL-toss-cli-2.1.3",
    programId:"TOSS-OS-R0008",
    phase:"ACTIVE",
    version:"2.1.3",
  });
  const patch=releaseProgram({
    programId:"TOSS-OS-R0008",
    releases:[patchRelease],
    interrupts:{
      program_id:"TOSS-OS-R0007",
      repository_release_id:"REL-toss-cli-2.2.0",
      paused_release_revision:"REV-0042",
    },
  });
  assert.equal(assertRepositoryConcurrency([patch,paused]),true);

  for (const interrupts of [
    {...patch.interrupts,program_id:"TOSS-OS-R0009"},
    {...patch.interrupts,repository_release_id:"REL-toss-cli-2.3.0"},
    {...patch.interrupts,paused_release_revision:"REV-0041"},
  ]) {
    assert.throws(
      () => assertRepositoryConcurrency([{...patch,interrupts},paused]),
      error => error instanceof CoreValidationError && /interrupt/i.test(error.message),
    );
  }

  const notPaused=releaseProgram({releases:[repositoryRelease({phase:"ACTIVE"})]});
  assert.throws(
    () => assertRepositoryConcurrency([patch,notPaused]),
    error => error instanceof CoreValidationError && /interrupt/i.test(error.message),
  );
});

test("concurrency input is closed, canonical, detached, and trap-safe",async () => {
  const {assertRepositoryConcurrency}=await releaseState();
  assert.throws(
    () => assertRepositoryConcurrency({...releaseProgram(),unexpected:true}),
    CoreValidationError,
  );

  let traps=0;
  const hostile=new Proxy([],{
    get() { traps+=1; throw new Error("get trap"); },
    getOwnPropertyDescriptor() { traps+=1; throw new Error("descriptor trap"); },
    getPrototypeOf() { traps+=1; throw new Error("prototype trap"); },
    ownKeys() { traps+=1; throw new Error("keys trap"); },
  });
  assert.throws(() => assertRepositoryConcurrency(hostile),CoreValidationError);
  assert.equal(traps,0);

  const first=releaseProgram({
    programId:"TOSS-OS-R0008",
    releases:[repositoryRelease({
      repository:"TOSS-Soft/toss-console",
      releaseId:"REL-toss-console-1.4.0",
      programId:"TOSS-OS-R0008",
      phase:"ACTIVE",
      version:"1.4.0",
    })],
  });
  const second=releaseProgram({programId:"TOSS-OS-R0007"});
  const before=clone([first,second]);
  assert.equal(assertRepositoryConcurrency([first,second]),true);
  assert.deepEqual([first,second],before);
});
