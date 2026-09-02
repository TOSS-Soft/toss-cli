import assert from "node:assert/strict";
import test from "node:test";

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
}={}) {
  return {
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
      assets:[{name:`toss-cli-${version}.tgz`,sha256:"b".repeat(64)}],
    },
    evidence_sha256:"c".repeat(64),
    source_receipt:"RECEIPT-20260902-0001",
    verified_at:"2026-09-02T10:30:00.000Z",
  };
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

function repositoryRelease({
  repository="TOSS-Soft/toss-cli",
  releaseId="REL-toss-cli-2.2.0",
  programId="TOSS-OS-R0007",
  phase="DRAFT",
  revision="REV-0042",
  version="2.2.0",
  transitions=[],
  evidence=null,
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
    scope:[`${repository}#42`],
    publication_evidence:evidence,
    transitions,
  };
}

function releaseProgram({
  programId="TOSS-OS-R0007",
  phase="ACTIVE",
  revision="REV-0007",
  releases=[repositoryRelease({phase:"ACTIVE"})],
  interrupts=null,
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
    selected_scope:releases.flatMap(release => release.scope),
    deferred_scope:[],
    rationale:releases.length===0 ? ["No eligible approved epic is available."] : [
      "Selected the highest-priority coherent outcome.",
    ],
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
        : ["TOSS-Soft/toss-cli#42"]};
    assert.equal(validateDocument(populated,"release-program.v1").valid,false,field);
  }
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
  const {transitionRepositoryRelease}=await releaseState();
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
      current={...current,publication_evidence:publicationEvidence()};
    }
    const source=current;
    current=transitionRepositoryRelease(source,transitionEvent(event,source.revision));
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
    releaseProgram({releases:[cli,consoleRelease]}),
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
