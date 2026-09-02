import assert from "node:assert/strict";
import test from "node:test";

import {validateCoreDocument} from "../src/core/contracts.js";
import {
  assertValidPullRequestTarget,
  requiredBaseBranch,
} from "../src/core/domain/branching.js";
import {reserveBranch,workItemId} from "../src/core/domain/identity.js";
import {CoreConflictError,CoreValidationError} from "../src/core/errors.js";

const SHA_A="a".repeat(64);
const SHA_B="b".repeat(64);
const REVIEWED_SHA="1".repeat(40);
const REPOSITORY="TOSS-Soft/toss-cli";

const EPIC=Object.freeze({
  schema_version:"work-item.v1",
  id:`${REPOSITORY}#42`,
  repository:REPOSITORY,
  issue_number:42,
  kind:"epic",
  parent_id:null,
  branch:"epic/42-organizational-lifecycle",
  base_branch:null,
  milestone:null,
  status:"Backlog",
  gate:"EPIC_PREPARATION_REQUIRED",
});

const CHILD=Object.freeze({
  schema_version:"work-item.v1",
  id:`${REPOSITORY}#43`,
  repository:REPOSITORY,
  issue_number:43,
  kind:"issue",
  parent_id:EPIC.id,
  acceptance_criteria:Object.freeze(["The four Core contracts validate through the public validator."]),
  branch:"issue/43-define-contracts",
  base_branch:EPIC.branch,
  milestone:null,
  status:"Ready",
  gate:"NONE",
});

const EDGE=Object.freeze({
  schema_version:"dependency-edge.v1",
  edge_id:"DEP-0001",
  source:`${REPOSITORY}#43`,
  target:`${REPOSITORY}#44`,
  kind:"requires",
  rationale:"The contract must exist before the command consumes it.",
  provenance:Object.freeze({
    source_revision:"feature-request@1",
    source_sha256:SHA_A,
    locations:Object.freeze(["dependencies[0]"]),
  }),
  revision:"EDGE-0001",
});

const PLAN=Object.freeze({
  schema_version:"epic-plan.v1",
  plan_id:"EPIC-PLAN-0001",
  source:Object.freeze({
    repository:REPOSITORY,
    revision:"issue-node:42@revision-7",
    sha256:SHA_B,
  }),
  epic:EPIC,
  children:Object.freeze([CHILD]),
  edges:Object.freeze([EDGE]),
  content_sha256:SHA_A,
  created_at:"2026-09-01T08:00:00.000Z",
});

const REVIEW=Object.freeze({
  schema_version:"review-result.v1",
  review_id:"REVIEW-20260901-0001",
  repository:REPOSITORY,
  pull_request_number:91,
  reviewed_revision:REVIEWED_SHA,
  reviewer:Object.freeze({identity:"reviewer@example.test",role:"independent-reviewer"}),
  verdict:"APPROVED",
  freshness:"CURRENT",
  findings:Object.freeze([Object.freeze({
    finding_id:"FINDING-0001",
    severity:"Minor",
    summary:"Add one follow-up boundary case.",
    resolved:false,
  })]),
  unresolved:Object.freeze(["FINDING-0001"]),
  verification_evidence:Object.freeze(["node --test test/core-branching.test.js"]),
  follow_up_issues:Object.freeze([`${REPOSITORY}#99`]),
  reviewed_at:"2026-09-01T09:00:00.000Z",
  recorded_at:"2026-09-01T09:01:00.000Z",
});

function clone(value) {
  return structuredClone(value);
}

test("work identities are canonical and branch reservations are deterministic",() => {
  assert.equal(workItemId(REPOSITORY,42),`${REPOSITORY}#42`);
  assert.equal(reserveBranch({kind:"epic",number:12,title:"Café déjà vu"}),"epic/12-cafe-deja-vu");
  assert.equal(reserveBranch({kind:"issue",number:7,title:"🧪✨"}),"issue/7-item-7");
  assert.equal(reserveBranch({kind:"bug",number:8,title:"Fix release receipt"}),"bug/8-fix-release-receipt");
  assert.equal(
    reserveBranch({kind:"epic",number:12,title:"Café déjà vu"}),
    reserveBranch({kind:"epic",number:12,title:"Café déjà vu"}),
  );
});

test("long branch slugs retain a deterministic collision-resistant suffix inside the cap",() => {
  const first=reserveBranch({
    kind:"issue",
    number:43,
    title:"abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuv first outcome",
  });
  const second=reserveBranch({
    kind:"issue",
    number:43,
    title:"abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuv second outcome",
  });

  assert.equal(first,"issue/43-abcdefghijklmnopqrstuvwxyzabcdefghijklm-d7f899c4");
  assert.equal(second,"issue/43-abcdefghijklmnopqrstuvwxyzabcdefghijklm-e26816a6");
  assert.equal(first.slice("issue/43-".length).length,48);
  assert.notEqual(first,second);
});

test("identity helpers reject unsafe or exotic input without invoking hostile behavior",() => {
  for (const [repository,number] of [
    ["TOSS-Soft/toss-cli/extra",42],
    ["TOSS-Soft/../toss-cli",42],
    [REPOSITORY,0],
    [REPOSITORY,Number.MAX_SAFE_INTEGER+1],
  ]) {
    assert.throws(() => workItemId(repository,number),CoreValidationError);
  }

  let traps=0;
  const proxy=new Proxy({}, {
    get() { traps+=1; throw new Error("get trap invoked"); },
    getOwnPropertyDescriptor() { traps+=1; throw new Error("descriptor trap invoked"); },
    getPrototypeOf() { traps+=1; throw new Error("prototype trap invoked"); },
    ownKeys() { traps+=1; throw new Error("ownKeys trap invoked"); },
  });
  assert.throws(() => reserveBranch(proxy),CoreValidationError);
  assert.equal(traps,0);

  let getterCalls=0;
  const accessor={kind:"issue",number:1};
  Object.defineProperty(accessor,"title",{
    enumerable:true,
    get() { getterCalls+=1; return "unsafe"; },
  });
  assert.throws(() => reserveBranch(accessor),CoreValidationError);
  assert.equal(getterCalls,0);

  const hidden={kind:"issue",number:1,title:"hidden"};
  Object.defineProperty(hidden,"extra",{value:true});
  assert.throws(() => reserveBranch(hidden),CoreValidationError);
  assert.throws(
    () => reserveBranch({...hidden,[Symbol("extra")]:true}),
    CoreValidationError,
  );
  assert.throws(() => reserveBranch({kind:"fix",number:1,title:"fix"}),CoreValidationError);
});

test("required bases follow only normalized same-repository relationships",() => {
  assert.equal(requiredBaseBranch({
    id:CHILD.id,
    kind:"issue",
    repository:REPOSITORY,
    parent_id:EPIC.id,
  },{
    parent:{id:EPIC.id,repository:REPOSITORY,branch:EPIC.branch},
  }),EPIC.branch);

  assert.equal(requiredBaseBranch({id:EPIC.id,kind:"epic",repository:REPOSITORY},{
    release:{repository:REPOSITORY,branch:"release/v2.2.0"},
  }),"release/v2.2.0");

  assert.equal(requiredBaseBranch({id:`${REPOSITORY}#55`,kind:"bug",repository:REPOSITORY},{
    patch_release:{repository:REPOSITORY,branch:"release/v2.1.3"},
  }),"release/v2.1.3");

  assert.equal(requiredBaseBranch({id:EPIC.id,kind:"epic",repository:REPOSITORY},{
    release:null,
  }),null);

  assert.equal(requiredBaseBranch({
    id:`${REPOSITORY}@release/v2.2.0`,kind:"release",repository:REPOSITORY,
  },{default_branch:"main"}),"main");
});

test("required base derivation rejects cross-repository Git parents and exotic relations",() => {
  assert.throws(() => requiredBaseBranch({
    id:CHILD.id,
    kind:"issue",
    repository:REPOSITORY,
    parent_id:"TOSS-Soft/toss-console#42",
  },{
    parent:{
      id:"TOSS-Soft/toss-console#42",
      repository:"TOSS-Soft/toss-console",
      branch:"epic/42-organizational-lifecycle",
    },
  }),CoreValidationError);

  let traps=0;
  const parent=new Proxy({}, {
    get() { traps+=1; throw new Error("get trap invoked"); },
    getOwnPropertyDescriptor() { traps+=1; throw new Error("descriptor trap invoked"); },
    getPrototypeOf() { traps+=1; throw new Error("prototype trap invoked"); },
    ownKeys() { traps+=1; throw new Error("ownKeys trap invoked"); },
  });
  assert.throws(() => requiredBaseBranch({
    id:CHILD.id,kind:"issue",repository:REPOSITORY,parent_id:EPIC.id,
  },{parent}),CoreValidationError);
  assert.equal(traps,0);
});

test("pull request targets enforce the issue to epic to release to main hierarchy",() => {
  for (const target of [
    {
      headRepository:REPOSITORY,baseRepository:REPOSITORY,
      head:CHILD.branch,base:EPIC.branch,expectedBase:EPIC.branch,
    },
    {
      headRepository:REPOSITORY,baseRepository:REPOSITORY,
      head:EPIC.branch,base:"release/v2.2.0",expectedBase:"release/v2.2.0",
    },
    {
      headRepository:REPOSITORY,baseRepository:REPOSITORY,
      head:"bug/55-production-fix",base:"release/v2.1.3",expectedBase:"release/v2.1.3",
    },
    {
      headRepository:REPOSITORY,baseRepository:REPOSITORY,
      head:"release/v2.2.0",base:"main",expectedBase:"main",
    },
  ]) {
    assert.equal(assertValidPullRequestTarget(target),true);
  }
});

test("pull request targets reject direct main, cross-repository, and stale existing bases",() => {
  assert.throws(() => assertValidPullRequestTarget({
    headRepository:REPOSITORY,baseRepository:REPOSITORY,
    head:CHILD.branch,base:"main",expectedBase:"main",
  }),CoreValidationError);

  assert.throws(() => assertValidPullRequestTarget({
    headRepository:REPOSITORY,baseRepository:"TOSS-Soft/toss-console",
    head:CHILD.branch,base:EPIC.branch,expectedBase:EPIC.branch,
  }),CoreValidationError);

  assert.throws(() => assertValidPullRequestTarget({
    headRepository:REPOSITORY,baseRepository:REPOSITORY,
    head:CHILD.branch,base:"epic/41-old",expectedBase:EPIC.branch,
  }),error => error instanceof CoreConflictError && error.exitCode===6);
});

test("work lifecycle contracts accept the smallest complete closed documents",() => {
  for (const [schemaId,value] of [
    ["dependency-edge.v1",EDGE],
    ["epic-plan.v1",PLAN],
    ["review-result.v1",REVIEW],
    ["work-item.v1",EPIC],
  ]) {
    assert.equal(validateCoreDocument(value,schemaId),value,schemaId);
  }
});

test("work lifecycle contracts reject unknown fields, wrong enums, and duplicate identities",() => {
  assert.throws(
    () => validateCoreDocument({...EPIC,unexpected:true},"work-item.v1"),
    CoreValidationError,
  );
  for (const [value,schemaId] of [
    [{...EPIC,kind:"fix"},"work-item.v1"],
    [{...EPIC,status:"Todo"},"work-item.v1"],
    [{...EPIC,gate:"WAITING"},"work-item.v1"],
    [{...EDGE,kind:"blocks"},"dependency-edge.v1"],
    [{...REVIEW,verdict:"ACCEPTED"},"review-result.v1"],
    [{...REVIEW,freshness:"FRESH"},"review-result.v1"],
    [{...REVIEW,findings:[{...REVIEW.findings[0],severity:"Warning"}]},"review-result.v1"],
  ]) {
    assert.throws(() => validateCoreDocument(value,schemaId),CoreValidationError);
  }

  assert.throws(() => validateCoreDocument({
    ...PLAN,
    children:[CHILD,{...CHILD,title:"same ID, different shape"}],
  },"epic-plan.v1"),/duplicate work item id/i);
  assert.throws(() => validateCoreDocument({
    ...PLAN,
    edges:[EDGE,{...EDGE,rationale:"same ID, different rationale"}],
  },"epic-plan.v1"),/duplicate dependency edge id/i);
});

test("work lifecycle contracts reject unsafe IDs, malformed hashes, timestamps, and shape drift",() => {
  const childWithoutAcceptance=clone(CHILD);
  delete childWithoutAcceptance.acceptance_criteria;
  for (const [value,schemaId] of [
    [{...EPIC,id:"../toss-cli#42"},"work-item.v1"],
    [{...EPIC,repository:"TOSS-Soft/../toss-cli"},"work-item.v1"],
    [{...PLAN,content_sha256:"A".repeat(64)},"epic-plan.v1"],
    [{...PLAN,created_at:"2026-02-30T08:00:00.000Z"},"epic-plan.v1"],
    [{...REVIEW,reviewed_revision:"1".repeat(39)},"review-result.v1"],
    [{...REVIEW,reviewed_at:"2026-99-01T09:00:00.000Z"},"review-result.v1"],
    [{...EDGE,provenance:{...EDGE.provenance,locations:[]}},"dependency-edge.v1"],
    [{...CHILD,acceptance_criteria:[]},"work-item.v1"],
    [{...PLAN,children:[childWithoutAcceptance]},"epic-plan.v1"],
  ]) {
    assert.throws(() => validateCoreDocument(value,schemaId),CoreValidationError);
  }

  const sparse=clone(PLAN);
  sparse.children=new Array(1);
  assert.throws(() => validateCoreDocument(sparse,"epic-plan.v1"),CoreValidationError);
  for (const value of [null,42,"work-item"]) {
    assert.throws(() => validateCoreDocument(value,"work-item.v1"),CoreValidationError);
  }
});

test("work-item contracts bind stable identity and reserved branch to the native issue number",() => {
  for (const value of [
    {...EPIC,id:`${REPOSITORY}#41`},
    {...EPIC,repository:"TOSS-Soft/toss-console"},
    {...EPIC,branch:"epic/41-organizational-lifecycle"},
  ]) {
    assert.throws(
      () => validateCoreDocument(value,"work-item.v1"),
      error => error instanceof CoreValidationError && /identity/i.test(error.message),
    );
  }
});

test("work-item contracts bind child parents and base branches to the persisted kind",() => {
  for (const value of [
    {...CHILD,parent_id:"TOSS-Soft/toss-console#42"},
    {...CHILD,base_branch:"issue/40-wrong-base"},
    {...EPIC,base_branch:"bug/40-wrong-base"},
  ]) {
    assert.throws(() => validateCoreDocument(value,"work-item.v1"),CoreValidationError);
  }
});
