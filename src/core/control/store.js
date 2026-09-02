import {types} from "node:util";

import {canonicalJson,sha256Canonical} from "../../contracts/acp.js";
import {validateCoreDocument} from "../contracts.js";
import {createOperationIntent} from "../operations/plan.js";
import {assertRepositoryConcurrency} from "../release/state.js";
import {
  closeDocumentPaths,
  closeRootSnapshot,
  CONTROL_ROOTS,
  hasControlMaterial,
} from "./root-snapshot.js";

export const CONTROL_PATHS=Object.freeze({
  organization:"config/organization.yaml",
  repositories:"config/repositories",
  policies:"policies",
  programs:"programs",
  intents:"intents",
  receipts:"receipts",
  migrations:"migrations",
});

function monthPath(root,value,id) {
  if (value===null || typeof value!=="object" || typeof value.created_at!=="string" || typeof value[id]!=="string") {
    throw new TypeError(`control ${id} document must contain created_at and ${id}`);
  }
  const match=/^(\d{4})-(\d{2})-/u.exec(value.created_at);
  if (!match) throw new TypeError("control document created_at must begin with YYYY-MM-");
  return `${root}/${match[1]}/${match[2]}/${value[id]}.json`;
}

export function intentPath(intent) {
  return monthPath(CONTROL_PATHS.intents,intent,"intent_id");
}

export function receiptPath(receipt) {
  return monthPath(CONTROL_PATHS.receipts,receipt,"receipt_id");
}

export function repositoryFilename(identity) {
  if (typeof identity!=="string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(identity)) {
    throw new TypeError("repository identity must be canonical OWNER/REPO");
  }
  return `${encodeURIComponent(identity)}.yaml`;
}

export function repositoryPath(identity) {
  return `${CONTROL_PATHS.repositories}/${repositoryFilename(identity)}`;
}

export function programPath(identity) {
  if (typeof identity!=="string" || !/^TOSS-OS-R[0-9]{4,}$/u.test(identity)) {
    throw new TypeError("release program identity must be canonical");
  }
  return `${CONTROL_PATHS.programs}/${identity}/manifest.yaml`;
}

function ownDataFunction(value,key) {
  if (value===null || typeof value!=="object" || types.isProxy(value)) {
    throw new TypeError("repository must be a non-proxy object");
  }
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value!=="function" || types.isProxy(descriptor.value)) {
    throw new TypeError(`repository.${key} must be an own-data non-proxy function`);
  }
  return descriptor.value;
}

function optionalOwnDataFunction(value,key) {
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if (!descriptor) return null;
  if (!("value" in descriptor) || typeof descriptor.value!=="function" || types.isProxy(descriptor.value)) {
    throw new TypeError(`repository.${key} must be an own-data non-proxy function when provided`);
  }
  return descriptor.value;
}

function equivalent(left,right) {
  return canonicalJson(left)===canonicalJson(right);
}

function deepFreeze(value) {
  if (value!==null && typeof value==="object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function frozenCanonicalCopy(value) {
  return deepFreeze(JSON.parse(canonicalJson(value)));
}

function closeFileEntries(files,label) {
  if (files===null || typeof files!=="object" || Array.isArray(files) || types.isProxy(files) ||
      ![Object.prototype,null].includes(Object.getPrototypeOf(files))) {
    throw new TypeError(`${label} must be a plain non-proxy object map`);
  }
  const descriptors=Object.getOwnPropertyDescriptors(files);
  const entries=[];
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor=descriptors[key];
    if (typeof key!=="string" || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} must contain only own enumerable data properties`);
    }
    entries.push([key,descriptor.value]);
  }
  return entries;
}

function ledgerConflict(message,{cause}={}) {
  const error=new Error(message,{cause});
  error.code="CONTROL_LEDGER_CONFLICT";
  return error;
}

function validateConfiguration(path,value) {
  if (path===CONTROL_PATHS.organization) return validateCoreDocument(value,"organization-config.v1");
  if (path.startsWith(`${CONTROL_PATHS.repositories}/`) && path.endsWith(".yaml")) {
    const repository=validateCoreDocument(value,"repository-config.v1");
    if (path!==repositoryPath(repository.repository)) {
      throw new TypeError("repository configuration path must match its exact canonical identity");
    }
    return repository;
  }
  throw new TypeError(`configuration path is not permitted: ${path}`);
}

function rawCompare(left,right) { return left===right ? 0 : left<right ? -1 : 1; }

function repositoryCollisionKey(identity) {
  return repositoryPath(identity).toLowerCase();
}

function exactShape(value,expected,label) {
  if (canonicalJson(value)!==canonicalJson(expected)) throw ledgerConflict(`${label} is not exact`);
}

function bootstrapProof({organization,lifecycle,release,intent,receipt}) {
  if (intent.command!=="init" || intent.authority===null || intent.source.repository!==organization.control_repository || intent.policy_revision!==organization.policy_revision) throw ledgerConflict("bootstrap intent must bind explicit authority, policy, and control repository");
  if (organization.repositories.length!==0) throw ledgerConflict("bootstrap organization must not register repositories");
  if (receipt.status!=="completed" || receipt.intent_id!==intent.intent_id || receipt.intent_sha256!==sha256Canonical(intent)) throw ledgerConflict("bootstrap receipt must be completed and bind the bootstrap intent");
  if (!lifecycle || !release || lifecycle.revision!==organization.policy_revision || release.revision!==organization.policy_revision) throw ledgerConflict("bootstrap policies must bind organization policy revision");
  const hashes=Object.freeze({organization:sha256Canonical(organization),lifecycle:sha256Canonical(lifecycle),release:sha256Canonical(release)});
  let canonical;
  try { canonical=createOperationIntent({intent_id:intent.intent_id,created_at:intent.created_at,command:intent.command,policy_revision:intent.policy_revision,source:intent.source,authority:intent.authority,operations:intent.operations.map(({operation_id,...operation}) => operation)}); } catch (error) { throw ledgerConflict("bootstrap operations cannot be canonically reconstructed",{cause:error}); }
  if (!equivalent(canonical.operations,intent.operations)) throw ledgerConflict("bootstrap operations are not in canonical order with canonical IDs");
  const byKind=new Map();
  for (const operation of intent.operations) {
    if (byKind.has(operation.payload?.kind)) throw ledgerConflict("bootstrap operation kinds must be unique");
    byKind.set(operation.payload?.kind,operation);
  }
  const required=["create-private-control-repository","verify-default-branch-protection","discover-project-fields","organization-config","lifecycle-policy","release-policy","first-control-transaction"];
  if (intent.operations.length!==required.length || [...byKind.keys()].sort(rawCompare).join("|")!==[...required].sort(rawCompare).join("|")) throw ledgerConflict("bootstrap operation set is not exact");
  const create=byKind.get("create-private-control-repository"); const discover=byKind.get("discover-project-fields");
  exactShape(create,{operation_id:create.operation_id,resource:"repository",action:"create",repository:organization.control_repository,expected_revision:null,payload:{kind:"create-private-control-repository",private:true,files:hashes}},"bootstrap repository creation");
  exactShape(byKind.get("verify-default-branch-protection"),{operation_id:byKind.get("verify-default-branch-protection").operation_id,resource:"repository",action:"update",repository:organization.control_repository,expected_revision:null,payload:{kind:"verify-default-branch-protection"}},"bootstrap branch protection verification");
  if (typeof discover.expected_revision!=="string" || !discover.expected_revision) throw ledgerConflict("bootstrap project discovery must bind an exact project revision");
  exactShape(discover,{operation_id:discover.operation_id,resource:"project",action:"update",repository:null,expected_revision:discover.expected_revision,payload:{kind:"discover-project-fields",project:organization.project}},"bootstrap project discovery");
  for (const [kind,hash] of [["organization-config",hashes.organization],["lifecycle-policy",hashes.lifecycle],["release-policy",hashes.release]]) {
    const operation=byKind.get(kind);
    exactShape(operation,{operation_id:operation.operation_id,resource:"repository",action:"commit",repository:organization.control_repository,expected_revision:null,payload:{kind,sha256:hash}},"bootstrap document commit");
  }
  const transaction=byKind.get("first-control-transaction");
  exactShape(transaction,{operation_id:transaction.operation_id,resource:"repository",action:"commit",repository:organization.control_repository,expected_revision:null,payload:{kind:"first-control-transaction",files:hashes}},"bootstrap transaction");
  const remote=[create,byKind.get("verify-default-branch-protection"),discover];
  const observed=new Map();
  for (const value of receipt.observed_revisions) {
    if (observed.has(value.operation_id)) throw ledgerConflict("bootstrap receipt observes an operation more than once");
    observed.set(value.operation_id,value);
  }
  if (observed.size!==remote.length || remote.some(operation => !observed.has(operation.operation_id) || observed.get(operation.operation_id).repository!==operation.repository || typeof observed.get(operation.operation_id).revision!=="string" || !observed.get(operation.operation_id).revision)) throw ledgerConflict("bootstrap receipt must observe every remote bootstrap operation exactly once with a revision");
  return Object.freeze({hashes,operations:byKind});
}

function assertReceiptCoverage(receipt,intent) {
  if (receipt.intent_id!==intent.intent_id || receipt.intent_sha256!==sha256Canonical(intent)) throw new Error("receipt intent binding does not match the persisted intent");
  const operations=new Map(intent.operations.map(operation => [operation.operation_id,operation]));
  const observedIds=new Set();
  for (const observed of receipt.observed_revisions) {
    const operation=operations.get(observed.operation_id);
    if (!operation || operation.repository!==observed.repository || observedIds.has(observed.operation_id)) {
      throw new Error(`receipt observed revision is incompatible with intent operation: ${observed.operation_id}`);
    }
    observedIds.add(observed.operation_id);
  }
  if (receipt.status==="completed" && (observedIds.size!==operations.size || intent.operations.some(operation => !observedIds.has(operation.operation_id)))) {
    throw new Error("completed receipt must observe every intent operation exactly once");
  }
}

function validatePersistedReceiptCoverage(receipt,intent) {
  try { assertReceiptCoverage(receipt,intent); } catch (error) {
    throw ledgerConflict("persisted receipt coverage is corrupt",{cause:error});
  }
}

function validatePersistedReceiptRecords(receipts,intents,{bootstrapReceipt=null}={}) {
  const byIntentId=new Map(intents.map(record => [record.document.intent_id,record.document]));
  const byReceiptId=new Map(receipts.map(record => [record.document.receipt_id,record.document]));
  const reservations=new Map();
  for (const record of intents) {
    const intent=record.document;
    if (intent.planned_receipt_id===undefined) continue;
    if (reservations.has(intent.planned_receipt_id)) {
      throw ledgerConflict(`planned receipt identity has multiple intent owners: ${intent.planned_receipt_id}`);
    }
    reservations.set(intent.planned_receipt_id,intent.intent_id);
    const receipt=byReceiptId.get(intent.planned_receipt_id);
    if (receipt && receipt.intent_id!==intent.intent_id) {
      throw ledgerConflict(`planned receipt identity was consumed by another intent: ${intent.planned_receipt_id}`);
    }
  }
  const receiptByIntentId=new Map();
  for (const record of receipts) {
    const intent=byIntentId.get(record.document.intent_id);
    if (!intent) throw ledgerConflict(`receipt intent is absent from the ledger: ${record.document.intent_id}`);
    if (receiptByIntentId.has(record.document.intent_id)) throw ledgerConflict(`receipt intent has multiple immutable receipts: ${record.document.intent_id}`);
    if (intent.planned_receipt_id!==undefined && intent.planned_receipt_id!==record.document.receipt_id) {
      throw ledgerConflict(`receipt does not use its persisted intent reservation: ${record.document.receipt_id}`);
    }
    receiptByIntentId.set(record.document.intent_id,record);
    if (record.document.receipt_id!==bootstrapReceipt?.receipt_id) validatePersistedReceiptCoverage(record.document,intent);
  }
}

export function createCoreControlStore({repository}) {
  const head=ownDataFunction(repository,"head");
  const readDocument=ownDataFunction(repository,"readDocument");
  const documentBlobAt=optionalOwnDataFunction(repository,"documentBlobAt");
  const listDocuments=ownDataFunction(repository,"listDocuments");
  const rootSnapshotAt=ownDataFunction(repository,"rootSnapshotAt");
  const commitFiles=ownDataFunction(repository,"commitFiles");

  async function readAt(path,revision) {
    return readDocument(path,{at:revision});
  }

  async function immutableDocumentIdentityAt(path,revision,document) {
    if (documentBlobAt===null) return `canonical:${canonicalJson(document)}`;
    const identity=await documentBlobAt(path,{at:revision});
    if (typeof identity!=="string" || !/^[a-f0-9]{40}$/u.test(identity)) {
      throw new TypeError(`repository.documentBlobAt returned an invalid blob identity: ${path}`);
    }
    return `git-blob:${identity}`;
  }

  async function listedDocuments(prefix,revision) {
    return closeDocumentPaths(
      await listDocuments(prefix,{at:revision}),
      `repository.${prefix} paths`,
    );
  }

  function documentsUnder(paths,prefix) {
    return Object.freeze(paths.filter(path => path.startsWith(`${prefix}/`)));
  }

  async function currentControlPathsAt(revision) {
    try {
      const groups=await Promise.all(CONTROL_ROOTS.map(async root =>
        closeDocumentPaths(await listDocuments(root,{at:revision}),`repository.${root} paths`)));
      return closeDocumentPaths(groups.flat().sort(rawCompare),"current control paths");
    } catch (error) {
      throw ledgerConflict("current control paths are malformed",{cause:error});
    }
  }

  async function rootBootstrapProofFrom(snapshot) {
    if (!hasControlMaterial(snapshot.paths)) return null;
    const root=snapshot.revision;
    const [organizationDocument,lifecycle,release,intents,receipts]=await Promise.all([
      readAt(CONTROL_PATHS.organization,root),
      readAt(`${CONTROL_PATHS.policies}/lifecycle.yaml`,root),
      readAt(`${CONTROL_PATHS.policies}/release.yaml`,root),
      resolveGlobalIdentities({revision:root,prefix:CONTROL_PATHS.intents,paths:documentsUnder(snapshot.paths,CONTROL_PATHS.intents),schemaId:"operation-intent.v1",label:"intent",idField:"intent_id",pathFor:intentPath,ledgerRead:true}),
      resolveGlobalIdentities({revision:root,prefix:CONTROL_PATHS.receipts,paths:documentsUnder(snapshot.paths,CONTROL_PATHS.receipts),schemaId:"operation-receipt.v1",label:"receipt",idField:"receipt_id",pathFor:receiptPath,ledgerRead:true}),
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
    const bootstrap=Object.freeze({
      root,
      organization:frozenCanonicalCopy(organization),
      lifecycle:frozenCanonicalCopy(lifecycle),
      release:frozenCanonicalCopy(release),
      intent:frozenCanonicalCopy(intent),
      receipt:frozenCanonicalCopy(receipt),
    });
    const [intentIdentity,receiptIdentity]=await Promise.all([
      immutableDocumentIdentityAt(intentPath(intent),root,intent),
      immutableDocumentIdentityAt(receiptPath(receipt),root,receipt),
    ]);
    return Object.freeze({bootstrap,intentIdentity,receiptIdentity});
  }

  async function loadCurrentBaselineAt(revision) {
    const [organizationDocument,lifecycleDocument,releaseDocument]=await Promise.all([
      readAt(CONTROL_PATHS.organization,revision),
      readAt(`${CONTROL_PATHS.policies}/lifecycle.yaml`,revision),
      readAt(`${CONTROL_PATHS.policies}/release.yaml`,revision),
    ]);
    if (organizationDocument===null || lifecycleDocument===null || releaseDocument===null) {
      throw ledgerConflict("verified control ledger is missing its current organization or policy baseline");
    }
    try {
      const organization=validateCoreDocument(organizationDocument,"organization-config.v1");
      if (lifecycleDocument===null || typeof lifecycleDocument!=="object" || Array.isArray(lifecycleDocument) ||
          releaseDocument===null || typeof releaseDocument!=="object" || Array.isArray(releaseDocument) ||
          lifecycleDocument.revision!==organization.policy_revision ||
          releaseDocument.revision!==organization.policy_revision) {
        throw new TypeError("current policies must bind the organization policy revision");
      }
      return frozenCanonicalCopy({
        organization,
        lifecycle:lifecycleDocument,
        release:releaseDocument,
      });
    } catch (error) {
      throw ledgerConflict("verified control ledger has a corrupt current baseline",{cause:error});
    }
  }

  async function loadCurrentRepositoriesAt(revision,currentPaths,organization) {
    const paths=documentsUnder(currentPaths,CONTROL_PATHS.repositories);
    const repositories=[];
    const identities=new Set();
    const collisionPaths=new Map();
    for (const path of paths) {
      if (!path.endsWith(".yaml")) throw ledgerConflict(`unexpected repository configuration path: ${path}`);
      const foldedPath=path.toLowerCase();
      if (collisionPaths.has(foldedPath)) throw ledgerConflict(`repository configuration path has a case-only collision: ${path}`);
      collisionPaths.set(foldedPath,path);
      const document=await readAt(path,revision);
      if (document===null) throw ledgerConflict(`listed repository configuration is absent: ${path}`);
      let repository;
      try { repository=validateConfiguration(path,document); }
      catch (error) { throw ledgerConflict(`repository configuration is corrupt: ${path}`,{cause:error}); }
      const collisionKey=repositoryCollisionKey(repository.repository);
      if (identities.has(collisionKey)) throw ledgerConflict(`repository configuration identity has a case-only collision: ${repository.repository}`);
      identities.add(collisionKey);
      repositories.push(repository);
    }
    repositories.sort((left,right) => rawCompare(left.repository,right.repository));
    const names=repositories.map(value => value.repository);
    if (canonicalJson(organization.repositories)!==canonicalJson(names)) {
      throw ledgerConflict("organization repository registry does not exactly match repository configuration namespace");
    }
    return frozenCanonicalCopy(repositories);
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
    let currentPaths; let intentRecords; let receiptRecords;
    try {
      currentPaths=await currentControlPathsAt(revision);
      [intentRecords,receiptRecords]=await Promise.all([
        resolveGlobalIdentities({revision,prefix:CONTROL_PATHS.intents,paths:documentsUnder(currentPaths,CONTROL_PATHS.intents),schemaId:"operation-intent.v1",label:"intent",idField:"intent_id",pathFor:intentPath,ledgerRead:true}),
        resolveGlobalIdentities({revision,prefix:CONTROL_PATHS.receipts,paths:documentsUnder(currentPaths,CONTROL_PATHS.receipts),schemaId:"operation-receipt.v1",label:"receipt",idField:"receipt_id",pathFor:receiptPath,ledgerRead:true}),
      ]);
    } catch (error) {
      throw error?.code==="CONTROL_LEDGER_CONFLICT" ? error : ledgerConflict("current control ledger is corrupt",{cause:error});
    }
    let rootProof;
    try { rootProof=await rootBootstrapProofFrom(snapshot); }
    catch (error) { throw error?.code==="CONTROL_LEDGER_CONFLICT" ? error : ledgerConflict("bootstrap root proof is corrupt",{cause:error}); }
    const bootstrap=rootProof?.bootstrap ?? null;
    if (bootstrap===null && hasControlMaterial(currentPaths)) {
      throw ledgerConflict("control material exists without an exact root bootstrap");
    }
    if (bootstrap!==null) {
      const persistedIntent=intentRecords.filter(record => record.document.intent_id===bootstrap.intent.intent_id);
      const persistedReceipt=receiptRecords.filter(record => record.document.receipt_id===bootstrap.receipt.receipt_id);
      try {
        const [intentIdentity,receiptIdentity]=await Promise.all([
          persistedIntent.length===1
            ? immutableDocumentIdentityAt(persistedIntent[0].path,revision,persistedIntent[0].document)
            : null,
          persistedReceipt.length===1
            ? immutableDocumentIdentityAt(persistedReceipt[0].path,revision,persistedReceipt[0].document)
            : null,
        ]);
        if (persistedIntent.length!==1 || persistedReceipt.length!==1 ||
            !equivalent(persistedIntent[0].document,bootstrap.intent) ||
            !equivalent(persistedReceipt[0].document,bootstrap.receipt) ||
            intentIdentity!==rootProof.intentIdentity || receiptIdentity!==rootProof.receiptIdentity) {
          throw ledgerConflict("immutable bootstrap records differ from the root transaction");
        }
      } catch (error) {
        throw error?.code==="CONTROL_LEDGER_CONFLICT"
          ? error
          : ledgerConflict("immutable bootstrap record identity is malformed",{cause:error});
      }
    }
    const currentBaseline=bootstrap===null ? null : await loadCurrentBaselineAt(revision);
    const currentRepositories=bootstrap===null
      ? Object.freeze([])
      : await loadCurrentRepositoriesAt(revision,currentPaths,currentBaseline.organization);
    validatePersistedReceiptRecords(receiptRecords,intentRecords,{bootstrapReceipt:bootstrap?.receipt});
    return Object.freeze({
      revision,
      classification:bootstrap===null ? "absent" : "verified",
      bootstrap,
      intentRecords:Object.freeze(intentRecords),
      receiptRecords:Object.freeze(receiptRecords),
      currentPaths,
      currentBaseline,
      currentRepositories,
    });
  }

  async function resolveGlobalIdentities({revision,prefix,paths=null,schemaId,label,idField,pathFor,ledgerRead=false}) {
    if (revision===null) return [];
    const records=[];
    const identities=new Map();
    const resolvedPaths=paths ?? await listedDocuments(prefix,revision);
    for (const path of resolvedPaths) {
      const document=await readAt(path,revision);
      if (document===null) {
        throw ledgerRead ? ledgerConflict(`listed ${label} is absent: ${path}`) : new Error(`listed ${label} is absent: ${path}`);
      }
      let valid;
      try { valid=validateCoreDocument(document,schemaId); } catch (error) {
        if (ledgerRead) throw ledgerConflict(`persisted ${label} is corrupt: ${path}`,{cause:error});
        throw error;
      }
      if (pathFor(valid)!==path) {
        throw ledgerRead ? ledgerConflict(`${label} identity does not match its path: ${path}`) : new Error(`${label} identity does not match its path: ${path}`);
      }
      const existing=identities.get(valid[idField]);
      if (existing) {
        throw ledgerRead ? ledgerConflict(`${label} identity is globally duplicated: ${valid[idField]}`) : new Error(`${label} identity is globally duplicated: ${valid[idField]}`);
      }
      const record=Object.freeze({path,document:frozenCanonicalCopy(valid)});
      identities.set(valid[idField],record);
      records.push(record);
    }
    return records;
  }

  async function loadOrganizationAt(validated) {
    if (validated.classification==="absent") return null;
    return validated.currentBaseline.organization;
  }

  async function loadRepositoryAt(identity,validated) {
    if (validated.classification==="absent") return null;
    return validated.currentRepositories.find(configuration => configuration.repository===identity) ?? null;
  }

  async function loadRegistryStateAt(validated) {
    const revision=validated.revision;
    if (validated.classification==="absent") return Object.freeze({revision,organization:null,repositories:Object.freeze([])});
    const organization=validated.currentBaseline.organization;
    return frozenCanonicalCopy({
      revision,
      organization,
      repositories:validated.currentRepositories,
    });
  }

  async function loadOrganization() {
    return loadOrganizationAt(await loadValidatedLedgerAt(await head()));
  }

  async function loadRepository(identity) {
    return loadRepositoryAt(identity,await loadValidatedLedgerAt(await head()));
  }

  async function listRepositories() {
    const validated=await loadValidatedLedgerAt(await head());
    return (await loadRegistryStateAt(validated)).repositories;
  }

  async function loadRegistryState() {
    return loadRegistryStateAt(await loadValidatedLedgerAt(await head()));
  }

  async function loadOperationState() {
    const validated=await loadValidatedLedgerAt(await head());
    return frozenCanonicalCopy({
      revision:validated.revision,
      intents:validated.intentRecords.map(record => record.document),
      receipts:validated.receiptRecords.map(record => record.document),
    });
  }

  async function loadReleaseProgramsAt(validated) {
    if (validated.classification==="absent") return Object.freeze([]);
    const paths=documentsUnder(validated.currentPaths,CONTROL_PATHS.programs).sort(rawCompare);
    const programs=[];
    const identities=new Set();
    try {
      for (const path of paths) {
        const match=/^programs\/(TOSS-OS-R[0-9]{4,})\/manifest\.yaml$/u.exec(path);
        if (!match) throw new TypeError(`unexpected release program manifest path: ${path}`);
        const document=await readAt(path,validated.revision);
        if (document===null) throw new TypeError(`listed release program manifest is absent: ${path}`);
        const program=validateCoreDocument(document,"release-program.v1");
        if (programPath(program.program_id)!==path || match[1]!==program.program_id || identities.has(program.program_id)) {
          throw new TypeError(`release program identity does not match its unique path: ${path}`);
        }
        identities.add(program.program_id);
        programs.push(program);
      }
      programs.sort((left,right) => rawCompare(left.program_id,right.program_id));
      assertRepositoryConcurrency(programs);
      return frozenCanonicalCopy(programs);
    } catch (error) {
      throw error?.code==="CONTROL_LEDGER_CONFLICT"
        ? error
        : ledgerConflict("release program manifest ledger is corrupt",{cause:error});
    }
  }

  async function loadReleasePlanningState() {
    const validated=await loadValidatedLedgerAt(await head());
    if (validated.classification==="absent") {
      return frozenCanonicalCopy({revision:validated.revision,organization:null,repositories:[],programs:[],intents:[],receipts:[]});
    }
    return frozenCanonicalCopy({
      revision:validated.revision,
      organization:validated.currentBaseline.organization,
      repositories:validated.currentRepositories,
      programs:await loadReleaseProgramsAt(validated),
      intents:validated.intentRecords.map(record => record.document),
      receipts:validated.receiptRecords.map(record => record.document),
    });
  }

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

  async function findCompletedRepositoryRegistration(identity) {
    const validated=await loadValidatedLedgerAt(await head());
    const state=await loadRegistryStateAt(validated);
    if (validated.classification==="absent") return null;
    const candidates=validated.intentRecords.filter(record => record.document.command==="repo.add" && record.document.operations.length===1 && record.document.operations[0].payload?.kind==="repository-registration" && record.document.operations[0].repository===identity);
    if (candidates.length===0) return null;
    if (candidates.length!==1) throw ledgerConflict(`repository registration intent is ambiguous: ${identity}`);
    const intent=candidates[0].document; const config=intent.operations[0].payload.repository_config;
    let valid;
    try { valid=validateCoreDocument(config,"repository-config.v1"); } catch (error) { throw ledgerConflict("repository registration intent has corrupt configuration",{cause:error}); }
    if (valid.repository!==identity) throw ledgerConflict("repository registration intent does not bind its identity");
    const receipt=findReceiptInLedger(intent,validated);
    if (receipt===null || receipt.status!=="completed") return null;
    return frozenCanonicalCopy({revision:state.revision,intent,receipt,configuration:valid});
  }

  async function loadOrganizationState() {
    const validated=await loadValidatedLedgerAt(await head());
    const revision=validated.revision;
    if (validated.classification==="absent") {
      return frozenCanonicalCopy({organization:null,repositories:[],policies:{},programs:[],receipts:[]});
    }
    const organization=await loadOrganizationAt(validated);
    const repositories=validated.currentRepositories;
    const {lifecycle,release}=validated.currentBaseline;
    const [programPaths]=await Promise.all([
      listedDocuments(CONTROL_PATHS.programs,revision),
    ]);
    const programs=await Promise.all([...programPaths].sort().map(async path => {
      if (!/^programs\/[A-Za-z0-9._-]+\/manifest\.yaml$/u.test(path)) {
        throw new Error(`unexpected program manifest path: ${path}`);
      }
      const document=await readAt(path,revision);
      if (document===null) throw new Error(`listed program manifest is absent: ${path}`);
      return document;
    }));
    const receipts=validated.receiptRecords.map(record => record.document);
    return frozenCanonicalCopy({
      organization,
      repositories,
      policies:{lifecycle,release},
      programs,
      receipts,
    });
  }

  async function loadBootstrapState() {
    const revision=await head();
    const validated=await loadValidatedLedgerAt(revision);
    if (validated.classification==="absent") return null;
    const bootstrap=validated.bootstrap;
    return Object.freeze({organization:bootstrap.organization,lifecycle:bootstrap.lifecycle,release:bootstrap.release,intent:bootstrap.intent,receipt:bootstrap.receipt,revision,root_revision:bootstrap.root});
  }

  async function commitGlobalImmutable({
    expectedHead,document,schemaId,label,prefix,idField,pathFor,beforeWrite,
  }) {
    const valid=validateCoreDocument(document,schemaId);
    const path=pathFor(valid);
    const current=await head();
    if (current!==expectedHead) {
      throw ledgerConflict(`control repository expected head conflict: expected ${String(expectedHead)}, found ${String(current)}`);
    }
    const matches=(await resolveGlobalIdentities({
      revision:current,prefix,schemaId,label,idField,pathFor,ledgerRead:true,
    })).filter(existing => existing.document[idField]===valid[idField]);
    if (matches.length===1) {
      const existing=matches[0];
      if (existing.path===path && equivalent(existing.document,valid)) {
        return Object.freeze({commit_sha:current});
      }
      throw ledgerConflict(`${label} identity is immutable and already has different content or path`);
    }
    if (beforeWrite) await beforeWrite(valid,current);
    return commitFiles({expectedHead,message:`core: record ${label} ${path}`,files:{[path]:valid}});
  }

  async function commitIntent({expectedHead,intent}) {
    const valid=validateCoreDocument(intent,"operation-intent.v1");
    return commitGlobalImmutable({
      expectedHead,
      document:valid,
      schemaId:"operation-intent.v1",
      label:"intent",
      prefix:CONTROL_PATHS.intents,
      idField:"intent_id",
      pathFor:intentPath,
      beforeWrite:async (candidate,revision) => {
        if (candidate.planned_receipt_id===undefined) return;
        const [intents,receipts]=await Promise.all([
          resolveGlobalIdentities({revision,prefix:CONTROL_PATHS.intents,
            schemaId:"operation-intent.v1",label:"intent",idField:"intent_id",
            pathFor:intentPath,ledgerRead:true}),
          resolveGlobalIdentities({revision,prefix:CONTROL_PATHS.receipts,
            schemaId:"operation-receipt.v1",label:"receipt",idField:"receipt_id",
            pathFor:receiptPath,ledgerRead:true}),
        ]);
        if (intents.some(record => record.document.planned_receipt_id===candidate.planned_receipt_id) ||
            receipts.some(record => record.document.receipt_id===candidate.planned_receipt_id)) {
          throw ledgerConflict(`planned receipt identity is already reserved: ${candidate.planned_receipt_id}`);
        }
      },
    });
  }

  async function assertReceiptBinding(receipt,revision) {
    if (revision===null) {
      throw new Error("receipt intent must already be persisted");
    }
    const intentRecords=await resolveGlobalIdentities({
      revision,
      prefix:CONTROL_PATHS.intents,
      schemaId:"operation-intent.v1",
      label:"intent",
      idField:"intent_id",
      pathFor:intentPath,
    });
    const matches=intentRecords.filter(record =>
      record.document.intent_id===receipt.intent_id).map(record => record.document);
    if (matches.length!==1) {
      throw new Error(`receipt intent must resolve to exactly one persisted intent: ${receipt.intent_id}`);
    }
    const intent=matches[0];
    if (intent.planned_receipt_id!==undefined && intent.planned_receipt_id!==receipt.receipt_id) {
      throw ledgerConflict(`receipt does not use its intent reservation: ${receipt.receipt_id}`);
    }
    if (intentRecords.some(record => record.document.intent_id!==intent.intent_id &&
        record.document.planned_receipt_id===receipt.receipt_id)) {
      throw ledgerConflict(`receipt identity is reserved by another intent: ${receipt.receipt_id}`);
    }
    assertReceiptCoverage(receipt,intent);
    const matchingReceipts=(await resolveGlobalIdentities({
      revision,
      prefix:CONTROL_PATHS.receipts,
      schemaId:"operation-receipt.v1",
      label:"receipt",
      idField:"receipt_id",
      pathFor:receiptPath,
    })).filter(record => record.document.intent_id===receipt.intent_id);
    if (matchingReceipts.length!==0) throw ledgerConflict(`receipt intent already has an immutable receipt: ${receipt.intent_id}`);
  }

  async function findIntent(intent) {
    const valid=validateCoreDocument(intent,"operation-intent.v1");
    const validated=await loadValidatedLedgerAt(await head());
    const existing=validated.intentRecords.find(record => record.document.intent_id===valid.intent_id);
    if (!existing) return null;
    if (!equivalent(existing.document,valid)) {
      if (valid.planned_receipt_id===undefined &&
          existing.document.planned_receipt_id!==undefined) {
        const {planned_receipt_id:_reservation,...legacyShape}=existing.document;
        if (equivalent(legacyShape,valid)) return existing.document;
      }
      throw ledgerConflict(`intent lookup conflicts with immutable content: ${valid.intent_id}`);
    }
    return existing.document;
  }

  async function findReceiptAt(intent,revision) {
    return findReceiptInLedger(intent,await loadValidatedLedgerAt(revision));
  }

  async function findReceipt(intent) {
    return findReceiptAt(intent,await head());
  }

  async function commitReceipt({expectedHead,receipt}) {
    const valid=validateCoreDocument(receipt,"operation-receipt.v1");
    return commitGlobalImmutable({
      expectedHead,
      document:valid,
      schemaId:"operation-receipt.v1",
      label:"receipt",
      prefix:CONTROL_PATHS.receipts,
      idField:"receipt_id",
      pathFor:receiptPath,
      beforeWrite:assertReceiptBinding,
    });
  }

  function nextReleaseRevision(value) {
    const match=/^REV-([0-9]{4,})$/u.exec(value);
    if (!match) throw new TypeError("release program expected revision must be canonical");
    const number=Number(match[1]);
    if (!Number.isSafeInteger(number) || number<1 || number===Number.MAX_SAFE_INTEGER) {
      throw new TypeError("release program revision cannot be incremented safely");
    }
    const next=String(number+1);
    return `REV-${next.padStart(Math.max(4,match[1].length),"0")}`;
  }

  async function releaseProgramMutation(operation,validated) {
    if (!operation || typeof operation!=="object" || Array.isArray(operation) || types.isProxy(operation) ||
        canonicalJson(Object.keys(operation).sort())!==canonicalJson([
          "action","expected_revision","operation_id","payload","repository","resource",
        ])) {
      throw new TypeError("release program operation must use the exact persisted operation shape");
    }
    const payload=operation.payload;
    if (!payload || typeof payload!=="object" || Array.isArray(payload) || types.isProxy(payload) ||
        canonicalJson(Object.keys(payload).sort())!==canonicalJson([
          "expected_program_revision","kind","program",
        ]) || payload.kind!=="release-program-manifest") {
      throw new TypeError("release program operation payload must use the exact closed shape");
    }
    const program=validateCoreDocument(payload.program,"release-program.v1");
    if (operation.resource!=="repository" || operation.action!=="commit" ||
        operation.repository!==validated.currentBaseline.organization.control_repository ||
        operation.expected_revision!==payload.expected_program_revision ||
        !(payload.expected_program_revision===null || typeof payload.expected_program_revision==="string")) {
      throw new TypeError("release program operation does not bind the control repository and logical revision");
    }
    const programs=await loadReleaseProgramsAt(validated);
    const current=programs.find(value => value.program_id===program.program_id) ?? null;
    if ((current?.revision ?? null)!==payload.expected_program_revision) {
      throw ledgerConflict(`release program expected revision conflict: ${program.program_id}`);
    }
    if (current===null) {
      if (program.revision!=="REV-0001") throw new TypeError("new release program must begin at REV-0001");
    } else if (program.revision===current.revision) {
      if (!equivalent(program,current)) {
        throw ledgerConflict(`release program same-revision content conflict: ${program.program_id}`);
      }
    } else if (program.revision!==nextReleaseRevision(current.revision) ||
        program.created_at!==current.created_at) {
      throw new TypeError("release program update must advance once and retain its creation time");
    }
    const resulting=[...programs.filter(value => value.program_id!==program.program_id),program]
      .sort((left,right) => rawCompare(left.program_id,right.program_id));
    assertRepositoryConcurrency(resulting);
    return Object.freeze({program:frozenCanonicalCopy(program),current,programs:Object.freeze(resulting)});
  }

  async function inspectReleaseProgramOperation(operation) {
    const validated=await loadValidatedLedgerAt(await head());
    if (validated.classification==="absent") throw ledgerConflict("release program mutation requires a bootstrapped control repository");
    const mutation=await releaseProgramMutation(operation,validated);
    return frozenCanonicalCopy({
      operation_id:operation.operation_id,
      repository:operation.repository,
      revision:mutation.current?.revision ?? null,
    });
  }

  async function commitReleaseProgramReceipt({expectedHead,operation,receipt}) {
    const current=await head();
    if (current!==expectedHead) {
      throw ledgerConflict(`control repository expected head conflict: expected ${String(expectedHead)}, found ${String(current)}`);
    }
    const validated=await loadValidatedLedgerAt(current);
    if (validated.classification==="absent") throw ledgerConflict("release program mutation requires a bootstrapped control repository");
    const mutation=await releaseProgramMutation(operation,validated);
    const validReceipt=validateCoreDocument(receipt,"operation-receipt.v1");
    if (validReceipt.status!=="completed") throw new TypeError("release program finalization requires a completed receipt");
    if (validated.receiptRecords.some(record => record.document.receipt_id===validReceipt.receipt_id)) {
      throw ledgerConflict(`receipt identity is immutable and already exists: ${validReceipt.receipt_id}`);
    }
    await assertReceiptBinding(validReceipt,current);
    const persistedIntents=validated.intentRecords.filter(record => record.document.intent_id===validReceipt.intent_id);
    const persistedOperation=persistedIntents[0]?.document.operations.find(value => value.operation_id===operation.operation_id);
    if (persistedIntents.length!==1 || !persistedOperation || !equivalent(persistedOperation,operation)) {
      throw ledgerConflict("release program operation does not equal its persisted intent operation");
    }
    const observations=validReceipt.observed_revisions.filter(value => value.operation_id===operation.operation_id);
    if (observations.length!==1 || observations[0].repository!==operation.repository ||
        observations[0].revision!==mutation.program.revision) {
      throw new TypeError("release program receipt must observe the exact logical program revision");
    }
    return commitFiles({
      expectedHead:current,
      message:`core: record release program ${mutation.program.program_id}`,
      files:{
        [programPath(mutation.program.program_id)]:mutation.program,
        [receiptPath(validReceipt)]:validReceipt,
      },
    });
  }

  async function commitBootstrap({expectedHead,files}) {
    if (expectedHead!==null) throw new TypeError("bootstrap is permitted only for an unborn control repository");
    const current=await head();
    if (current!==null) throw ledgerConflict("bootstrap is permitted only for an unborn control repository");
    const entries=closeFileEntries(files,"bootstrap files");
    const organizationEntry=entries.find(([path]) => path===CONTROL_PATHS.organization);
    const lifecycleEntry=entries.find(([path]) => path===`${CONTROL_PATHS.policies}/lifecycle.yaml`);
    const releaseEntry=entries.find(([path]) => path===`${CONTROL_PATHS.policies}/release.yaml`);
    const intentEntries=entries.filter(([path]) => path.startsWith(`${CONTROL_PATHS.intents}/`) && path.endsWith(".json"));
    const receiptEntries=entries.filter(([path]) => path.startsWith(`${CONTROL_PATHS.receipts}/`) && path.endsWith(".json"));
    if (!organizationEntry || !lifecycleEntry || !releaseEntry || intentEntries.length!==1 || receiptEntries.length!==1 || entries.length!==5) throw new TypeError("bootstrap must contain exactly organization, both policies, one intent, and one receipt");
    const organization=validateCoreDocument(organizationEntry[1],"organization-config.v1");
    if (organization.repositories.length!==0) throw new TypeError("bootstrap organization must not register repositories");
    canonicalJson(lifecycleEntry[1]); canonicalJson(releaseEntry[1]);
    const intent=validateCoreDocument(intentEntries[0][1],"operation-intent.v1");
    const receipt=validateCoreDocument(receiptEntries[0][1],"operation-receipt.v1");
    if (intentPath(intent)!==intentEntries[0][0] || receiptPath(receipt)!==receiptEntries[0][0]) throw new TypeError("bootstrap intent and receipt must use canonical bootstrap identities");
    try { bootstrapProof({organization,lifecycle:lifecycleEntry[1],release:releaseEntry[1],intent,receipt}); } catch (error) { throw new TypeError("bootstrap proof is not exact",{cause:error}); }
    return commitFiles({expectedHead:null,message:"core: bootstrap control repository",files});
  }

  async function commitConfiguration({expectedHead,files}) {
    const entries=closeFileEntries(files,"configuration files");
    const current=await loadRegistryState();
    if (current.revision!==expectedHead) throw ledgerConflict(`control repository expected head conflict: expected ${String(expectedHead)}, found ${String(current.revision)}`);
    const normalized={};
    const normalizedPaths=new Map();
    for (const [path,value] of entries) {
      const foldedPath=path.toLowerCase();
      if (normalizedPaths.has(foldedPath)) throw ledgerConflict(`configuration files contain a case-only path collision: ${path}`);
      normalizedPaths.set(foldedPath,path);
      normalized[path]=validateConfiguration(path,value);
    }
    if (!Object.hasOwn(normalized,CONTROL_PATHS.organization)) throw new TypeError("configuration commit must include organization configuration");
    const resulting=new Map(current.repositories.map(value => [value.repository,value]));
    const repositoryIdentities=new Map(current.repositories.map(value => [repositoryCollisionKey(value.repository),value.repository]));
    for (const [path,value] of Object.entries(normalized)) if (path!==CONTROL_PATHS.organization) {
      const collisionKey=repositoryCollisionKey(value.repository);
      const existingIdentity=repositoryIdentities.get(collisionKey);
      if (existingIdentity!==undefined && existingIdentity!==value.repository) {
        throw ledgerConflict(`repository identity has a case-only collision: ${value.repository}`);
      }
      repositoryIdentities.set(collisionKey,value.repository);
      resulting.set(value.repository,value);
    }
    const names=[...resulting.keys()].sort(rawCompare);
    if (canonicalJson(normalized[CONTROL_PATHS.organization].repositories)!==canonicalJson(names)) throw new TypeError("organization repository registry must exactly equal the resulting repository configuration namespace");
    return commitFiles({expectedHead,message:"core: update control configuration",files:normalized});
  }

  return Object.freeze({
    loadOrganization,
    loadOrganizationState,
    loadBootstrapState,
    loadRepository,
    listRepositories,
    loadRegistryState,
    loadOperationState,
    loadReleasePlanningState,
    findCompletedRepositoryRegistration,
    commitIntent,
    commitReceipt,
    inspectReleaseProgramOperation,
    commitReleaseProgramReceipt,
    commitBootstrap,
    commitConfiguration,
    head,
    findIntent,
    findReceipt,
  });
}
