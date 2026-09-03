import {createPublicKey,verify as verifyDetached} from "node:crypto";
import {types} from "node:util";

import {canonicalJson,sha256Canonical} from "../contracts/acp.js";
import {compareCanonicalText} from "./canonical-order.js";
import {validateCoreDocument} from "./contracts.js";
import {CoreBlockedError,CoreValidationError} from "./errors.js";

function validation(message) { throw new CoreValidationError(message); }
function blocked(message) { throw new CoreBlockedError(message); }

function clone(value,path="$",ancestors=new Set()) {
  if (value===null || ["string","number","boolean"].includes(typeof value)) return value;
  if (typeof value!=="object" || types.isProxy(value) || ancestors.has(value)) validation(`Authority ${path} must be a closed non-proxy JSON value`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value)!==Array.prototype || Object.getOwnPropertySymbols(value).length!==0 || Object.getOwnPropertyNames(value).length!==value.length+1) validation(`Authority ${path} must be a dense array`);
      return Object.freeze(value.map((_,index) => {
        const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) validation(`Authority ${path} has an accessor`);
        return clone(descriptor.value,`${path}[${index}]`,ancestors);
      }));
    }
    if (![Object.prototype,null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length!==0) validation(`Authority ${path} must be a plain object`);
    const output=Object.create(null);
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) validation(`Authority ${path}.${key} has an accessor or hidden field`);
      output[key]=clone(descriptor.value,`${path}.${key}`,ancestors);
    }
    return Object.freeze(output);
  } finally { ancestors.delete(value); }
}

function exact(value,keys,label) {
  if (!value || typeof value!=="object" || Array.isArray(value) || canonicalJson(Object.keys(value).sort())!==canonicalJson([...keys].sort())) validation(`${label} must have an exact closed shape`);
}

function sortedUnique(values,label) {
  if (!Array.isArray(values) || values.some(value => typeof value!=="string") || values.some((value,index) => index>0 && values[index-1]>=value)) blocked(`${label} must be sorted, unique, and unambiguous`);
}

function sortedRevisions(values,label) {
  if (!Array.isArray(values) || values.length===0) blocked(`${label} must be nonempty`);
  let previous;
  const repositories=new Set();
  for (const value of values) {
    const targeted=Object.hasOwn(value,"target");
    exact(value,targeted ? ["target","repository","revision"] : ["repository","revision"],label);
    if (!(value.repository===null || typeof value.repository==="string") || !(value.revision===null || typeof value.revision==="string")) blocked(`${label} is malformed`);
    if (targeted && (typeof value.target!=="string" || !/\S/u.test(value.target))) blocked(`${label} target is malformed`);
    const identity=targeted ? `target:${value.target}` : `repository:${String(value.repository)}`;
    if (repositories.has(identity)) blocked(`${label} must not repeat a target`);
    repositories.add(identity);
    const encoded=canonicalJson(value);
    if (previous!==undefined && compareCanonicalText(previous,encoded)>=0) blocked(`${label} must be sorted, unique, and unambiguous`);
    previous=encoded;
  }
}

function exactSame(left,right,label) {
  if (canonicalJson(left)!==canonicalJson(right)) blocked(`Authority ${label} does not bind the requested operation`);
}

function keyFromPem(value) {
  if (typeof value!=="string" || value.length===0 || value.includes("\r")) validation("Trusted authority public key is not canonical PEM");
  let key;
  try { key=createPublicKey(value.endsWith("\n") ? value : `${value}\n`); } catch { validation("Trusted authority public key is invalid"); }
  const canonical=key.export({format:"pem",type:"spki"}).toString();
  if (key.asymmetricKeyType!=="ed25519" || canonical!==(value.endsWith("\n") ? value : `${value}\n`)) validation("Trusted authority public key must be canonical Ed25519 SPKI");
  return key;
}

function trustedKey(registry,record) {
  const value=clone(registry,"registry");
  exact(value,["keys"],"trusted authority registry");
  if (!Array.isArray(value.keys) || value.keys.length===0) blocked("Authority requires an independent trusted registry");
  const keys=new Map();
  for (const entry of value.keys) {
    exact(entry,["key_id","actor","public_key"],"trusted authority key");
    if (typeof entry.key_id!=="string" || !/\S/u.test(entry.key_id) || typeof entry.actor!=="string" || !/\S/u.test(entry.actor) || keys.has(entry.key_id)) validation("Trusted authority registry contains an invalid or duplicate key");
    keys.set(entry.key_id,Object.freeze({actor:entry.actor,key:keyFromPem(entry.public_key)}));
  }
  const key=keys.get(record.signature.key_id);
  if (!key || key.actor!==record.actor) blocked("Authority actor/key binding is not trusted");
  return key;
}

export function authoritySigningPayload(record) {
  const value=clone(record);
  const {signature,...unsigned}=value;
  void signature;
  return Object.freeze(unsigned);
}

export function verifyAuthority(record,binding,registry) {
  const value=clone(record);
  validateCoreDocument(value,"authority-record.v1");
  const target=clone(binding,"binding");
  const bindingKeys=Object.keys(target).sort();
  const permitted=[
    ["command","targets","expected_revisions","policy_revision","now","implementation_actor"],
    ["command","targets","expected_revisions","policy_revision","now","request_actor"],
    ["command","targets","expected_revisions","policy_revision","now","implementation_actor","request_actor"],
  ];
  if (!permitted.some(keys => canonicalJson(bindingKeys)===canonicalJson([...keys].sort()))) validation("authority binding must use an exact closed shape");
  sortedUnique(value.targets,"Authority targets");
  sortedUnique(target.targets,"Requested authority targets");
  sortedRevisions(value.expected_revisions,"Authority expected revisions");
  sortedRevisions(target.expected_revisions,"Requested authority expected revisions");
  if (typeof target.now!=="string" || Number.isNaN(Date.parse(target.now))) validation("Authority binding current time is invalid");
  const actors=[target.implementation_actor,target.request_actor].filter(value => value!==undefined);
  if (actors.some(actor => typeof actor!=="string" || !/\S/u.test(actor))) validation("Authority binding actor is invalid");
  if (actors.some(actor => value.actor===actor)) blocked("Authority actor must be independent from the implementation actor");
  exactSame(value.command,target.command,"command");
  exactSame(value.targets,target.targets,"targets");
  exactSame(value.expected_revisions,target.expected_revisions,"expected revisions");
  exactSame(value.policy_revision,target.policy_revision,"policy revision");
  const issued=Date.parse(value.issued_at); const expires=Date.parse(value.expires_at); const now=Date.parse(target.now);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued>=expires || now<issued || now>=expires) blocked("Authority is not currently valid");
  const signature=value.signature?.value;
  if (typeof signature!=="string" || !/^[A-Za-z0-9+/]{86}==$/u.test(signature) || Buffer.from(signature,"base64").length!==64 || Buffer.from(signature,"base64").toString("base64")!==signature) validation("Authority signature is malformed");
  const trusted=trustedKey(registry,value);
  let valid=false;
  try { valid=verifyDetached(null,Buffer.from(canonicalJson(authoritySigningPayload(value)),"utf8"),trusted.key,Buffer.from(signature,"base64")); } catch { valid=false; }
  if (!valid) blocked("Authority signature is invalid");
  return Object.freeze(value);
}

export function authorityReference(record) {
  const valid=validateCoreDocument(clone(record),"authority-record.v1");
  return Object.freeze({record_id:valid.record_id,sha256:sha256Canonical(valid)});
}
