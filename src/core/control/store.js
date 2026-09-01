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
  return value;
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
    const revision=await head();
    if (revision===null) return [];
    const organizationDocument=await readAt(CONTROL_PATHS.organization,revision);
    if (organizationDocument===null) return [];
    const organization=validateCoreDocument(organizationDocument,"organization-config.v1");
    return Promise.all(organization.repositories.map(identity => readRepositoryAt(identity,revision)));
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

  async function commitConfiguration({expectedHead,files}) {
    if (files===null || typeof files!=="object" || Array.isArray(files) || types.isProxy(files)) {
      throw new TypeError("configuration files must be a non-proxy object map");
    }
    const normalized={};
    for (const [path,value] of Object.entries(files)) normalized[path]=validateConfiguration(path,value);
    return commitFiles({expectedHead,message:"core: update control configuration",files:normalized});
  }

  return Object.freeze({
    loadOrganization,
    loadOrganizationState,
    loadRepository,
    listRepositories,
    commitIntent,
    commitReceipt,
    commitConfiguration,
    head,
    findIntent,
    findReceipt,
  });
}
