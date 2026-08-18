import fs from "node:fs";
import path from "node:path";
import {types as utilTypes} from "node:util";

import {
  CommandUsageError,
  dispatchCommand,
  EXIT_CODES,
  parseCommand,
} from "./commands/router.js";
import {
  createLifecycleRuntimeProvider,
  DesignRuntimeAuthorityError,
  lifecycleRuntimeServices,
} from "./design-runtime-authority.js";
import {failureResult} from "./output/command-result.js";

const NO_FOLLOW=fs.constants.O_NOFOLLOW ?? 0;
const INPUT_FAMILIES=new Set(["project","feature","design"]);
const UNIMPLEMENTED_FAMILIES=new Set(["artifacts","validate"]);

export {createLifecycleRuntimeProvider,lifecycleRuntimeServices};

function dataRecord(value,label,allowed,{required=[]}={}) {
  if (!value || typeof value!=="object" || Array.isArray(value) || utilTypes.isProxy(value) ||
      !new Set([Object.prototype,null]).has(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a plain non-proxy object`);
  }
  const descriptors=Object.getOwnPropertyDescriptors(value);
  const keys=Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key==="symbol")) {
    throw new TypeError(`${label} symbol properties are unsupported`);
  }
  const result=Object.create(null);
  for (const key of keys) {
    const descriptor=descriptors[key];
    if (!descriptor.enumerable || !("value" in descriptor) || !allowed.has(key)) {
      throw new TypeError(`${label} contains an accessor, hidden, or unexpected property`);
    }
    result[key]=descriptor.value;
  }
  for (const key of required) {
    if (!Object.hasOwn(descriptors,key)) throw new TypeError(`${label} requires ${key}`);
  }
  return result;
}

function readLifecycleInput(base,inputPath) {
  const resolved=path.resolve(base,inputPath);
  const descriptor=fs.openSync(resolved,fs.constants.O_RDONLY|NO_FOLLOW);
  try {
    const stat=fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new TypeError("Lifecycle input must be a regular file");
    return fs.readFileSync(descriptor,"utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function needsInputReader(command) {
  const family=command.name.split(".")[0];
  return INPUT_FAMILIES.has(family) || command.name==="decisions.answer" ||
    command.name==="architecture.approve" ||
    (command.name==="issues.publish" && command.options.apply);
}

function needsDesignRuntime(command) {
  return command.name==="design.approve" ||
    (command.name.startsWith("design.") && command.name!=="design.status" &&
      command.interactive && command.options.from===null);
}

async function lifecycleContext(command,base,runtimeProvider) {
  const family=command.name.split(".")[0];
  if (UNIMPLEMENTED_FAMILIES.has(family)) return Object.freeze({});
  const root=path.resolve(base,command.options.project ?? ".");
  const {createArtifactStore}=await import("./artifacts/store.js");
  const services={artifactStore:createArtifactStore({root})};
  if (needsInputReader(command)) {
    services.readInput=async inputPath => readLifecycleInput(base,inputPath);
  }
  const runtime=runtimeProvider===undefined ? null :
    lifecycleRuntimeServices(runtimeProvider);
  if (needsDesignRuntime(command) && !runtime) {
    throw new DesignRuntimeAuthorityError(
      "DESIGN_RUNTIME_REQUIRED",
      "Interactive or approval design commands require a trusted runtime provider",
    );
  }
  if (runtime) {
    services.prompt=runtime.prompt;
    services.authorityCapability=runtime.authorityCapability;
  }
  return Object.freeze({services:Object.freeze(services)});
}

function failed(error) {
  const exitCode=error instanceof CommandUsageError ? EXIT_CODES.USAGE :
    Object.values(EXIT_CODES).includes(error?.exitCode) ? error.exitCode :
      EXIT_CODES.INTERNAL;
  return Object.freeze({exitCode,result:failureResult(error)});
}

export async function runLifecycleCommand(args,options) {
  try {
    const normalized=dataRecord(
      options,"lifecycle command options",new Set(["root","runtimeProvider"]),
      {required:["root"]},
    );
    if (typeof normalized.root!=="string" || normalized.root.trim().length===0) {
      throw new TypeError("lifecycle command root must be a non-blank path");
    }
    const command=parseCommand(args);
    const context=await lifecycleContext(
      command,path.resolve(normalized.root),normalized.runtimeProvider,
    );
    return dispatchCommand(command,context);
  } catch (error) {
    return failed(error);
  }
}
