import {createHash} from "node:crypto";
import {types} from "node:util";

import {CoreValidationError} from "../errors.js";

const RESERVATION_KEYS=Object.freeze(["kind","number","title"]);
const REPOSITORY=/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const WORK_ITEM_ID=/^([A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?)#([1-9][0-9]*)$/;
const RESERVED_BRANCH=/^(bug|epic|issue)\/([1-9][0-9]*)-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const PREFIXES=Object.freeze({bug:"bug",epic:"epic",issue:"issue"});
const MAX_SLUG_LENGTH=48;
const HASH_LENGTH=8;

function invalid(message) {
  throw new CoreValidationError(message);
}

function assertCanonicalRepository(repository) {
  if (typeof repository!=="string" || !REPOSITORY.test(repository) ||
      repository.split("/").some(segment => segment==="." || segment==="..")) {
    invalid("Work item repository must be canonical OWNER/REPO ASCII");
  }
  return repository;
}

function assertIssueNumber(issueNumber) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber<1) {
    invalid("Work item issue number must be a positive safe integer");
  }
  return issueNumber;
}

function closeReservation(value) {
  if (value===null || typeof value!=="object" || Array.isArray(value) ||
      types.isProxy(value)) {
    invalid("Branch identity input must be a plain non-proxy record");
  }
  const prototype=Object.getPrototypeOf(value);
  if (prototype!==Object.prototype && prototype!==null) {
    invalid("Branch identity input must be a plain non-proxy record");
  }
  const descriptors=Object.getOwnPropertyDescriptors(value);
  const keys=Reflect.ownKeys(descriptors);
  if (keys.length!==RESERVATION_KEYS.length ||
      !RESERVATION_KEYS.every(key => keys.includes(key))) {
    invalid("Branch identity input must have exactly kind, number, and title");
  }
  for (const key of keys) {
    const descriptor=descriptors[key];
    if (typeof key!=="string" || !descriptor.enumerable || !("value" in descriptor)) {
      invalid("Branch identity input must contain only own enumerable data");
    }
  }
  return Object.freeze(Object.fromEntries(
    RESERVATION_KEYS.map(key => [key,descriptors[key].value]),
  ));
}

function normalizedSlug(title,number) {
  if (typeof title!=="string") invalid("Branch title must be a string");
  const material=title
    .normalize("NFKD")
    .replace(/\p{M}+/gu,"")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g,"-")
    .replace(/^-+|-+$/g,"") || `item-${number}`;
  if (material.length<=MAX_SLUG_LENGTH) return material;
  const suffix=createHash("sha256").update(material,"utf8").digest("hex").slice(0,HASH_LENGTH);
  return `${material.slice(0,MAX_SLUG_LENGTH-HASH_LENGTH-1)}-${suffix}`;
}

export function workItemId(repository,issueNumber) {
  return `${assertCanonicalRepository(repository)}#${assertIssueNumber(issueNumber)}`;
}

export function parseWorkItemId(value) {
  const match=typeof value==="string" ? WORK_ITEM_ID.exec(value) : null;
  if (!match) invalid("Work item id must be canonical OWNER/REPO#NUMBER ASCII");
  const issueNumber=Number(match[2]);
  assertIssueNumber(issueNumber);
  return Object.freeze({repository:match[1],issueNumber});
}

export function parseReservedBranch(value) {
  const match=typeof value==="string" ? RESERVED_BRANCH.exec(value) : null;
  if (!match || match[3].length>MAX_SLUG_LENGTH) {
    invalid("Reserved branch must use a canonical kind, issue number, and slug of at most 48 characters");
  }
  const issueNumber=Number(match[2]);
  assertIssueNumber(issueNumber);
  return Object.freeze({kind:match[1],issueNumber,slug:match[3]});
}

export function reserveBranch(input) {
  const {kind,number,title}=closeReservation(input);
  const prefix=typeof kind==="string" ? PREFIXES[kind] : undefined;
  if (!prefix) invalid("Persisted branch kind must be epic, issue, or bug");
  assertIssueNumber(number);
  return `${prefix}/${number}-${normalizedSlug(title,number)}`;
}
