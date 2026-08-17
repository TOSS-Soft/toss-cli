import YAML, {isAlias, isMap, isScalar, isSeq} from "yaml";

import {canonicalJson} from "./acp.js";

function canonicalCopy(value) {
  return JSON.parse(canonicalJson(value));
}

function rejectTagOrAnchor(node,path) {
  if (node?.tag) {
    throw new TypeError(`YAML tags are unsupported at ${path}`);
  }
  if (node?.anchor) {
    throw new TypeError(`YAML aliases are unsupported at ${path}`);
  }
}

function projectNode(node,path) {
  if (node===null) return null;
  rejectTagOrAnchor(node,path);
  if (isAlias(node)) {
    throw new TypeError(`YAML aliases are unsupported at ${path}`);
  }
  if (isScalar(node)) {
    const value=node.value;
    if (value===null || typeof value==="string" || typeof value==="boolean" ||
        (typeof value==="number" && Number.isFinite(value))) {
      return value;
    }
    throw new TypeError(`YAML scalar is outside the JSON data model at ${path}`);
  }
  if (isSeq(node)) {
    return node.items.map((item,index) => projectNode(item,`${path}[${index}]`));
  }
  if (isMap(node)) {
    const projected={};
    const keys=new Set();
    for (const pair of node.items) {
      if (!pair.key || !isScalar(pair.key)) {
        throw new TypeError(`YAML mapping key must be a string at ${path}`);
      }
      rejectTagOrAnchor(pair.key,path);
      const key=pair.key.value;
      if (typeof key!=="string") {
        throw new TypeError(`YAML mapping key must be a string at ${path}`);
      }
      if (keys.has(key)) {
        throw new TypeError(`Duplicate YAML mapping key ${key} at ${path}`);
      }
      keys.add(key);
      Object.defineProperty(projected,key,{
        configurable:true,
        enumerable:true,
        value:projectNode(pair.value,`${path}.${key}`),
        writable:true,
      });
    }
    return projected;
  }
  throw new TypeError(`Unsupported YAML node at ${path}`);
}

function projectionDocument(text) {
  const document=YAML.parseDocument(text,{
    maxAliasCount:0,
    prettyErrors:false,
    schema:"core",
    uniqueKeys:true,
    version:"1.2",
  });
  const firstError=document.errors[0];
  if (firstError) {
    if (/tag/i.test(firstError.message)) {
      throw new TypeError("YAML tags are unsupported");
    }
    if (/alias/i.test(firstError.message)) {
      throw new TypeError("YAML aliases are unsupported");
    }
    throw new TypeError(`Invalid YAML projection: ${firstError.message}`);
  }
  return document;
}

export function toYamlProjection(value) {
  const normalized=canonicalCopy(value);
  return YAML.stringify(normalized,{
    aliasDuplicateObjects:false,
    indent:2,
    lineWidth:0,
    simpleKeys:true,
  });
}

export function fromYamlProjection(text) {
  if (typeof text!=="string") {
    throw new TypeError("YAML projection must be a string");
  }
  const document=projectionDocument(text);
  return canonicalCopy(projectNode(document.contents,"$"));
}
