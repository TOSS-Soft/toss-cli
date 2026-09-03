import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {canonicalJson} from "../src/contracts/acp.js";
import {validateCoreDocument} from "../src/core/contracts.js";
import {CoreValidationError} from "../src/core/errors.js";
import {
  candidateOrder,
  eligibleEpic,
  planReleaseProgram,
} from "../src/core/release/planner.js";
import {assertRepositoryConcurrency} from "../src/core/release/state.js";

const CLI="TOSS-Soft/toss-cli";
const CONSOLE="TOSS-Soft/toss-console";
const NOW="2026-09-02T12:00:00.000Z";
const CLI_RELEASE_ID="REL-TOSS-OS-R0042-05d07cd29c4dafca90d293c2a0ec530ef1a89afb8a3fdb10fcdce6fde5de10e7";
const CONSOLE_RELEASE_ID="REL-TOSS-OS-R0042-9c3bf072004757715eef0e4dc191330ebebcb08fc1e39209b748f54d4b19f615";

function fixture() {
  return JSON.parse(fs.readFileSync(
    new URL("fixtures/core/program-candidates.json",import.meta.url),
    "utf8",
  ));
}

function candidate(number,overrides={}) {
  return {
    id:`${CLI}#${number}`,
    repository:CLI,
    approved:true,
    version:null,
    decomposed:true,
    priority:1,
    risk:"medium",
    outcome:`outcome-${number}`,
    change_class:"backward_compatible_feature",
    dependencies:[],
    ...overrides,
  };
}

function rank(number,overrides={}) {
  return {
    id:`${CLI}#${number}`,
    priority:1,
    risk:"medium",
    dependency_fanout:0,
    ...overrides,
  };
}

function deepRecord(depth) {
  let value={leaf:true};
  for (let index=0;index<depth;index+=1) value={next:value};
  return value;
}

function repository(repository=CLI,latestPublishedVersion="2.1.2") {
  return {repository,latest_published_version:latestPublishedVersion};
}

function plannerInput(overrides={}) {
  const source=fixture();
  return {
    programId:"TOSS-OS-R0042",
    candidates:source.candidates,
    completed:source.completed,
    repositories:source.repositories,
    activePrograms:[],
    clock:() => NOW,
    ...overrides,
  };
}

function eligibility() {
  return {
    approved:true,
    unversioned:true,
    decomposed:true,
    registered_repository:true,
    unassigned:true,
  };
}

function activeProgram(epicId,{programId="TOSS-OS-R0007"}={}) {
  const releaseId="REL-active-program-cli";
  return {
    schema_version:"release-program.v1",
    program_id:programId,
    phase:"DRAFT",
    revision:"REV-0001",
    repository_releases:[{
      schema_version:"repository-release.v1",
      release_id:releaseId,
      program_id:programId,
      repository:CLI,
      phase:"DRAFT",
      revision:"REV-0001",
      version:null,
      milestone:null,
      branch:null,
      release_pr_intent:null,
      scope:[epicId],
      approval:null,
      publication_evidence:null,
      transitions:[],
    }],
    dependency_stages:[{stage:1,repository_release_ids:[releaseId]}],
    selected_scope:[{epic_id:epicId,outcome:"reserved",eligibility:eligibility()}],
    deferred_scope:[],
    rationale:[{
      repository:CLI,
      version:"2.2.0",
      change_class:"minor",
      reasons:[{rule:"backward_compatible_feature",scope_ids:[epicId]}],
    }],
    interrupts:null,
    created_at:"2026-09-02T11:00:00.000Z",
    updated_at:"2026-09-02T11:00:00.000Z",
  };
}

function deeplyFrozen(value,seen=new Set()) {
  if (value===null || typeof value!=="object" || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Reflect.ownKeys(value)
    .every(key => deeplyFrozen(value[key],seen));
}

function selectedIds(program) {
  return program.selected_scope.map(selected => selected.epic_id);
}

test("eligibleEpic reports every failed approved unversioned decomposed registered unassigned condition",() => {
  const epic=candidate(8,{
    approved:false,
    version:"2.0.0",
    decomposed:false,
  });
  const result=eligibleEpic(epic,{
    epic_ids:[epic.id],
    repositories:[CONSOLE],
  });

  assert.deepEqual(result,{
    eligible:false,
    reasons:[
      {
        reason_code:"EPIC_UNAPPROVED",
        explanation:`Epic ${epic.id} is not explicitly approved.`,
        blocking_ids:[],
      },
      {
        reason_code:"EPIC_ALREADY_VERSIONED",
        explanation:`Epic ${epic.id} already has release version 2.0.0.`,
        blocking_ids:[],
      },
      {
        reason_code:"EPIC_NOT_DECOMPOSED",
        explanation:`Epic ${epic.id} is not sufficiently decomposed.`,
        blocking_ids:[],
      },
      {
        reason_code:"REPOSITORY_UNREGISTERED",
        explanation:`Repository ${CLI} is not registered.`,
        blocking_ids:[],
      },
      {
        reason_code:"ACTIVE_PROGRAM_ASSIGNMENT",
        explanation:`Epic ${epic.id} is assigned to another active release program.`,
        blocking_ids:[epic.id],
      },
    ],
  });
  assert.ok(deeplyFrozen(result));

  assert.deepEqual(eligibleEpic(candidate(9),{
    epic_ids:[],
    repositories:[CLI],
  }),{eligible:true,reasons:[]});
});

test("planner selects one coherent outcome closure and stages cross-repository tracks target first",() => {
  let clockCalls=0;
  const planned=planReleaseProgram(plannerInput({
    clock:() => { clockCalls+=1; return NOW; },
  }));

  assert.deepEqual(planned,{
    schema_version:"release-program.v1",
    program_id:"TOSS-OS-R0042",
    phase:"DRAFT",
    revision:"REV-0001",
    repository_releases:[
      {
        schema_version:"repository-release.v1",
        release_id:CLI_RELEASE_ID,
        program_id:"TOSS-OS-R0042",
        repository:CLI,
        phase:"DRAFT",
        revision:"REV-0001",
        version:null,
        milestone:null,
        branch:null,
        release_pr_intent:null,
        scope:[`${CLI}#10`],
        approval:null,
        publication_evidence:null,
        transitions:[],
      },
      {
        schema_version:"repository-release.v1",
        release_id:CONSOLE_RELEASE_ID,
        program_id:"TOSS-OS-R0042",
        repository:CONSOLE,
        phase:"DRAFT",
        revision:"REV-0001",
        version:null,
        milestone:null,
        branch:null,
        release_pr_intent:null,
        scope:[`${CONSOLE}#4`],
        approval:null,
        publication_evidence:null,
        transitions:[],
      },
    ],
    dependency_stages:[
      {stage:1,repository_release_ids:[CONSOLE_RELEASE_ID]},
      {stage:2,repository_release_ids:[CLI_RELEASE_ID]},
    ],
    selected_scope:[
      {epic_id:`${CLI}#10`,outcome:"organizational-lifecycle",eligibility:eligibility()},
      {epic_id:`${CONSOLE}#4`,outcome:"console-contract",eligibility:eligibility()},
    ],
    deferred_scope:[
      {
        epic_id:`${CLI}#20`,
        reason_code:"OUTCOME_NOT_SELECTED",
        explanation:"Outcome \"runtime-improvement\" was not selected for TOSS-OS-R0042.",
        blocking_ids:[],
      },
      {
        epic_id:`${CLI}#30`,
        reason_code:"EPIC_UNAPPROVED",
        explanation:`Epic ${CLI}#30 is not explicitly approved.`,
        blocking_ids:[],
      },
    ],
    rationale:[
      {
        repository:CLI,
        version:"2.2.0",
        change_class:"minor",
        reasons:[{
          rule:"backward_compatible_feature",
          scope_ids:[`${CLI}#10`],
        }],
      },
      {
        repository:CONSOLE,
        version:"1.4.0",
        change_class:"minor",
        reasons:[{
          rule:"backward_compatible_feature",
          scope_ids:[`${CONSOLE}#4`],
        }],
      },
    ],
    interrupts:null,
    created_at:NOW,
    updated_at:NOW,
  });
  assert.equal(clockCalls,1);
  assert.equal(validateCoreDocument(planned,"release-program.v1"),planned);
  assert.equal(assertRepositoryConcurrency([planned]),true);
  assert.ok(deeplyFrozen(planned));
  assert.equal(Object.hasOwn(planned,"version"),false);
  assert.ok(planned.repository_releases.every(release =>
    release.version===null && release.milestone===null && release.branch===null &&
    release.release_pr_intent===null));
});

test("completed prior dependencies satisfy closure without manufacturing a repository track",() => {
  const epic=candidate(10,{dependencies:[`${CONSOLE}#99`]});
  const planned=planReleaseProgram(plannerInput({
    candidates:[epic],
    completed:[`${CONSOLE}#99`],
    repositories:[repository()],
  }));

  assert.deepEqual(selectedIds(planned),[epic.id]);
  assert.deepEqual(planned.repository_releases.map(release => release.repository),[CLI]);
  assert.deepEqual(planned.dependency_stages,[{
    stage:1,
    repository_release_ids:[CLI_RELEASE_ID],
  }]);
});

test("transitive same-repository dependencies join one selected track without extra stages",() => {
  const selected=planReleaseProgram(plannerInput({
    candidates:[
      candidate(10,{priority:10,outcome:"selected",dependencies:[`${CLI}#11`]}),
      candidate(11,{priority:5,outcome:"dependency-one",dependencies:[`${CLI}#12`]}),
      candidate(12,{priority:1,outcome:"dependency-two"}),
    ],
    repositories:[repository()],
  }));

  assert.deepEqual(selectedIds(selected),[`${CLI}#10`,`${CLI}#11`,`${CLI}#12`]);
  assert.deepEqual(selected.repository_releases[0].scope,[
    `${CLI}#10`,`${CLI}#11`,`${CLI}#12`,
  ]);
  assert.deepEqual(selected.dependency_stages,[{
    stage:1,
    repository_release_ids:[CLI_RELEASE_ID],
  }]);
});

test("missing and ineligible mandatory dependencies defer exact blockers",() => {
  const missingId=`${CONSOLE}#99`;
  const source=candidate(10,{dependencies:[missingId],outcome:"blocked"});
  const missing=planReleaseProgram(plannerInput({
    candidates:[source],
    repositories:[repository()],
  }));
  assert.equal(missing.phase,"WAITING_FOR_EPIC");
  assert.deepEqual(missing.repository_releases,[]);
  assert.deepEqual(missing.dependency_stages,[]);
  assert.deepEqual(missing.selected_scope,[]);
  assert.deepEqual(missing.rationale,[]);
  assert.deepEqual(missing.deferred_scope,[{
    epic_id:source.id,
    reason_code:"DEPENDENCY_MISSING",
    explanation:`Outcome "blocked" is not selectable because mandatory dependencies are missing: ${source.id} -> ${missingId}.`,
    blocking_ids:[missingId],
  }]);

  const dependency=candidate(11,{approved:false,outcome:"dependency"});
  const ineligibleSource={...source,dependencies:[dependency.id]};
  const ineligible=planReleaseProgram(plannerInput({
    candidates:[ineligibleSource,dependency],
    repositories:[repository()],
  }));
  assert.deepEqual(ineligible.deferred_scope,[
    {
      epic_id:ineligibleSource.id,
      reason_code:"DEPENDENCY_INELIGIBLE",
      explanation:`Outcome "blocked" is not selectable because mandatory dependencies are ineligible: ${ineligibleSource.id} -> ${dependency.id}.`,
      blocking_ids:[dependency.id],
    },
    {
      epic_id:dependency.id,
      reason_code:"EPIC_UNAPPROVED",
      explanation:`Epic ${dependency.id} is not explicitly approved.`,
      blocking_ids:[],
    },
  ]);
});

test("planner defers each ineligible candidate with its stable primary reason",() => {
  const cases=[
    [candidate(1,{approved:false}),[],"EPIC_UNAPPROVED"],
    [candidate(1,{version:"2.2.0"}),[repository()],"EPIC_ALREADY_VERSIONED"],
    [candidate(1,{decomposed:false}),[repository()],"EPIC_NOT_DECOMPOSED"],
    [candidate(1),[],"REPOSITORY_UNREGISTERED"],
  ];
  for (const [epic,repositories,reasonCode] of cases) {
    const planned=planReleaseProgram(plannerInput({
      candidates:[epic],
      repositories,
    }));
    assert.equal(planned.phase,"WAITING_FOR_EPIC");
    assert.equal(planned.deferred_scope[0].reason_code,reasonCode);
  }
});

test("another active program reserves scope while a waiting program does not",() => {
  const epic=candidate(10);
  const reserved=planReleaseProgram(plannerInput({
    candidates:[epic],
    repositories:[repository()],
    activePrograms:[activeProgram(epic.id)],
  }));
  assert.equal(reserved.phase,"WAITING_FOR_EPIC");
  assert.deepEqual(reserved.deferred_scope,[{
    epic_id:epic.id,
    reason_code:"ACTIVE_PROGRAM_ASSIGNMENT",
    explanation:`Epic ${epic.id} is assigned to another active release program.`,
    blocking_ids:[epic.id],
  }]);

  const waiting={
    ...activeProgram(epic.id),
    phase:"WAITING_FOR_EPIC",
    repository_releases:[],
    dependency_stages:[],
    selected_scope:[],
    rationale:[],
  };
  assert.deepEqual(selectedIds(planReleaseProgram(plannerInput({
    candidates:[epic],
    repositories:[repository()],
    activePrograms:[waiting],
  }))),[epic.id]);
});

test("candidate ties resolve by priority then direct incoming fan-out then risk then raw ID",() => {
  const plan=candidates => planReleaseProgram(plannerInput({
    candidates,
    repositories:[repository()],
  }));

  assert.deepEqual(selectedIds(plan([
    candidate(1,{priority:5,risk:"high",outcome:"priority"}),
    candidate(2,{priority:4,risk:"low",outcome:"lower-priority"}),
    candidate(3,{priority:0,dependencies:[`${CLI}#2`]}),
  ])),[`${CLI}#1`]);

  assert.deepEqual(selectedIds(plan([
    candidate(1,{priority:5,outcome:"no-fanout"}),
    candidate(2,{priority:5,outcome:"fanout"}),
    candidate(3,{priority:0,dependencies:[`${CLI}#2`]}),
  ])),[`${CLI}#2`]);

  assert.deepEqual(selectedIds(plan([
    candidate(1,{priority:5,risk:"high",outcome:"high-risk"}),
    candidate(2,{priority:5,risk:"low",outcome:"low-risk"}),
  ])),[`${CLI}#2`]);

  assert.deepEqual(selectedIds(plan([
    candidate(2,{priority:5,risk:"low",outcome:"later-id"}),
    candidate(10,{priority:5,risk:"low",outcome:"earlier-id"}),
  ])),[`${CLI}#10`]);

  assert.ok(candidateOrder(rank(1,{dependency_fanout:2}),rank(2,{
    dependency_fanout:1,
  }))<0);
});

test("candidateOrder accepts only exact descriptor-safe rank projections",() => {
  let getterCalls=0;
  const accessor=rank(1);
  Object.defineProperty(accessor,"priority",{
    enumerable:true,
    get() { getterCalls+=1; throw new Error("priority getter"); },
  });
  assert.throws(
    () => candidateOrder(accessor,rank(2)),
    error => error instanceof CoreValidationError && error.exitCode===5,
  );
  assert.equal(getterCalls,0);

  let traps=0;
  const hostile=new Proxy(rank(1),{
    get() { traps+=1; throw new Error("get trap"); },
    getOwnPropertyDescriptor() { traps+=1; throw new Error("descriptor trap"); },
    getPrototypeOf() { traps+=1; throw new Error("prototype trap"); },
    ownKeys() { traps+=1; throw new Error("keys trap"); },
  });
  assert.throws(() => candidateOrder(hostile,rank(2)),CoreValidationError);
  assert.equal(traps,0);
  assert.throws(
    () => candidateOrder({...rank(1),outcome:"not-a-rank-field"},rank(2)),
    CoreValidationError,
  );
});

test("planner deep known fields fail typed and unknown roots are rejected before traversal",() => {
  const epic=candidate(1);
  const deep=deepRecord(12_000);
  const assigned=activeProgram(epic.id);
  const calls=[
    () => planReleaseProgram(plannerInput({
      candidates:[epic],
      repositories:[repository()],
      activePrograms:[{...assigned,phase:deep}],
    })),
    () => planReleaseProgram(plannerInput({
      candidates:[epic],
      repositories:[repository()],
      clock:() => deep,
    })),
  ];
  for (const invoke of calls) {
    assert.throws(
      invoke,
      error => error instanceof CoreValidationError && error.exitCode===5 &&
        !(error instanceof RangeError),
    );
  }
  assert.throws(
    () => assertRepositoryConcurrency([{...assigned,unexpected:deep}]),
    error => error instanceof CoreValidationError && error.exitCode===5 &&
      /exact closed shape/i.test(error.message),
  );
});

test("shared nonviable outcome explanations identify only blocker-introducing epics",() => {
  const missingId=`${CONSOLE}#99`;
  const blocker=candidate(1,{outcome:"shared",dependencies:[missingId]});
  const peer=candidate(2,{outcome:"shared"});
  const missing=planReleaseProgram(plannerInput({
    candidates:[blocker,peer],
    repositories:[repository()],
  }));
  const missingExplanation=`Outcome "shared" is not selectable because mandatory dependencies are missing: ${blocker.id} -> ${missingId}.`;
  assert.deepEqual(missing.deferred_scope,[
    {
      epic_id:blocker.id,
      reason_code:"DEPENDENCY_MISSING",
      explanation:missingExplanation,
      blocking_ids:[missingId],
    },
    {
      epic_id:peer.id,
      reason_code:"DEPENDENCY_MISSING",
      explanation:missingExplanation,
      blocking_ids:[missingId],
    },
  ]);

  const dependency=candidate(3,{approved:false,outcome:"dependency"});
  const ineligibleBlocker={...blocker,dependencies:[dependency.id]};
  const ineligible=planReleaseProgram(plannerInput({
    candidates:[ineligibleBlocker,peer,dependency],
    repositories:[repository()],
  }));
  const ineligibleExplanation=`Outcome "shared" is not selectable because mandatory dependencies are ineligible: ${blocker.id} -> ${dependency.id}.`;
  assert.equal(
    ineligible.deferred_scope.find(entry => entry.epic_id===peer.id).explanation,
    ineligibleExplanation,
  );
});

test("shuffled candidates dependencies and repositories produce byte-identical canonical manifests",() => {
  const source=fixture();
  const shuffled=source.candidates.map(value => ({
    ...value,
    dependencies:[...value.dependencies].reverse(),
  })).reverse();
  const left=planReleaseProgram(plannerInput());
  const right=planReleaseProgram(plannerInput({
    candidates:shuffled,
    repositories:[...source.repositories].reverse(),
  }));

  assert.deepEqual(right,left);
  assert.equal(canonicalJson(right),canonicalJson(left));
  assert.equal(JSON.stringify(right),JSON.stringify(left));
});

test("candidate identity and dependency graphs fail closed on duplicates self edges and cycles",() => {
  const cases=[
    [candidate(1),candidate(1)],
    [candidate(1,{repository:CONSOLE})],
    [candidate(1,{dependencies:[`${CLI}#1`]})],
    [
      candidate(1,{dependencies:[`${CLI}#2`]}),
      candidate(2,{dependencies:[`${CLI}#1`]}),
    ],
  ];
  for (const candidates of cases) {
    assert.throws(
      () => planReleaseProgram(plannerInput({candidates,repositories:[repository()]})),
      error => error instanceof CoreValidationError && error.exitCode===5,
    );
  }
});

test("planner and eligibility inputs are exact canonical detached and trap-safe",() => {
  const epic=candidate(1);
  for (const invoke of [
    () => eligibleEpic({...epic,extra:true},{epic_ids:[],repositories:[CLI]}),
    () => eligibleEpic(epic,{epic_ids:[],repositories:[CLI],extra:true}),
    () => eligibleEpic(epic,{epic_ids:[`${CLI}#2`,`${CLI}#1`],repositories:[CLI]}),
    () => planReleaseProgram({...plannerInput(),extra:true}),
    () => planReleaseProgram(plannerInput({completed:[`${CLI}#2`,`${CLI}#1`]})),
    () => planReleaseProgram(plannerInput({repositories:[{...repository(),extra:true}]})),
    () => planReleaseProgram(plannerInput({activePrograms:[{...activeProgram(epic.id),extra:true}]})),
  ]) {
    assert.throws(invoke,error => error instanceof CoreValidationError && error.exitCode===5);
  }

  let traps=0;
  const hostile=new Proxy({}, {
    get() { traps+=1; throw new Error("get trap"); },
    getOwnPropertyDescriptor() { traps+=1; throw new Error("descriptor trap"); },
    getPrototypeOf() { traps+=1; throw new Error("prototype trap"); },
    ownKeys() { traps+=1; throw new Error("keys trap"); },
  });
  assert.throws(() => eligibleEpic(hostile,hostile),CoreValidationError);
  assert.throws(() => planReleaseProgram(hostile),CoreValidationError);
  assert.equal(traps,0);

  const input=plannerInput({
    candidates:[epic],
    repositories:[repository()],
  });
  const planned=planReleaseProgram(input);
  input.candidates[0].outcome="mutated";
  input.repositories[0].latest_published_version="9.9.9";
  assert.equal(planned.selected_scope[0].outcome,"outcome-1");
  assert.equal(planned.rationale[0].version,"2.2.0");
});
