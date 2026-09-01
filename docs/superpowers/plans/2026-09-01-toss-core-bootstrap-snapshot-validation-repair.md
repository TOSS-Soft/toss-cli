# TOSS Core Bootstrap Snapshot Validation Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace early and distributed bootstrap decisions with one closed, revision-pinned ledger validation pipeline that fails closed on partial, late, exotic, or receipt-inconsistent control state.

**Architecture:** A small `root-snapshot` module closes repository-supplied snapshot values and classifies safe control paths without executing accessors or proxies. The control store then builds one immutable validated-ledger result at a captured revision; every bootstrap-, organization-, registry-, receipt-, and recovery-facing reader consumes that same result before returning.

**Tech Stack:** Node.js ESM, `node:test`, Git plumbing through the existing injected `execFile` port, existing ACP canonical JSON and TOSS Core validators.

**Spec:** `docs/superpowers/specs/2026-09-01-toss-core-bootstrap-snapshot-validation-repair-design.md`

## Global Constraints

- Keep the exact five-document root transaction, seven-operation bootstrap intent, and three remote bootstrap observations.
- Add no persisted marker, schema, migration, dependency, network call, GitHub mutation, environment injection, or version bump.
- Capture one exact revision per read and never re-read ambient `HEAD` inside that validation.
- Reject proxy, accessor, symbol, hidden, sparse, exotic-prototype, unsafe-path, duplicate, and unsorted snapshot data before consuming it.
- Map malformed provider output, incomplete control state, receipt ambiguity, and bootstrap corruption to `CONTROL_LEDGER_CONFLICT`; existing CLI mapping remains exit 6.
- Preserve the approved portable path contract, Git CAS/hook semantics, JSON purity, dual package boundary, and legacy `toss` behavior.
- Keep tests hermetic; do not contact GitHub or embed production URLs or tokens.
- Keep `.superpowers/sdd/**` reports ignored and untracked.
- Use TDD for every task, a fresh independent review after every task, no more than five fix rounds per task, and one final whole-plan review.

---

### Task 1: Close the root-snapshot trust boundary

**Files:**

- Create: `src/core/control/root-snapshot.js`
- Modify: `src/core/control/git-repository.js:19-72,372-390`
- Test: `test/core-control-store.test.js`

**Interfaces:**

- Consumes: the existing repository port result `{revision, paths}` and the `%2F` repository-filename ruling.
- Produces: `closeRootSnapshot(value)`, `closeDocumentPaths(value,label)`, `assertSafeSnapshotPath(value)`, `hasControlMaterial(paths)`, and frozen `CONTROL_ROOTS` for Task 2.
- `closeRootSnapshot(value)` returns a new deeply frozen `{revision:string, paths:readonly string[]}` or throws `TypeError` without invoking getters or proxy traps.
- `closeDocumentPaths(value,label)` accepts only a dense, strictly raw-code-point-sorted, globally unique ordinary string array.

- [ ] **Step 1: Write failing closure and real-Git path tests**

Add imports and focused tests to `test/core-control-store.test.js`:

```js
import {
  closeDocumentPaths,
  closeRootSnapshot,
  hasControlMaterial,
} from "../src/core/control/root-snapshot.js";

test("root snapshots close own data without invoking hostile values",() => {
  const sha="a".repeat(40);
  const closed=closeRootSnapshot({revision:sha,paths:["README.md","config/organization.yaml"]});
  assert.deepEqual(closed,{revision:sha,paths:["README.md","config/organization.yaml"]});
  assert.equal(Object.isFrozen(closed),true);
  assert.equal(Object.isFrozen(closed.paths),true);

  let getterCalls=0;
  const accessor={paths:[]};
  Object.defineProperty(accessor,"revision",{enumerable:true,get() { getterCalls+=1; return sha; }});
  assert.throws(() => closeRootSnapshot(accessor),/own.*data|snapshot/i);
  assert.equal(getterCalls,0);

  let trapCalls=0;
  const proxy=new Proxy({revision:sha,paths:[]},{getPrototypeOf() { trapCalls+=1; return Object.prototype; }});
  assert.throws(() => closeRootSnapshot(proxy),/proxy|snapshot/i);
  assert.equal(trapCalls,0);

  const paths=["config/organization.yaml"];
  Object.defineProperty(paths,"hidden",{value:"receipts/2026/09/hidden.json"});
  assert.throws(() => closeDocumentPaths(paths,"root snapshot paths"),/own|hidden|path/i);
});

test("control material classification is exact",() => {
  assert.equal(hasControlMaterial(["README.md"]),false);
  assert.equal(hasControlMaterial(["config/organization.yaml"]),true);
  assert.equal(hasControlMaterial(["programs/P1/manifest.yaml"]),true);
});

test("Git root snapshots accept unrelated safe blobs and retain safe paths",async t => {
  const root=await createRepository(t);
  await writeFile(join(root,"README.md"),"unrelated root\n","utf8");
  await git(root,["add","--","README.md"]);
  await git(root,["commit","-m","unrelated root"]);
  const repositoryControl=control(root);
  const at=await repositoryControl.head();
  assert.deepEqual(await repositoryControl.rootSnapshotAt({at}),{
    revision:at,
    paths:["README.md"],
  });
});
```

Extend the first test with wrong prototypes, symbols, extra enumerable keys,
hidden root keys, sparse arrays, accessor array indices, nested array proxies,
duplicate paths, unsorted paths, traversal, absolute paths, backslashes, NUL,
Windows drive prefixes, and a valid
`config/repositories/toss-soft%2Ftoss-cli.yaml` path.

Use an explicit table so every case has a stable expected failure:

```js
const invalidPaths=[
  ["sparse",Object.assign(Array(2),{0:"README.md"})],
  ["duplicate",["README.md","README.md"]],
  ["unsorted",["receipts/R.json","config/organization.yaml"]],
  ["traversal",["../outside.json"]],
  ["absolute",["/outside.json"]],
  ["backslash",["config\\outside.json"]],
  ["nul",["config/outside\0.json"]],
  ["drive",["C:/outside.json"]],
];
for (const [name,paths] of invalidPaths) {
  assert.throws(() => closeDocumentPaths(paths,name),TypeError);
}
assert.deepEqual(
  closeDocumentPaths(["config/repositories/toss-soft%2Ftoss-cli.yaml"],"repository path"),
  ["config/repositories/toss-soft%2Ftoss-cli.yaml"],
);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test test/core-control-store.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for
`src/core/control/root-snapshot.js`; after the empty module exists, the real-Git
README test must still fail because the existing root-tree validator accepts
only `.json` and `.yaml` document paths.

- [ ] **Step 3: Implement the closed snapshot module**

Create `src/core/control/root-snapshot.js` with this public shape:

```js
import {types} from "node:util";

const SHA=/^[a-f0-9]{40}$/u;
const SEGMENT=/^[A-Za-z0-9._-]+$/u;
const REPOSITORY_FILENAME=/^[a-z0-9._-]+%2F[a-z0-9._-]+[.]yaml$/u;
export const CONTROL_ROOTS=Object.freeze([
  "config","intents","migrations","policies","programs","receipts",
]);

function rawCompare(left,right) {
  return left===right ? 0 : left<right ? -1 : 1;
}

export function assertSafeSnapshotPath(value) {
  if (typeof value!=="string" || !value || value.includes("\\") ||
      value.startsWith("/") || value.includes("\0") || /^[A-Za-z]:/u.test(value)) {
    throw new TypeError("root snapshot contains an unsafe path");
  }
  const segments=value.split("/");
  const generatedRepositoryPath=segments.length===3 && segments[0]==="config" &&
    segments[1]==="repositories" && REPOSITORY_FILENAME.test(segments[2]) &&
    encodeURIComponent(decodeURIComponent(segments[2].slice(0,-5)))===segments[2].slice(0,-5);
  if (!generatedRepositoryPath && segments.some(segment =>
    !segment || segment==="." || segment===".." || !SEGMENT.test(segment))) {
    throw new TypeError("root snapshot contains an unsafe path");
  }
  return value;
}

export function closeDocumentPaths(value,label) {
  if (!Array.isArray(value) || types.isProxy(value) ||
      Object.getPrototypeOf(value)!==Array.prototype) {
    throw new TypeError(`${label} must be an ordinary non-proxy array`);
  }
  const descriptors=Object.getOwnPropertyDescriptors(value);
  const keys=Reflect.ownKeys(descriptors);
  const expected=[...Array(value.length).keys()].map(String).concat("length");
  if (keys.some(key => typeof key!=="string") || keys.length!==expected.length ||
      expected.some(key => !Object.hasOwn(descriptors,key))) {
    throw new TypeError(`${label} must be dense and contain no extra properties`);
  }
  const paths=[];
  for (let index=0;index<value.length;index+=1) {
    const descriptor=descriptors[String(index)];
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} must contain only enumerable data entries`);
    }
    paths.push(assertSafeSnapshotPath(descriptor.value));
  }
  for (let index=1;index<paths.length;index+=1) {
    if (rawCompare(paths[index-1],paths[index])>=0) {
      throw new TypeError(`${label} must be strictly sorted and unique`);
    }
  }
  return Object.freeze(paths);
}

export function closeRootSnapshot(value) {
  if (value===null || typeof value!=="object" || types.isProxy(value) ||
      ![Object.prototype,null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("root snapshot must be an ordinary non-proxy object");
  }
  const descriptors=Object.getOwnPropertyDescriptors(value);
  const keys=Reflect.ownKeys(descriptors);
  if (keys.length!==2 || keys.some(key => typeof key!=="string") ||
      !Object.hasOwn(descriptors,"revision") || !Object.hasOwn(descriptors,"paths")) {
    throw new TypeError("root snapshot must contain exactly revision and paths");
  }
  for (const key of ["revision","paths"]) {
    if (!("value" in descriptors[key]) || !descriptors[key].enumerable) {
      throw new TypeError("root snapshot fields must be own enumerable data");
    }
  }
  const revision=descriptors.revision.value;
  if (typeof revision!=="string" || !SHA.test(revision)) {
    throw new TypeError("root snapshot revision must be an exact Git SHA");
  }
  return Object.freeze({
    revision,
    paths:closeDocumentPaths(descriptors.paths.value,"root snapshot paths"),
  });
}

export function hasControlMaterial(paths) {
  return paths.some(path => CONTROL_ROOTS.some(root => path===root || path.startsWith(`${root}/`)));
}
```

Keep error messages deterministic. Descriptor checks must occur before reading
`revision`, `paths`, or array entries. Do not spread or JSON-clone the untrusted
value.

In `src/core/control/git-repository.js`, import
`assertSafeSnapshotPath()` and use it only for the full root-tree inventory in
`rootSnapshotAt()`. Keep `assertSafeRelativePath()` for control document reads
and writes so unsupported document extensions remain rejected there.

- [ ] **Step 4: Run focused and boundary tests and verify GREEN**

Run:

```bash
node --test test/core-control-store.test.js
node scripts/test-boundaries.mjs
node --check src/core/control/root-snapshot.js
node --check src/core/control/git-repository.js
git diff --check
```

Expected: all commands exit 0; malicious counters remain zero; the README root
snapshot is returned as frozen safe data.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/core/control/root-snapshot.js src/core/control/git-repository.js test/core-control-store.test.js
git commit -m "fix(core): close root snapshot trust boundary"
```

---

### Task 2: Build one pinned bootstrap-state validator

**Files:**

- Modify: `src/core/control/store.js:155-217,369-378`
- Test: `test/core-control-store.test.js:841-end`

**Interfaces:**

- Consumes: Task 1 `closeRootSnapshot`, `closeDocumentPaths`,
  `CONTROL_ROOTS`, and `hasControlMaterial`.
- Produces: one internal
  `loadValidatedLedgerAt(revision)` result with exact shape
  `{revision,classification,bootstrap,intentRecords,receiptRecords,currentPaths}`.
- `classification` is exactly `"absent"` or `"verified"`.
- `bootstrap` is `null` only for `absent`; otherwise it is the deeply frozen
  exact root proof `{root,organization,lifecycle,release,intent,receipt}`.

- [ ] **Step 1: Extract an exact bootstrap fixture and write adversarial RED tests**

Extract the current inline valid bootstrap data into a test helper that returns
new values for each call:

```js
function bootstrapFixture({intentId="INTENT-20260901-0099",receiptNumber="0099"}={}) {
  const organization={...organization(),repositories:[]};
  const lifecycle={revision:"POLICY-0001"};
  const release={revision:"POLICY-0001"};
  const hashes={
    organization:sha256Canonical(organization),
    lifecycle:sha256Canonical(lifecycle),
    release:sha256Canonical(release),
  };
  const repository=organization.control_repository;
  const intent=createOperationIntent({
    intent_id:intentId,
    created_at:"2026-09-01T08:00:00.000Z",
    command:"init",
    policy_revision:organization.policy_revision,
    source:{repository,revision:"r0",sha256:"a".repeat(64)},
    authority:{record_id:"AUTH-20260901-0001",sha256:"a".repeat(64)},
    operations:[
      {resource:"repository",action:"create",repository,expected_revision:null,payload:{kind:"create-private-control-repository",private:true,files:hashes}},
      {resource:"repository",action:"update",repository,expected_revision:null,payload:{kind:"verify-default-branch-protection"}},
      {resource:"project",action:"update",repository:null,expected_revision:"project-r1",payload:{kind:"discover-project-fields",project:organization.project}},
      ...[["organization-config",hashes.organization],["lifecycle-policy",hashes.lifecycle],["release-policy",hashes.release]].map(([kind,sha256]) => ({resource:"repository",action:"commit",repository,expected_revision:null,payload:{kind,sha256}})),
      {resource:"repository",action:"commit",repository,expected_revision:null,payload:{kind:"first-control-transaction",files:hashes}},
    ],
  });
  const remoteKinds=new Set(["create-private-control-repository","verify-default-branch-protection","discover-project-fields"]);
  const receipt=receiptForIntent(intent,{number:receiptNumber,observed_revisions:intent.operations.filter(operation => remoteKinds.has(operation.payload.kind)).map(operation => ({operation_id:operation.operation_id,repository:operation.repository,revision:"r1"}))});
  const files={
    "config/organization.yaml":organization,
    "policies/lifecycle.yaml":lifecycle,
    "policies/release.yaml":release,
    [intentPath(intent)]:intent,
    [receiptPath(receipt)]:receipt,
  };
  return {organization,lifecycle,release,intent,receipt,files};
}
```

Add real-Git tests for these exact cases:

```js
test("bootstrap state validates current control material before returning absent",async t => {
  const root=await createRepository(t);
  await writeFile(join(root,"README.md"),"unrelated root\n","utf8");
  await git(root,["add","--","README.md"]);
  await git(root,["commit","-m","unrelated root"]);
  const repositoryControl=control(root);
  const store=createCoreControlStore({repository:repositoryControl});
  assert.equal(await store.loadBootstrapState(),null);

  const fixture=bootstrapFixture();
  await repositoryControl.commitFiles({
    expectedHead:await repositoryControl.head(),
    message:"late bootstrap-shaped transaction",
    files:fixture.files,
  });
  await assert.rejects(store.loadBootstrapState(),error =>
    error?.code==="CONTROL_LEDGER_CONFLICT");
});

test("partial control roots are corruption, never absent bootstrap",async t => {
  for (const [name,files] of [
    ["organization",{"config/organization.yaml":{...organization(),repositories:[]}}],
    ["policy",{"policies/lifecycle.yaml":{revision:"POLICY-0001"}}],
    ["program",{"programs/P1/manifest.yaml":{id:"P1"}}],
    ["migration",{"migrations/M1/snapshot.json":{id:"M1"}}],
  ]) {
    const root=await createRepository(t);
    const repositoryControl=control(root);
    await repositoryControl.commitFiles({expectedHead:null,message:`partial ${name}`,files});
    const store=createCoreControlStore({repository:repositoryControl});
    await assert.rejects(store.loadBootstrapState(),error =>
      error?.code==="CONTROL_LEDGER_CONFLICT");
  }
});
```

Add a fake-port matrix whose `rootSnapshotAt` returns accessor, root proxy,
nested paths proxy, hidden/symbol fields, or throws. Assert
`CONTROL_LEDGER_CONFLICT` and zero getter/proxy-trap calls.

Use this closed fake repository shape so the only variable is the root port:

```js
function repositoryWithRootPort(rootPort) {
  const revision="a".repeat(40);
  return Object.freeze({
    async head() { return revision; },
    async readDocument() { return null; },
    async listDocuments() { return Object.freeze([]); },
    rootSnapshotAt:rootPort,
    async commitFiles() { throw new Error("write is not expected"); },
  });
}

test("store wraps malformed root ports without invoking hostile fields",async () => {
  let getterCalls=0;
  const accessor={paths:[]};
  Object.defineProperty(accessor,"revision",{
    enumerable:true,
    get() { getterCalls+=1; return "a".repeat(40); },
  });
  const store=createCoreControlStore({
    repository:repositoryWithRootPort(async () => accessor),
  });
  await assert.rejects(store.loadBootstrapState(),error =>
    error?.code==="CONTROL_LEDGER_CONFLICT");
  assert.equal(getterCalls,0);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test test/core-control-store.test.js
```

Expected: the unrelated-root/late-bootstrap case returns `null`, the
organization-only root returns `null`, and at least one exotic port case leaks
an untyped provider error before the implementation.

- [ ] **Step 3: Implement the shared validator and remove early bootstrap branching**

In `src/core/control/store.js`, import Task 1 helpers and replace direct
snapshot inspection with this flow:

```js
async function currentControlPathsAt(revision) {
  const groups=await Promise.all(CONTROL_ROOTS.map(async root =>
    closeDocumentPaths(await listDocuments(root,{at:revision}),`repository.${root} paths`)));
  const paths=groups.flat().sort(rawCompare);
  return closeDocumentPaths(paths,"current control paths");
}

async function rootBootstrapProofFrom(snapshot) {
  if (!hasControlMaterial(snapshot.paths)) return null;
  const root=snapshot.revision;
  const [organizationDocument,lifecycle,release,intents,receipts]=await Promise.all([
    readAt(CONTROL_PATHS.organization,root),
    readAt(`${CONTROL_PATHS.policies}/lifecycle.yaml`,root),
    readAt(`${CONTROL_PATHS.policies}/release.yaml`,root),
    resolveGlobalIdentities({revision:root,prefix:CONTROL_PATHS.intents,schemaId:"operation-intent.v1",label:"intent",idField:"intent_id",pathFor:intentPath,ledgerRead:true}),
    resolveGlobalIdentities({revision:root,prefix:CONTROL_PATHS.receipts,schemaId:"operation-receipt.v1",label:"receipt",idField:"receipt_id",pathFor:receiptPath,ledgerRead:true}),
  ]);
  if (organizationDocument===null || lifecycle===null || release===null ||
      intents.length!==1 || receipts.length!==1) {
    throw ledgerConflict("bootstrap root is incomplete");
  }
  const organization=validateCoreDocument(organizationDocument,"organization-config.v1");
  const intent=intents[0].document;
  const receipt=receipts[0].document;
  const expected=[CONTROL_PATHS.organization,`${CONTROL_PATHS.policies}/lifecycle.yaml`,`${CONTROL_PATHS.policies}/release.yaml`,intentPath(intent),receiptPath(receipt)].sort(rawCompare);
  if (!equivalent(snapshot.paths,expected)) throw ledgerConflict("bootstrap root tree is not exact");
  bootstrapProof({organization,lifecycle,release,intent,receipt});
  return Object.freeze({root,organization,lifecycle,release,intent,receipt});
}

async function loadValidatedLedgerAt(revision) {
  if (revision===null) return Object.freeze({
    revision:null,classification:"absent",bootstrap:null,
    intentRecords:Object.freeze([]),receiptRecords:Object.freeze([]),
    currentPaths:Object.freeze([]),
  });
  let snapshot;
  try { snapshot=closeRootSnapshot(await rootSnapshotAt({at:revision})); }
  catch (error) { throw ledgerConflict("bootstrap root snapshot is malformed",{cause:error}); }
  const [currentPaths,intentRecords,receiptRecords]=await Promise.all([
    currentControlPathsAt(revision),
    resolveGlobalIdentities({revision,prefix:CONTROL_PATHS.intents,schemaId:"operation-intent.v1",label:"intent",idField:"intent_id",pathFor:intentPath,ledgerRead:true}),
    resolveGlobalIdentities({revision,prefix:CONTROL_PATHS.receipts,schemaId:"operation-receipt.v1",label:"receipt",idField:"receipt_id",pathFor:receiptPath,ledgerRead:true}),
  ]);
  let bootstrap;
  try { bootstrap=await rootBootstrapProofFrom(snapshot); }
  catch (error) { throw error?.code==="CONTROL_LEDGER_CONFLICT" ? error : ledgerConflict("bootstrap root proof is corrupt",{cause:error}); }
  if (bootstrap===null && hasControlMaterial(currentPaths)) {
    throw ledgerConflict("control material exists without an exact root bootstrap");
  }
  if (bootstrap!==null) {
    const persistedIntent=intentRecords.filter(record => record.document.intent_id===bootstrap.intent.intent_id);
    const persistedReceipt=receiptRecords.filter(record => record.document.receipt_id===bootstrap.receipt.receipt_id);
    if (persistedIntent.length!==1 || persistedReceipt.length!==1 ||
        !equivalent(persistedIntent[0].document,bootstrap.intent) ||
        !equivalent(persistedReceipt[0].document,bootstrap.receipt)) {
      throw ledgerConflict("immutable bootstrap records differ from the root transaction");
    }
  }
  validatePersistedReceiptRecords(receiptRecords,intentRecords,{bootstrapReceipt:bootstrap?.receipt});
  return Object.freeze({
    revision,
    classification:bootstrap===null ? "absent" : "verified",
    bootstrap,
    intentRecords:Object.freeze(intentRecords),
    receiptRecords:Object.freeze(receiptRecords),
    currentPaths,
  });
}
```

`loadBootstrapState()` must call `loadValidatedLedgerAt(revision)` and only then
branch on `validated.classification`. Delete `rootBootstrapProofAt()` and
`bootstrapReceiptException()` so no earlier or weaker path remains.

- [ ] **Step 4: Run the focused Foundation store suite and verify GREEN**

Run:

```bash
node --test test/core-control-store.test.js
node --test test/core-foundation-commands.test.js
node --check src/core/control/store.js
git diff --check
```

Expected: all commands exit 0; `loadBootstrapState()` returns `null` only for an
unborn or unrelated current tree with no control paths.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/core/control/store.js test/core-control-store.test.js
git commit -m "fix(core): validate bootstrap from one pinned ledger"
```

---

### Task 3: Route every ledger reader through the validated snapshot

**Files:**

- Modify: `src/core/control/store.js:248-378,416-500`
- Test: `test/core-control-store.test.js:274-505,747-end`
- Test: `test/core-foundation-commands.test.js`

**Interfaces:**

- Consumes: Task 2 `loadValidatedLedgerAt(revision)` and its frozen record sets.
- Produces: consistent validated behavior for `loadOrganization`,
  `loadRepository`, `listRepositories`, `loadRegistryState`,
  `loadOrganizationState`, `loadBootstrapState`, `findReceipt`, and
  `findCompletedRepositoryRegistration`.
- Produces internal `findReceiptInLedger(intent,validated)` so exact lookup and
  recovery cannot run a second or weaker validator.

- [ ] **Step 1: Write reader-agreement and continuity RED tests**

Add a helper that creates a valid root bootstrap through `commitBootstrap()`:

```js
async function createBootstrappedStore(t) {
  const root=await createRepository(t);
  const repositoryControl=control(root);
  const store=createCoreControlStore({repository:repositoryControl});
  const bootstrap=bootstrapFixture();
  const committed=await store.commitBootstrap({expectedHead:null,files:bootstrap.files});
  return {root,repositoryControl,store,bootstrap,head:committed.commit_sha};
}
```

Use it for successful public-reader and receipt tests that previously created an
intent-only root. Add this agreement test:

```js
test("all public readers reject late or partial control state consistently",async t => {
  const root=await createRepository(t);
  await writeFile(join(root,"README.md"),"unrelated root\n","utf8");
  await git(root,["add","--","README.md"]);
  await git(root,["commit","-m","unrelated root"]);
  const repositoryControl=control(root);
  const store=createCoreControlStore({repository:repositoryControl});
  const fixture=bootstrapFixture();
  await repositoryControl.commitFiles({
    expectedHead:await repositoryControl.head(),
    message:"late bootstrap",
    files:fixture.files,
  });
  for (const read of [
    () => store.loadBootstrapState(),
    () => store.loadOrganizationState(),
    () => store.loadOrganization(),
    () => store.loadRegistryState(),
    () => store.findReceipt(fixture.intent),
  ]) {
    await assert.rejects(read(),error => error?.code==="CONTROL_LEDGER_CONFLICT");
  }
});
```

Add a continuity test that starts with `createBootstrappedStore(t)`, commits one
ordinary canonical intent and exact completed receipt, commits one repository
configuration update, and then proves:

```js
const {store,bootstrap,head}=await createBootstrappedStore(t);
const ordinaryIntent={...intent(),intent_id:"INTENT-20260901-0001"};
const saved=await store.commitIntent({expectedHead:head,intent:ordinaryIntent});
const ordinaryReceipt=receiptForIntent(ordinaryIntent,{number:"0001"});
const recorded=await store.commitReceipt({expectedHead:saved.commit_sha,receipt:ordinaryReceipt});
const config=repositoryConfig();
await store.commitConfiguration({
  expectedHead:recorded.commit_sha,
  files:{
    "config/organization.yaml":{
      ...bootstrap.organization,
      repositories:[config.repository],
    },
    [repositoryPath(config.repository)]:config,
  },
});
assert.equal((await store.loadBootstrapState()).receipt.receipt_id,bootstrap.receipt.receipt_id);
assert.equal((await store.findReceipt(bootstrap.intent)).receipt_id,bootstrap.receipt.receipt_id);
assert.equal((await store.findReceipt(ordinaryIntent)).receipt_id,ordinaryReceipt.receipt_id);
assert.equal((await store.loadOrganizationState()).receipts.length,2);
assert.equal((await store.loadRegistryState()).repositories.length,1);
```

Also prove all readers reject: two receipt IDs for one intent, a later
bootstrap-shaped subset receipt, an ordinary `init` subset receipt, removal or
mutation of the root intent/receipt in the current tree, and current
organization-only material after an unrelated root. Failed ordinary receipts
with partial or empty observations must remain readable.

- [ ] **Step 2: Run the focused suites and verify RED**

Run:

```bash
node --test test/core-control-store.test.js test/core-foundation-commands.test.js test/core-operation-runner.test.js
```

Expected: at least `loadOrganization()`, `loadRegistryState()`, or an exact
receipt lookup accepts a late/partial state or bypasses Task 2's validated
result before the reader migration.

- [ ] **Step 3: Make all readers consume one validated result**

Introduce exact-revision internal helpers and keep public methods as thin head
capture wrappers:

```js
function findReceiptInLedger(intent,validated) {
  const valid=validateCoreDocument(intent,"operation-intent.v1");
  const matches=validated.receiptRecords.filter(record =>
    record.document.intent_id===valid.intent_id);
  const persisted=validated.intentRecords.filter(record =>
    record.document.intent_id===valid.intent_id);
  if (matches.length===0) return null;
  if (matches.length!==1 || persisted.length!==1 ||
      matches[0].document.intent_sha256!==sha256Canonical(valid) ||
      !equivalent(persisted[0].document,valid)) {
    throw ledgerConflict(`receipt lookup conflicts with intent: ${valid.intent_id}`);
  }
  return matches[0].document;
}

async function findReceiptAt(intent,revision) {
  return findReceiptInLedger(intent,await loadValidatedLedgerAt(revision));
}
```

Refactor registry assembly into `loadRegistryStateAt(validated)` so
`findCompletedRepositoryRegistration()` captures one head, obtains one
validated result, reads registry configuration at that revision, and passes the
same result to `findReceiptInLedger()`. Do not call a public reader from another
public reader when that would re-read `HEAD`.

Apply the same pattern to organization and repository readers. An unborn or
validated `absent` ledger may return empty/null read results. Any born current
tree with control material but no verified root must already have failed in
`loadValidatedLedgerAt()`.

Update successful low-level receipt tests to use the valid bootstrap helper
before adding ordinary intent/receipt records. Keep direct raw-Git corruption
fixtures only for tests that expect `CONTROL_LEDGER_CONFLICT`.

- [ ] **Step 4: Run all repair and Foundation regression lanes**

Run:

```bash
node --test test/core-contracts.test.js test/core-command-contract.test.js test/core-control-store.test.js test/core-operation-runner.test.js test/core-foundation-commands.test.js test/core-cli-boundary.test.js
npm run test:fast
npm run test:integration
npm run test:e2e
npm run test:package
node scripts/test-boundaries.mjs
node --check src/core/control/root-snapshot.js
node --check src/core/control/git-repository.js
node --check src/core/control/store.js
git diff --check
```

Expected: every command exits 0; all successful read fixtures have a verified
root bootstrap; all malformed/late fixtures fail with
`CONTROL_LEDGER_CONFLICT`.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/core/control/store.js test/core-control-store.test.js test/core-foundation-commands.test.js
git commit -m "fix(core): unify validated control ledger readers"
```

---

## Plan Completion Gate

- [ ] Run `npm run test:full` and confirm exit 0 with no failed manifest entry.
- [ ] Run `npm pack --dry-run --json` and confirm both bins, every
  `contracts/core/**` file, and every `src/core/**` file are present.
- [ ] Run `git diff --check` and syntax-check every changed JavaScript file.
- [ ] Scan the implementation delta for production GitHub URLs, credentials,
  token-like values, environment/preload runtime injection, and tracked
  `.superpowers/sdd/**` artifacts.
- [ ] Confirm `package.json` remains version `2.1.1` and the tracked worktree is
  clean.
- [ ] Run a fresh independent whole-repair review over the commit containing
  this plan through implementation `HEAD`.
- [ ] Run a fresh whole-Foundation review over `b51d4b8..HEAD`; do not begin the
  work-lifecycle plan until it reports no Critical or Important finding.
- [ ] Record the accepted Foundation commit SHA in
  `docs/superpowers/plans/2026-09-01-toss-core-work-lifecycle.md` execution notes
  before starting that plan.
