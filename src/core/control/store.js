import {types} from "node:util";

import {canonicalJson,sha256Canonical} from "../../contracts/acp.js";
import {validateCoreDocument} from "../contracts.js";

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
  return `${encodeURIComponent(identity.toLowerCase())}.yaml`;
}

export function repositoryPath(identity) {
  return `${CONTROL_PATHS.repositories}/${repositoryFilename(identity)}`;
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

function equivalent(left,right) {
  return canonicalJson(left)===canonicalJson(right);
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

function bootstrapProof({organization,lifecycle,release,intent,receipt}) {
  if (intent.command!=="init" || intent.authority===null || intent.source.repository!==organization.control_repository) throw ledgerConflict("bootstrap intent must bind explicit authority and control repository");
  if (receipt.status!=="completed" || receipt.intent_id!==intent.intent_id || receipt.intent_sha256!==sha256Canonical(intent)) throw ledgerConflict("bootstrap receipt must be completed and bind the bootstrap intent");
  if (!lifecycle || !release || lifecycle.revision!==organization.policy_revision || release.revision!==organization.policy_revision) throw ledgerConflict("bootstrap policies must bind organization policy revision");
  const hashes=Object.freeze({organization:sha256Canonical(organization),lifecycle:sha256Canonical(lifecycle),release:sha256Canonical(release)});
  const byKind=new Map();
  for (const operation of intent.operations) {
    if (byKind.has(operation.payload?.kind)) throw ledgerConflict("bootstrap operation kinds must be unique");
    byKind.set(operation.payload?.kind,operation);
  }
  const required=["create-private-control-repository","verify-default-branch-protection","discover-project-fields","organization-config","lifecycle-policy","release-policy","first-control-transaction"];
  if (intent.operations.length!==required.length || [...byKind.keys()].sort(rawCompare).join("|")!==[...required].sort(rawCompare).join("|")) throw ledgerConflict("bootstrap operation set is not exact");
  const create=byKind.get("create-private-control-repository"); const discover=byKind.get("discover-project-fields");
  if (create.repository!==organization.control_repository || create.action!=="create" || create.payload.private!==true || !equivalent(create.payload.files,hashes) ||
      discover.repository!==null || discover.action!=="update" || !equivalent(discover.payload.project,organization.project)) throw ledgerConflict("bootstrap operation bindings are invalid");
  for (const [kind,hash] of [["organization-config",hashes.organization],["lifecycle-policy",hashes.lifecycle],["release-policy",hashes.release]]) {
    const operation=byKind.get(kind);
    if (operation.repository!==organization.control_repository || operation.action!=="commit" || operation.payload.sha256!==hash) throw ledgerConflict("bootstrap document digest is not authorized");
  }
  const transaction=byKind.get("first-control-transaction");
  if (transaction.repository!==organization.control_repository || transaction.action!=="commit" || !equivalent(transaction.payload.files,hashes)) throw ledgerConflict("bootstrap transaction digest is not authorized");
  const remote=[create,byKind.get("verify-default-branch-protection"),discover];
  const observed=new Map();
  for (const value of receipt.observed_revisions) {
    if (observed.has(value.operation_id)) throw ledgerConflict("bootstrap receipt observes an operation more than once");
    observed.set(value.operation_id,value);
  }
  if (observed.size!==remote.length || remote.some(operation => !observed.has(operation.operation_id) || observed.get(operation.operation_id).repository!==operation.repository)) throw ledgerConflict("bootstrap receipt must observe every remote bootstrap operation exactly once");
  return Object.freeze({hashes,operations:byKind});
}

export function createCoreControlStore({repository}) {
  const head=ownDataFunction(repository,"head");
  const readDocument=ownDataFunction(repository,"readDocument");
  const listDocuments=ownDataFunction(repository,"listDocuments");
  const commitFiles=ownDataFunction(repository,"commitFiles");

  async function readAt(path,revision) {
    return readDocument(path,{at:revision});
  }

  async function readRepositoryAt(identity,revision) {
    const document=await readAt(repositoryPath(identity),revision);
    if (document===null) throw new Error(`registered repository configuration is missing: ${identity}`);
    const repository=validateCoreDocument(document,"repository-config.v1");
    if (repository.repository!==identity) {
      throw new Error(`repository configuration identity does not match its path: ${identity}`);
    }
    return repository;
  }

  async function listedDocuments(prefix,revision) {
    const paths=await listDocuments(prefix,{at:revision});
    if (!Array.isArray(paths)) throw new TypeError("repository.listDocuments must return an array");
    return paths;
  }

  async function resolveGlobalIdentities({revision,prefix,schemaId,label,idField,pathFor,ledgerRead=false}) {
    if (revision===null) return [];
    const records=[];
    const identities=new Map();
    const paths=[...await listedDocuments(prefix,revision)].sort();
    for (const path of paths) {
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
      const record=Object.freeze({path,document:valid});
      identities.set(valid[idField],record);
      records.push(record);
    }
    return records;
  }

  async function loadOrganization() {
    const revision=await head();
    if (revision===null) return null;
    const document=await readAt(CONTROL_PATHS.organization,revision);
    return document===null ? null : validateCoreDocument(document,"organization-config.v1");
  }

  async function loadRepository(identity) {
    const revision=await head();
    if (revision===null) return null;
    const document=await readAt(repositoryPath(identity),revision);
    if (document===null) return null;
    const repository=validateCoreDocument(document,"repository-config.v1");
    if (repository.repository!==identity) {
      throw new Error(`repository configuration identity does not match its path: ${identity}`);
    }
    return repository;
  }

  async function listRepositories() {
    return (await loadRegistryState()).repositories;
  }

  async function loadRegistryState() {
    const revision=await head();
    if (revision===null) return Object.freeze({revision:null,organization:null,repositories:Object.freeze([])});
    const organizationDocument=await readAt(CONTROL_PATHS.organization,revision);
    if (organizationDocument===null) return Object.freeze({revision,organization:null,repositories:Object.freeze([])});
    const organization=validateCoreDocument(organizationDocument,"organization-config.v1");
    const paths=[...await listedDocuments(CONTROL_PATHS.repositories,revision)].sort(rawCompare);
    const repositories=[]; const identities=new Set();
    for (const path of paths) {
      if (!path.startsWith(`${CONTROL_PATHS.repositories}/`) || !path.endsWith(".yaml")) throw ledgerConflict(`unexpected repository configuration path: ${path}`);
      const document=await readAt(path,revision);
      if (document===null) throw ledgerConflict(`listed repository configuration is absent: ${path}`);
      const repository=validateConfiguration(path,document);
      if (identities.has(repository.repository)) throw ledgerConflict(`repository configuration identity is duplicated: ${repository.repository}`);
      identities.add(repository.repository); repositories.push(repository);
    }
    const names=repositories.map(value => value.repository).sort(rawCompare);
    if (canonicalJson(organization.repositories)!==canonicalJson(names)) throw ledgerConflict("organization repository registry does not exactly match repository configuration namespace");
    return Object.freeze({revision,organization,repositories:Object.freeze(repositories.sort((left,right) => rawCompare(left.repository,right.repository)))});
  }

  async function findCompletedRepositoryRegistration(identity) {
    const state=await loadRegistryState();
    if (state.revision===null) return null;
    const intents=await resolveGlobalIdentities({revision:state.revision,prefix:CONTROL_PATHS.intents,schemaId:"operation-intent.v1",label:"intent",idField:"intent_id",pathFor:intentPath,ledgerRead:true});
    const candidates=intents.filter(record => record.document.command==="repo.add" && record.document.operations.length===1 && record.document.operations[0].payload?.kind==="repository-registration" && record.document.operations[0].repository===identity);
    if (candidates.length===0) return null;
    if (candidates.length!==1) throw ledgerConflict(`repository registration intent is ambiguous: ${identity}`);
    const intent=candidates[0].document; const config=intent.operations[0].payload.repository_config;
    let valid;
    try { valid=validateCoreDocument(config,"repository-config.v1"); } catch (error) { throw ledgerConflict("repository registration intent has corrupt configuration",{cause:error}); }
    if (valid.repository!==identity) throw ledgerConflict("repository registration intent does not bind its identity");
    const receipt=await findReceipt(intent);
    if (receipt===null || receipt.status!=="completed") return null;
    return Object.freeze({revision:state.revision,intent,receipt,configuration:valid});
  }

  async function loadOrganizationState() {
    const revision=await head();
    if (revision===null) {
      return Object.freeze({organization:null,repositories:[],policies:{},programs:[],receipts:[]});
    }
    const organizationDocument=await readAt(CONTROL_PATHS.organization,revision);
    const organization=organizationDocument===null
      ? null
      : validateCoreDocument(organizationDocument,"organization-config.v1");
    const repositories=organization===null ? [] : await Promise.all(
      organization.repositories.map(identity => readRepositoryAt(identity,revision)),
    );
    const [lifecycle,release]=await Promise.all([
      readAt(`${CONTROL_PATHS.policies}/lifecycle.yaml`,revision),
      readAt(`${CONTROL_PATHS.policies}/release.yaml`,revision),
    ]);
    const [programPaths,receiptRecords]=await Promise.all([
      listedDocuments(CONTROL_PATHS.programs,revision),
      resolveGlobalIdentities({
        revision,
        prefix:CONTROL_PATHS.receipts,
        schemaId:"operation-receipt.v1",
        label:"receipt",
        idField:"receipt_id",
        pathFor:receiptPath,
      }),
    ]);
    const programs=await Promise.all([...programPaths].sort().map(async path => {
      if (!/^programs\/[A-Za-z0-9._-]+\/manifest\.yaml$/u.test(path)) {
        throw new Error(`unexpected program manifest path: ${path}`);
      }
      const document=await readAt(path,revision);
      if (document===null) throw new Error(`listed program manifest is absent: ${path}`);
      return document;
    }));
    const receipts=receiptRecords.map(record => record.document);
    return Object.freeze({
      organization,
      repositories:Object.freeze(repositories),
      policies:Object.freeze({lifecycle,release}),
      programs:Object.freeze(programs),
      receipts:Object.freeze(receipts),
    });
  }

  async function loadBootstrapState() {
    const revision=await head();
    if (revision===null) return null;
    const organizationDocument=await readAt(CONTROL_PATHS.organization,revision);
    if (organizationDocument===null) return null;
    const organization=validateCoreDocument(organizationDocument,"organization-config.v1");
    const [lifecycle,release]=await Promise.all([readAt(`${CONTROL_PATHS.policies}/lifecycle.yaml`,revision),readAt(`${CONTROL_PATHS.policies}/release.yaml`,revision)]);
    const intents=await resolveGlobalIdentities({revision,prefix:CONTROL_PATHS.intents,schemaId:"operation-intent.v1",label:"intent",idField:"intent_id",pathFor:intentPath,ledgerRead:true});
    const bootstrapIntents=intents.filter(record => record.document.command==="init");
    if (bootstrapIntents.length!==1) throw ledgerConflict("control repository must contain exactly one bootstrap intent");
    const intent=bootstrapIntents[0].document;
    const receipts=await resolveGlobalIdentities({revision,prefix:CONTROL_PATHS.receipts,schemaId:"operation-receipt.v1",label:"receipt",idField:"receipt_id",pathFor:receiptPath,ledgerRead:true});
    const matching=receipts.filter(record => record.document.intent_id===intent.intent_id && record.document.intent_sha256===sha256Canonical(intent));
    if (matching.length!==1) throw ledgerConflict("bootstrap intent must have exactly one matching receipt");
    bootstrapProof({organization,lifecycle,release,intent,receipt:matching[0].document});
    return Object.freeze({organization,lifecycle,release,intent,receipt:matching[0].document,revision});
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
    });
  }

  async function assertReceiptBinding(receipt,revision) {
    if (revision===null) {
      throw new Error("receipt intent must already be persisted");
    }
    const matches=(await resolveGlobalIdentities({
      revision,
      prefix:CONTROL_PATHS.intents,
      schemaId:"operation-intent.v1",
      label:"intent",
      idField:"intent_id",
      pathFor:intentPath,
    })).filter(record => record.document.intent_id===receipt.intent_id).map(record => record.document);
    if (matches.length!==1) {
      throw new Error(`receipt intent must resolve to exactly one persisted intent: ${receipt.intent_id}`);
    }
    const intent=matches[0];
    if (sha256Canonical(intent)!==receipt.intent_sha256) {
      throw new Error(`receipt intent hash does not match persisted intent: ${receipt.intent_id}`);
    }
    const operations=new Map(intent.operations.map(operation => [operation.operation_id,operation]));
    for (const observed of receipt.observed_revisions) {
      const operation=operations.get(observed.operation_id);
      if (!operation || operation.repository!==observed.repository) {
        throw new Error(`receipt observed revision is incompatible with intent operation: ${observed.operation_id}`);
      }
    }
  }

  async function findIntent(intent) {
    const valid=validateCoreDocument(intent,"operation-intent.v1");
    const revision=await head();
    if (revision===null) return null;
    const records=await resolveGlobalIdentities({
      revision,
      prefix:CONTROL_PATHS.intents,
      schemaId:"operation-intent.v1",
      label:"intent",
      idField:"intent_id",
      pathFor:intentPath,
      ledgerRead:true,
    });
    const existing=records.find(record => record.document.intent_id===valid.intent_id);
    if (!existing) return null;
    if (!equivalent(existing.document,valid)) {
      throw ledgerConflict(`intent lookup conflicts with immutable content: ${valid.intent_id}`);
    }
    return existing.document;
  }

  async function findReceipt(intent) {
    const valid=validateCoreDocument(intent,"operation-intent.v1");
    const revision=await head();
    if (revision===null) return null;
    const matches=(await resolveGlobalIdentities({
      revision,
      prefix:CONTROL_PATHS.receipts,
      schemaId:"operation-receipt.v1",
      label:"receipt",
      idField:"receipt_id",
      pathFor:receiptPath,
      ledgerRead:true,
    })).filter(record => record.document.intent_id===valid.intent_id);
    if (matches.length===0) return null;
    if (matches.length!==1 || matches[0].document.intent_sha256!==sha256Canonical(valid)) {
      throw ledgerConflict(`receipt lookup is ambiguous or conflicts with intent: ${valid.intent_id}`);
    }
    return matches[0].document;
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

  async function commitBootstrap({expectedHead,files}) {
    if (expectedHead!==null) throw new TypeError("bootstrap is permitted only for an unborn control repository");
    const current=await head();
    if (current!==null) throw ledgerConflict("bootstrap is permitted only for an unborn control repository");
    if (files===null || typeof files!=="object" || Array.isArray(files) || types.isProxy(files)) throw new TypeError("bootstrap files must be a non-proxy object map");
    const entries=Object.entries(files);
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
    if (files===null || typeof files!=="object" || Array.isArray(files) || types.isProxy(files)) {
      throw new TypeError("configuration files must be a non-proxy object map");
    }
    const current=await loadRegistryState();
    if (current.revision!==expectedHead) throw ledgerConflict(`control repository expected head conflict: expected ${String(expectedHead)}, found ${String(current.revision)}`);
    const normalized={};
    for (const [path,value] of Object.entries(files)) normalized[path]=validateConfiguration(path,value);
    if (!Object.hasOwn(normalized,CONTROL_PATHS.organization)) throw new TypeError("configuration commit must include organization configuration");
    const resulting=new Map(current.repositories.map(value => [value.repository,value]));
    for (const [path,value] of Object.entries(normalized)) if (path!==CONTROL_PATHS.organization) resulting.set(value.repository,value);
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
    findCompletedRepositoryRegistration,
    commitIntent,
    commitReceipt,
    commitBootstrap,
    commitConfiguration,
    head,
    findIntent,
    findReceipt,
  });
}
