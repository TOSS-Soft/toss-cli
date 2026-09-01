import {types} from "node:util";

import {canonicalJson} from "../../contracts/acp.js";
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
    return Object.freeze({
      organization,
      repositories:Object.freeze(repositories),
      policies:Object.freeze({lifecycle,release}),
      programs:Object.freeze([]),
      receipts:Object.freeze([]),
    });
  }

  async function commitImmutable({expectedHead,document,path,schemaId,label}) {
    const valid=validateCoreDocument(document,schemaId);
    const current=await head();
    if (current!==expectedHead) {
      throw new Error(`control repository expected head conflict: expected ${String(expectedHead)}, found ${String(current)}`);
    }
    const existing=current===null ? null : await readAt(path,current);
    if (existing!==null) {
      if (equivalent(existing,valid)) return Object.freeze({commit_sha:current});
      throw new Error(`${label} identity is immutable and already has different content`);
    }
    return commitFiles({expectedHead,message:`core: record ${label} ${path}`,files:{[path]:valid}});
  }

  async function commitIntent({expectedHead,intent}) {
    const valid=validateCoreDocument(intent,"operation-intent.v1");
    return commitImmutable({expectedHead,document:valid,path:intentPath(valid),schemaId:"operation-intent.v1",label:"intent"});
  }

  async function findIntent(intent) {
    const valid=validateCoreDocument(intent,"operation-intent.v1");
    const revision=await head();
    if (revision===null) return null;
    const existing=await readAt(intentPath(valid),revision);
    if (existing===null) return null;
    const exact=validateCoreDocument(existing,"operation-intent.v1");
    return equivalent(exact,valid) ? exact : null;
  }

  async function commitReceipt({expectedHead,receipt}) {
    const valid=validateCoreDocument(receipt,"operation-receipt.v1");
    return commitImmutable({expectedHead,document:valid,path:receiptPath(valid),schemaId:"operation-receipt.v1",label:"receipt"});
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
    findIntent,
  });
}
