import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {canonicalJson,sha256Canonical} from "../src/contracts/acp.js";
import {validateCoreDocument} from "../src/core/contracts.js";
import {
  dependencyReadiness,
  validateDependencyGraph,
} from "../src/core/domain/dependencies.js";
import {CoreConflictError,CoreValidationError} from "../src/core/errors.js";
import {createOperationIntent} from "../src/core/operations/plan.js";
import {
  epicPreparationOperations,
  managedChildMarker,
  normalizeEpicPlan,
} from "../src/core/work/epic-plan.js";

const REPOSITORY="TOSS-Soft/toss-cli";
const OTHER_REPOSITORY="TOSS-Soft/toss-console";
const SHA_A="a".repeat(64);

function fixture(name) {
  return JSON.parse(fs.readFileSync(new URL(`fixtures/core/${name}`,import.meta.url),"utf8"));
}

function edge({edge_id,source,target,revision=edge_id}) {
  return {
    schema_version:"dependency-edge.v1",
    edge_id,
    source,
    target,
    kind:"requires",
    rationale:`${source} requires ${target}`,
    provenance:{source_revision:"request@1",source_sha256:SHA_A,locations:[`edges.${edge_id}`]},
    revision,
  };
}

function normalizationInput(document) {
  return {
    plan_id:document.plan_id,
    created_at:document.created_at,
    epic:document.epic,
    children:document.children,
    dependencies:document.edges,
    source:document.source,
  };
}

function deeplyFrozen(value,seen=new Set()) {
  if (value===null || typeof value!=="object" || seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  return Reflect.ownKeys(value).every(key => deeplyFrozen(value[key],seen));
}

function desiredProjectFields(child) {
  return {
    status:child.status,
    gate:child.gate,
    repository:child.repository,
    parent:child.parent_id,
    branch:child.branch,
    base_branch:child.base_branch,
    milestone:child.milestone,
  };
}

function reconciledSnapshot(plan,{drift=false}={}) {
  return {
    revision:"github-snapshot@2",
    children:plan.children.map(child => ({
      marker:managedChildMarker(child.id),
      id:child.id,
      repository:child.repository,
      acceptance_criteria:drift ? ["Outdated criterion."] : child.acceptance_criteria,
      branch:child.branch,
      project_fields:desiredProjectFields(child),
      revision:`${child.id}@2`,
    })),
    relationships:plan.children.map(child => ({
      child_id:child.id,
      parent_id:plan.epic.id,
      revision:`${child.id}->${plan.epic.id}@2`,
    })),
  };
}

test("dependency stages put every required target before its dependent source",() => {
  const a=`${REPOSITORY}#1`;
  const b=`${REPOSITORY}#2`;
  const c=`${REPOSITORY}#3`;
  const d=`${REPOSITORY}#4`;
  const graph=validateDependencyGraph({
    nodes:[d,b,a,c],
    edges:[
      edge({edge_id:"DEP-D-B",source:d,target:b}),
      edge({edge_id:"DEP-D-C",source:d,target:c}),
      edge({edge_id:"DEP-B-A",source:b,target:a}),
      edge({edge_id:"DEP-C-A",source:c,target:a}),
    ],
  });

  assert.deepEqual(graph.order,[a,b,c,d]);
  assert.deepEqual(graph.stages,[[a],[b,c],[d]]);
  assert.ok(deeplyFrozen(graph));
  assert.notEqual(graph.edges[0],undefined);
});

test("graph and edge ordering is raw code-point deterministic under shuffled inputs",() => {
  const nodes=[`${REPOSITORY}#3`,`${REPOSITORY}#1`,`${REPOSITORY}#2`];
  const edges=[
    edge({edge_id:"DEP-3-2",source:nodes[0],target:nodes[2]}),
    edge({edge_id:"DEP-2-1",source:nodes[2],target:nodes[1]}),
  ];
  const first=validateDependencyGraph({nodes,edges});
  const second=validateDependencyGraph({nodes:[...nodes].reverse(),edges:[...edges].reverse()});

  assert.equal(canonicalJson(first),canonicalJson(second));
  assert.deepEqual(first.edges.map(value => value.edge_id),["DEP-2-1","DEP-3-2"]);
});

test("cross-repository dependencies schedule work without producing a Git base",() => {
  const source=`${REPOSITORY}#43`;
  const target=`${OTHER_REPOSITORY}#7`;
  const graph=validateDependencyGraph({
    nodes:[source,target],
    edges:[edge({edge_id:"DEP-CROSS",source,target})],
  });

  assert.deepEqual(graph.order,[target,source]);
  assert.deepEqual(graph.stages,[[target],[source]]);
  assert.equal(Object.hasOwn(graph.edges[0],"base_branch"),false);
});

test("dependency validation rejects duplicate self dangling and cyclic edges",() => {
  const a=`${REPOSITORY}#1`;
  const b=`${REPOSITORY}#2`;
  const c=`${REPOSITORY}#3`;
  const first=edge({edge_id:"DEP-A",source:a,target:b});
  const cases=[
    {nodes:[a,b],edges:[first,{...first}],pattern:/duplicate edge id/i},
    {nodes:[a,b],edges:[first,edge({edge_id:"DEP-B",source:a,target:b})],pattern:/duplicate dependency/i},
    {nodes:[a],edges:[edge({edge_id:"DEP-SELF",source:a,target:a})],pattern:/self/i},
    {nodes:[a],edges:[edge({edge_id:"DEP-DANGLING",source:a,target:b})],pattern:/dangling target/i},
  ];
  for (const candidate of cases) {
    assert.throws(
      () => validateDependencyGraph({nodes:candidate.nodes,edges:candidate.edges}),
      candidate.pattern,
    );
  }

  assert.throws(() => validateDependencyGraph({
    nodes:[c,b,a],
    edges:[
      edge({edge_id:"DEP-C-A",source:c,target:a}),
      edge({edge_id:"DEP-A-B",source:a,target:b}),
      edge({edge_id:"DEP-B-C",source:b,target:c}),
    ],
  }),error => error instanceof CoreValidationError &&
    error.message.includes(`${a} -> ${b} -> ${c} -> ${a}`));
});

test("dependency boundaries reject exotic values without invoking hostile traps",() => {
  let traps=0;
  const proxy=new Proxy({}, {
    get() { traps+=1; throw new Error("get trap invoked"); },
    getOwnPropertyDescriptor() { traps+=1; throw new Error("descriptor trap invoked"); },
    getPrototypeOf() { traps+=1; throw new Error("prototype trap invoked"); },
    ownKeys() { traps+=1; throw new Error("ownKeys trap invoked"); },
  });
  assert.throws(() => validateDependencyGraph(proxy),CoreValidationError);
  assert.equal(traps,0);

  const sparse=[];
  sparse.length=2;
  sparse[1]=`${REPOSITORY}#1`;
  assert.throws(() => validateDependencyGraph({nodes:sparse,edges:[]}),CoreValidationError);

  let getterCalls=0;
  const hostile={nodes:[`${REPOSITORY}#1`],edges:[]};
  Object.defineProperty(hostile,"edges",{enumerable:true,get() { getterCalls+=1; return []; }});
  assert.throws(() => validateDependencyGraph(hostile),CoreValidationError);
  assert.equal(getterCalls,0);
});

test("dependency readiness returns every incomplete mandatory target",() => {
  const a=`${REPOSITORY}#1`;
  const b=`${REPOSITORY}#2`;
  const c=`${REPOSITORY}#3`;
  const graph=validateDependencyGraph({
    nodes:[a,b,c],
    edges:[
      edge({edge_id:"DEP-A-B",source:a,target:b}),
      edge({edge_id:"DEP-A-C",source:a,target:c}),
    ],
  });

  assert.deepEqual(dependencyReadiness(a,graph,[c]),{ready:false,blocking:[b]});
  assert.deepEqual(dependencyReadiness(a,graph,[c,b]),{ready:true,blocking:[]});
  assert.ok(deeplyFrozen(dependencyReadiness(a,graph,[])));
  assert.throws(() => dependencyReadiness(`${REPOSITORY}#99`,graph,[]),/item is unknown/i);
  assert.throws(() => dependencyReadiness(a,graph,[`${REPOSITORY}#99`]),/unknown completed/i);
  assert.throws(() => dependencyReadiness(a,{...graph,order:[...graph.order].reverse()},[]),CoreValidationError);
});

test("epic plan normalization validates topology orders content and recomputes its hash",() => {
  const source=fixture("epic-plan-valid.json");
  const plan=normalizeEpicPlan({
    ...normalizationInput(source),
    children:[...source.children].reverse(),
    dependencies:[...source.edges].reverse(),
  });
  const hashInput=structuredClone(plan);
  delete hashInput.content_sha256;

  assert.equal(plan.content_sha256,sha256Canonical(hashInput));
  assert.equal(validateCoreDocument(plan,"epic-plan.v1"),plan);
  assert.deepEqual(plan.children.map(child => child.id),[
    `${REPOSITORY}#43`,`${REPOSITORY}#44`,
  ]);
  assert.ok(deeplyFrozen(plan));
  source.children[0].acceptance_criteria[0]="mutated after normalization";
  assert.notEqual(plan.children[0].acceptance_criteria[0],source.children[0].acceptance_criteria[0]);
});

test("committed epic fixtures carry recomputable hashes and cycle fixture is rejected",() => {
  for (const name of ["epic-plan-valid.json","epic-plan-cycle.json"]) {
    const document=fixture(name);
    const hashInput=structuredClone(document);
    delete hashInput.content_sha256;
    assert.equal(document.content_sha256,sha256Canonical(hashInput));
  }
  const cycle=fixture("epic-plan-cycle.json");
  assert.throws(
    () => normalizeEpicPlan(normalizationInput(cycle)),
    error => error instanceof CoreValidationError && /cycle/i.test(error.message),
  );
});

test("epic plan normalization rejects altered topology and closed-input violations",() => {
  const source=fixture("epic-plan-valid.json");
  const cases=[
    {...normalizationInput(source),source:{...source.source,repository:OTHER_REPOSITORY}},
    {...normalizationInput(source),children:[{...source.children[0],parent_id:`${REPOSITORY}#99`}]},
    {...normalizationInput(source),children:[{...source.children[0],milestone:"v2.2.0"}]},
    {...normalizationInput(source),dependencies:[{...source.edges[0],source:`${REPOSITORY}#99`}]},
    {...normalizationInput(source),extra:true},
  ];
  for (const candidate of cases) {
    assert.throws(() => normalizeEpicPlan(candidate),CoreValidationError);
  }
});

test("epic preparation creates canonically valid native child operations",() => {
  const plan=normalizeEpicPlan(normalizationInput(fixture("epic-plan-valid.json")));
  const operations=epicPreparationOperations(plan,{
    revision:"github-snapshot@1",
    children:[],
    relationships:[],
  });

  assert.equal(operations.length,2);
  assert.ok(deeplyFrozen(operations));
  assert.deepEqual(operations.map(operation => operation.payload.work_item_id).sort(),[
    `${REPOSITORY}#43`,`${REPOSITORY}#44`,
  ]);
  const firstChild=operations.find(operation => operation.payload.work_item_id===plan.children[0].id);
  assert.equal(firstChild.payload.native_parent_id,plan.epic.id);
  assert.deepEqual(firstChild.payload.acceptance_criteria,plan.children[0].acceptance_criteria);
  assert.equal(firstChild.payload.reserved_branch,plan.children[0].branch);
  assert.equal(firstChild.payload.project.membership,"TOSS OS");
  assert.equal(Object.hasOwn(firstChild.payload,"base_repository"),false);

  const intent=createOperationIntent({
    intent_id:"INTENT-20260901-0042",
    created_at:"2026-09-01T10:10:00.000Z",
    command:"epic.prepare",
    policy_revision:"POLICY-0001",
    source:plan.source,
    authority:null,
    operations,
  });
  assert.equal(intent.operations.length,2);
});

test("epic preparation updates drift and skips fully matching native children",() => {
  const plan=normalizeEpicPlan(normalizationInput(fixture("epic-plan-valid.json")));
  const drifted=reconciledSnapshot(plan,{drift:true});
  const updates=epicPreparationOperations(plan,drifted);

  assert.equal(updates.length,2);
  assert.ok(updates.every(operation => operation.action==="update"));
  assert.deepEqual(epicPreparationOperations(plan,reconciledSnapshot(plan)),[]);
});

test("epic preparation preserves governed children and rejects marker identity or parent conflicts",() => {
  const plan=normalizeEpicPlan(normalizationInput(fixture("epic-plan-valid.json")));
  const matching=reconciledSnapshot(plan);
  const omitted={
    ...matching,
    children:[...matching.children,{
      ...matching.children[0],
      marker:managedChildMarker(`${REPOSITORY}#45`),
      id:`${REPOSITORY}#45`,
      revision:`${REPOSITORY}#45@2`,
    }],
    relationships:[...matching.relationships,{
      child_id:`${REPOSITORY}#45`,parent_id:plan.epic.id,revision:"relationship@45",
    }],
  };
  assert.throws(() => epicPreparationOperations(plan,omitted),CoreConflictError);

  const wrongMarker=structuredClone(matching);
  wrongMarker.children[0].marker=managedChildMarker(plan.children[1].id);
  assert.throws(() => epicPreparationOperations(plan,wrongMarker),CoreConflictError);

  const wrongParent=structuredClone(matching);
  wrongParent.relationships[0].parent_id=`${REPOSITORY}#99`;
  assert.throws(() => epicPreparationOperations(plan,wrongParent),CoreConflictError);

  const wrongRepository=structuredClone(matching);
  wrongRepository.children[0].repository=OTHER_REPOSITORY;
  assert.throws(() => epicPreparationOperations(plan,wrongRepository),CoreConflictError);
});

test("epic preparation is idempotent after applying its desired snapshot",() => {
  const plan=normalizeEpicPlan(normalizationInput(fixture("epic-plan-valid.json")));
  const initial={revision:"github-snapshot@1",children:[],relationships:[]};
  assert.equal(epicPreparationOperations(plan,initial).length,2);
  assert.deepEqual(epicPreparationOperations(plan,reconciledSnapshot(plan)),[]);
});
