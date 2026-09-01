import {types as utilTypes} from "node:util";

import {failureResult,successResult} from "../../output/command-result.js";
import {
  CORE_COMMAND_ARGUMENTS,
  CORE_EXIT_CODES,
  CORE_OPTION_DEFAULTS,
  CoreCommandUsageError,
  parseCoreCommand,
} from "./options.js";

const FOUNDATION_COMMANDS=new Set(["init","repo.add","repo.list"]);
const CONTEXT_KEYS=new Set(["handlers","services"]);

export {CORE_EXIT_CODES,CoreCommandUsageError,parseCoreCommand};

function deepFreeze(value) {
  if (!value || typeof value!=="object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function dataRecord(value,label,allowed) {
  if (!value || typeof value!=="object" || Array.isArray(value) || utilTypes.isProxy(value) ||
      !new Set([Object.prototype,null]).has(Object.getPrototypeOf(value))) {
    throw new TypeError(label+" must be a plain non-proxy object");
  }
  const descriptors=Object.getOwnPropertyDescriptors(value);
  const output=Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor=descriptors[key];
    if (typeof key!=="string" || !descriptor.enumerable || !("value" in descriptor) ||
        !allowed.has(key)) {
      throw new TypeError(label+" contains an accessor, hidden, symbol, or unexpected property");
    }
    output[key]=descriptor.value;
  }
  return output;
}

function assertParsedCommand(command) {
  const normalized=dataRecord(command,"core command",new Set([
    "name","args","options","readOnly","interactive",
  ]));
  const bounds=CORE_COMMAND_ARGUMENTS[normalized.name];
  if (!bounds || !Array.isArray(normalized.args) ||
      normalized.args.some(value => typeof value!=="string") ||
      normalized.args.length<bounds[0] || normalized.args.length>bounds[1]) {
    throw new TypeError("Invalid parsed core command arguments");
  }
  const options=dataRecord(
    normalized.options,"core command options",new Set(Object.keys(CORE_OPTION_DEFAULTS)),
  );
  if (Object.keys(options).length!==Object.keys(CORE_OPTION_DEFAULTS).length) {
    throw new TypeError("Core command options must use the exact normalized shape");
  }
  for (const [name,defaultValue] of Object.entries(CORE_OPTION_DEFAULTS)) {
    const value=options[name];
    if (defaultValue===null ? !(value===null || typeof value==="string") : typeof value!=="boolean") {
      throw new TypeError("Invalid normalized core option: "+name);
    }
  }
  const reparsed=parseCoreCommand([
    ...normalized.name.split("."),...normalized.args,
    ...(options.apply ? ["--apply"] : []),
    ...(options.authority===null ? [] : ["--authority",options.authority]),
    ...(options.control===null ? [] : ["--control",options.control]),
    ...(options.cutover===null ? [] : ["--cutover",options.cutover]),
    ...(options.dryRun ? ["--dry-run"] : []),
    ...(options.from===null ? [] : ["--from",options.from]),
    ...(options.json ? ["--json"] : []),
    ...(options.nonInteractive ? ["--non-interactive"] : []),
  ]);
  if (normalized.readOnly!==reparsed.readOnly || normalized.interactive!==reparsed.interactive) {
    throw new TypeError("Core command safety metadata is invalid");
  }
  return Object.freeze({
    name:reparsed.name,
    args:reparsed.args,
    options:reparsed.options,
    readOnly:reparsed.readOnly,
    interactive:reparsed.interactive,
  });
}

function normalizeContext(context) {
  const record=dataRecord(context,"core dispatch context",CONTEXT_KEYS);
  const normalized=Object.create(null);
  if (Object.hasOwn(record,"services")) normalized.services=record.services;
  if (Object.hasOwn(record,"handlers")) {
    const handlers=dataRecord(record.handlers,"core command handlers",FOUNDATION_COMMANDS);
    for (const [name,handler] of Object.entries(handlers)) {
      if (typeof handler!=="function" || utilTypes.isProxy(handler)) {
        throw new TypeError("Core command handler must be a non-proxy function: "+name);
      }
    }
    normalized.handlers=Object.freeze(handlers);
  }
  return Object.freeze(normalized);
}

function failure(exitCode,code,message) {
  return deepFreeze({exitCode,result:failureResult({code,message})});
}

function failureFromError(error) {
  if (error instanceof CoreCommandUsageError) {
    return failure(CORE_EXIT_CODES.USAGE,error.code,error.message);
  }
  const exitCode=Object.values(CORE_EXIT_CODES).includes(error?.exitCode) &&
    error.exitCode!==CORE_EXIT_CODES.SUCCESS ? error.exitCode : CORE_EXIT_CODES.INTERNAL;
  const code=typeof error?.code==="string" && /^[A-Z][A-Z0-9_]*$/.test(error.code) ?
    error.code : "COMMAND_FAILED";
  const message=typeof error?.message==="string" && /\S/.test(error.message) ?
    error.message : "Core command handler failed";
  return failure(exitCode,code,message);
}

export async function dispatchCoreCommand(command,context={}) {
  try {
    const normalized=assertParsedCommand(command);
    const services=normalizeContext(context);
    if (!FOUNDATION_COMMANDS.has(normalized.name)) {
      return failure(
        CORE_EXIT_CODES.NOT_IMPLEMENTED,
        "COMMAND_NOT_IMPLEMENTED",
        "Command is declared but not implemented: "+normalized.name,
      );
    }
    const handler=services.handlers?.[normalized.name];
    if (!handler) {
      return failure(
        CORE_EXIT_CODES.NOT_IMPLEMENTED,
        "COMMAND_NOT_IMPLEMENTED",
        "Command is declared but not implemented: "+normalized.name,
      );
    }
    const data=await Reflect.apply(handler,undefined,[normalized,services.services]);
    return deepFreeze({exitCode:CORE_EXIT_CODES.SUCCESS,result:successResult(data)});
  } catch (error) {
    return failureFromError(error);
  }
}
