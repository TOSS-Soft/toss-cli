import {types} from "node:util";

import {canonicalJson} from "../../contracts/acp.js";
import {validateCoreDocument} from "../contracts.js";
import {CoreValidationError} from "../errors.js";
import {parseWorkItemId} from "./identity.js";

function invalid(message,options={}) {
  throw new CoreValidationError(message,options);
}

function copyClosed(value,label,ancestors=new Set()) {
  if (value===null || ["string","boolean"].includes(typeof value)) return value;
  if (typeof value==="number") {
    if (!Number.isFinite(value)) invalid(`${label} must contain only finite JSON values`);
    return value;
  }
  if (typeof value!=="object" || types.isProxy(value)) {
    invalid(`${label} must contain only plain non-proxy JSON data`);
  }
  if (ancestors.has(value)) invalid(`${label} must not be cyclic`);
  ancestors.add(value);
  try {
    const prototype=Object.getPrototypeOf(value);
    const descriptors=Object.getOwnPropertyDescriptors(value);
    const keys=Reflect.ownKeys(descriptors);
    if (Array.isArray(value)) {
      if (prototype!==Array.prototype) invalid(`${label} arrays must be plain`);
      const length=descriptors.length?.value;
      const dataKeys=keys.filter(key => key!=="length");
      if (!Number.isSafeInteger(length) || length<0 || dataKeys.length!==length) {
        invalid(`${label} arrays must be dense own data`);
      }
      const result=[];
      for (let index=0;index<length;index+=1) {
        const key=String(index);
        const descriptor=descriptors[key];
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          invalid(`${label} arrays must be dense own data`);
        }
        result.push(copyClosed(descriptor.value,`${label}[${index}]`,ancestors));
      }
      return Object.freeze(result);
    }
    if (prototype!==Object.prototype && prototype!==null) {
      invalid(`${label} objects must be plain`);
    }
    const result=Object.create(null);
    for (const key of keys) {
      const descriptor=descriptors[key];
      if (typeof key!=="string" || !descriptor.enumerable || !("value" in descriptor)) {
        invalid(`${label} objects must contain only own enumerable data`);
      }
      result[key]=copyClosed(descriptor.value,`${label}.${key}`,ancestors);
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function exactKeys(value,expected,label) {
  if (value===null || typeof value!=="object" || Array.isArray(value)) {
    invalid(`${label} must be a plain closed record`);
  }
  const actual=Object.keys(value).sort();
  const wanted=[...expected].sort();
  if (canonicalJson(actual)!==canonicalJson(wanted)) {
    invalid(`${label} must use the exact closed shape`);
  }
}

function canonicalId(value,label) {
  try {
    parseWorkItemId(value);
  } catch (error) {
    invalid(`${label} must be a canonical work-item ID`,{cause:error});
  }
  return value;
}

function compareText(left,right) {
  if (left===right) return 0;
  return left<right ? -1 : 1;
}

function compareEdges(left,right) {
  for (const key of ["source","target","kind","edge_id"]) {
    const comparison=compareText(left[key],right[key]);
    if (comparison!==0) return comparison;
  }
  return compareText(canonicalJson(left),canonicalJson(right));
}

function explicitCycle(nodes,edges) {
  const remaining=new Set(nodes);
  const adjacency=new Map(nodes.map(node => [node,[]]));
  for (const edge of edges) {
    if (remaining.has(edge.source) && remaining.has(edge.target)) {
      adjacency.get(edge.source).push(edge.target);
    }
  }
  for (const targets of adjacency.values()) targets.sort(compareText);

  const state=new Map();
  for (const root of [...nodes].sort(compareText)) {
    if (state.has(root)) continue;
    const path=[root];
    const pathIndexes=new Map([[root,0]]);
    const frames=[{node:root,nextTarget:0}];
    state.set(root,"visiting");

    while (frames.length>0) {
      const frame=frames.at(-1);
      const targets=adjacency.get(frame.node);
      if (frame.nextTarget>=targets.length) {
        frames.pop();
        path.pop();
        pathIndexes.delete(frame.node);
        state.set(frame.node,"visited");
        continue;
      }

      const target=targets[frame.nextTarget];
      frame.nextTarget+=1;
      if (state.get(target)==="visiting") {
        const start=pathIndexes.get(target);
        return [...path.slice(start),target];
      }
      if (state.get(target)==="visited") continue;
      state.set(target,"visiting");
      pathIndexes.set(target,path.length);
      path.push(target);
      frames.push({node:target,nextTarget:0});
    }
  }
  return null;
}

export function validateDependencyGraph(input) {
  const value=copyClosed(input,"Dependency graph");
  exactKeys(value,["nodes","edges"],"Dependency graph");
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    invalid("Dependency graph nodes and edges must be arrays");
  }

  const nodeSet=new Set();
  for (const node of value.nodes) {
    canonicalId(node,"Dependency node");
    if (nodeSet.has(node)) invalid(`Dependency graph has duplicate node ${node}`);
    nodeSet.add(node);
  }

  const edgeIds=new Set();
  const semanticEdges=new Set();
  const edges=value.edges.map(edge => {
    validateCoreDocument(edge,"dependency-edge.v1");
    if (edgeIds.has(edge.edge_id)) invalid(`Dependency graph has duplicate edge id ${edge.edge_id}`);
    edgeIds.add(edge.edge_id);
    const semantic=`${edge.source}\u0000${edge.target}\u0000${edge.kind}`;
    if (semanticEdges.has(semantic)) {
      invalid(`Dependency graph has duplicate dependency ${edge.source} -> ${edge.target}`);
    }
    semanticEdges.add(semantic);
    if (edge.source===edge.target) invalid(`Dependency edge ${edge.edge_id} cannot reference itself`);
    if (!nodeSet.has(edge.source)) invalid(`Dependency edge ${edge.edge_id} has dangling source ${edge.source}`);
    if (!nodeSet.has(edge.target)) invalid(`Dependency edge ${edge.edge_id} has dangling target ${edge.target}`);
    return edge;
  }).sort(compareEdges);

  const remaining=new Set(nodeSet);
  const dependencies=new Map([...nodeSet].map(node => [node,new Set()]));
  for (const edge of edges) dependencies.get(edge.source).add(edge.target);
  const order=[];
  const stages=[];
  while (remaining.size>0) {
    const ready=[...remaining]
      .filter(node => [...dependencies.get(node)].every(target => !remaining.has(target)))
      .sort(compareText);
    if (ready.length===0) break;
    stages.push(Object.freeze(ready));
    order.push(...ready);
    for (const node of ready) remaining.delete(node);
  }

  if (remaining.size>0) {
    const cycle=explicitCycle([...remaining],edges);
    invalid(`Dependency graph contains cycle: ${cycle.join(" -> ")}`);
  }

  return Object.freeze({
    order:Object.freeze(order),
    stages:Object.freeze(stages),
    edges:Object.freeze(edges),
  });
}

function validateGraphResult(input) {
  const graph=copyClosed(input,"Validated dependency graph");
  exactKeys(graph,["order","stages","edges"],"Validated dependency graph");
  if (!Array.isArray(graph.order) || !Array.isArray(graph.stages) ||
      !graph.stages.every(Array.isArray) || !Array.isArray(graph.edges)) {
    invalid("Validated dependency graph has invalid arrays");
  }
  const rebuilt=validateDependencyGraph({nodes:graph.order,edges:graph.edges});
  if (canonicalJson(graph)!==canonicalJson(rebuilt)) {
    invalid("Validated dependency graph order or stages are not canonical");
  }
  return rebuilt;
}

export function dependencyReadiness(itemId,graphInput,completedIdsInput) {
  canonicalId(itemId,"Readiness item");
  const graph=validateGraphResult(graphInput);
  const completedIds=copyClosed(completedIdsInput,"Completed dependency IDs");
  if (!Array.isArray(completedIds)) invalid("Completed dependency IDs must be an array");
  const nodes=new Set(graph.order);
  if (!nodes.has(itemId)) invalid(`Readiness item is unknown: ${itemId}`);
  const complete=new Set();
  for (const completedId of completedIds) {
    canonicalId(completedId,"Completed dependency ID");
    if (!nodes.has(completedId)) invalid(`Unknown completed dependency ID: ${completedId}`);
    if (complete.has(completedId)) invalid(`Duplicate completed dependency ID: ${completedId}`);
    complete.add(completedId);
  }
  const blocking=graph.edges
    .filter(edge => edge.source===itemId && edge.kind==="requires")
    .map(edge => edge.target)
    .filter(target => !complete.has(target))
    .sort(compareText);
  return Object.freeze({ready:blocking.length===0,blocking:Object.freeze(blocking)});
}
