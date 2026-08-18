import {canonicalJson} from "../contracts/acp.js";
import {
  failureResult,
  inspectNativeCommandError,
  successResult,
} from "../output/command-result.js";
import {
  COMMAND_DEFINITIONS,
  EXIT_CODES,
  OPTION_SPECS,
  SHELL_COMPLETION_WORDS,
} from "./options.js";

export {EXIT_CODES,SHELL_COMPLETION_WORDS};

const definitionsByName=new Map(COMMAND_DEFINITIONS.map(row => [row.name,row]));
const knownFamilies=new Set(COMMAND_DEFINITIONS.map(row => row.tokens[0]));
const OPTION_PROPERTIES=Object.freeze({
  from:null,
  nonInteractive:false,
  json:false,
  continue:false,
  project:null,
  apply:false,
});
const CONTEXT_KEYS=new Set(["handlers","services","artifacts","artifactStore"]);

export class CommandUsageError extends Error {
  constructor(message) {
    super(message);
    this.name="CommandUsageError";
    this.code="COMMAND_USAGE";
    this.exitCode=EXIT_CODES.USAGE;
  }
}

function deepFreeze(value) {
  if (!value || typeof value!=="object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalArgv(argv) {
  let normalized;
  try {
    normalized=JSON.parse(canonicalJson(argv));
  } catch (error) {
    throw new CommandUsageError(
      `Command arguments must be canonical JSON: ${error instanceof Error ? error.message : "invalid value"}`,
    );
  }
  if (!Array.isArray(normalized)) {
    throw new CommandUsageError("Command arguments must be an array");
  }
  if (normalized.some(value => typeof value!=="string")) {
    throw new CommandUsageError("Every command argument must be a string");
  }
  return normalized;
}

function usage(definition) {
  return `Usage: toss ${definition.tokens.join(" ")}${
    definition.usage ? ` ${definition.usage}` : ""
  }`;
}

function findDefinition(argv) {
  const definition=COMMAND_DEFINITIONS.find(row =>
    row.tokens.every((token,index) => argv[index]===token));
  if (definition) return definition;
  if (argv.length===0) throw new CommandUsageError("Usage: toss <command> [options]");
  if (knownFamilies.has(argv[0])) {
    throw new CommandUsageError(`Unknown command: ${argv.slice(0,2).join(" ")}`);
  }
  throw new CommandUsageError(`Unknown command: ${argv[0]}`);
}

function normalizedOptions() {
  return {...OPTION_PROPERTIES};
}

function parseRemainder(definition,remainder) {
  const options=normalizedOptions();
  const seen=new Set();
  const args=[];
  for (let index=0;index<remainder.length;index+=1) {
    const token=remainder[index];
    if (!token.startsWith("-")) {
      args.push(token);
      continue;
    }
    const spec=OPTION_SPECS[token];
    if (!spec || !definition.options.includes(token)) {
      throw new CommandUsageError(`Invalid option for ${definition.name}: ${token}`);
    }
    if (seen.has(token)) {
      throw new CommandUsageError(`Duplicate option for ${definition.name}: ${token}`);
    }
    seen.add(token);
    if (spec.takesValue) {
      const value=remainder[index+1];
      if (typeof value!=="string" || value.length===0 || value.startsWith("--")) {
        throw new CommandUsageError(`Option ${token} requires a value`);
      }
      options[spec.property]=value;
      index+=1;
    } else {
      options[spec.property]=true;
    }
  }
  if (options.continue && options.from!==null) {
    throw new CommandUsageError("Options --continue and --from cannot be combined");
  }
  if (args.length<definition.minimumArgs || args.length>definition.maximumArgs) {
    throw new CommandUsageError(usage(definition));
  }
  return {args,options};
}

function readOnly(definition,options) {
  if (definition.mutation==="never") return true;
  if (definition.mutation==="apply") return options.apply!==true;
  return false;
}

export function parseCommand(argv) {
  const normalized=canonicalArgv(argv);
  const definition=findDefinition(normalized);
  const remainder=normalized.slice(definition.tokens.length);
  const parsed=parseRemainder(definition,remainder);
  return deepFreeze({
    name:definition.name,
    args:parsed.args,
    options:parsed.options,
    readOnly:readOnly(definition,parsed.options),
    interactive:definition.interactive && !parsed.options.nonInteractive,
  });
}

function isPlainObject(value) {
  if (!value || typeof value!=="object" || Array.isArray(value)) return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype || prototype===null;
}

function captureDataProperties(value,label,allowedKeys) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const descriptors=Object.getOwnPropertyDescriptors(value);
  const keys=Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key==="symbol")) {
    throw new TypeError(`${label} symbol properties are unsupported`);
  }
  const normalized=Object.create(null);
  for (const key of keys) {
    const descriptor=descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${label} accessor or non-enumerable property is unsupported: ${key}`);
    }
    if (allowedKeys && !allowedKeys.has(key)) {
      throw new TypeError(`Unknown ${label} property: ${key}`);
    }
    normalized[key]=descriptor.value;
  }
  return normalized;
}

function assertDataProperties(value,label,allowedKeys) {
  captureDataProperties(value,label,allowedKeys);
}

function assertParsedCommand(command) {
  let normalized;
  try {
    normalized=JSON.parse(canonicalJson(command));
  } catch (error) {
    throw new TypeError(
      `Command must be canonical JSON: ${error instanceof Error ? error.message : "invalid value"}`,
      {cause:error},
    );
  }
  assertDataProperties(
    normalized,"command",new Set(["name","args","options","readOnly","interactive"]),
  );
  const definition=definitionsByName.get(normalized.name);
  if (!definition) throw new TypeError(`Unknown parsed command: ${String(normalized.name)}`);
  if (!Array.isArray(normalized.args) ||
      normalized.args.some(value => typeof value!=="string") ||
      normalized.args.length<definition.minimumArgs ||
      normalized.args.length>definition.maximumArgs) {
    throw new TypeError(`Invalid parsed command arguments for ${definition.name}`);
  }
  assertDataProperties(normalized.options,"command options",new Set(Object.keys(OPTION_PROPERTIES)));
  if (Object.keys(normalized.options).length!==Object.keys(OPTION_PROPERTIES).length) {
    throw new TypeError("Command options must use the exact normalized shape");
  }
  for (const [name,defaultValue] of Object.entries(OPTION_PROPERTIES)) {
    const value=normalized.options[name];
    if (defaultValue===null ? !(value===null || typeof value==="string") : typeof value!=="boolean") {
      throw new TypeError(`Invalid normalized command option: ${name}`);
    }
  }
  for (const [token,spec] of Object.entries(OPTION_SPECS)) {
    if (!definition.options.includes(token) && normalized.options[spec.property]!==OPTION_PROPERTIES[spec.property]) {
      throw new TypeError(`Invalid normalized option for ${definition.name}: ${token}`);
    }
  }
  if (normalized.options.continue && normalized.options.from!==null) {
    throw new TypeError("Normalized --continue and --from cannot be combined");
  }
  if (normalized.readOnly!==readOnly(definition,normalized.options) ||
      normalized.interactive!==(definition.interactive && !normalized.options.nonInteractive)) {
    throw new TypeError(`Parsed command safety metadata is invalid for ${definition.name}`);
  }
  return deepFreeze(normalized);
}

function normalizeContext(context) {
  const normalized=captureDataProperties(context,"dispatch context",CONTEXT_KEYS);
  if (Object.hasOwn(normalized,"services") && normalized.services!==undefined) {
    normalized.services=Object.freeze(captureDataProperties(
      normalized.services,"command services",
    ));
  }
  if (Object.hasOwn(normalized,"handlers") && normalized.handlers!==undefined) {
    const handlers=captureDataProperties(normalized.handlers,"command handlers");
    for (const key of Object.getOwnPropertyNames(handlers)) {
      if (!definitionsByName.has(key)) {
        throw new TypeError(`Unknown command handler: ${key}`);
      }
      if (typeof handlers[key]!=="function") {
        throw new TypeError(`Command handler must be an own enumerable data-function: ${key}`);
      }
    }
    normalized.handlers=Object.freeze(handlers);
  }
  return Object.freeze(normalized);
}

function handlerFor(context,name) {
  if (context.handlers===undefined) return null;
  return Object.getOwnPropertyDescriptor(context.handlers,name)?.value ?? null;
}

async function builtinHandler(name) {
  if (name.startsWith("project.")) {
    const {runProjectCommand}=await import("./project.js");
    return runProjectCommand;
  }
  if (name.startsWith("feature.")) {
    const {runFeatureCommand}=await import("./feature.js");
    return runFeatureCommand;
  }
  return null;
}

async function dispatchTrace(command,context) {
  const {runTraceCommand}=await import("./trace.js");
  const traceContext=Object.create(null);
  if (context.artifacts!==undefined) traceContext.artifacts=context.artifacts;
  else traceContext.artifactStore=context.artifactStore;
  Object.freeze(traceContext);
  const traceArgs=[...command.args];
  if (command.options.json) traceArgs.push("--json");
  const trace=await runTraceCommand(traceArgs,traceContext);
  return trace.result;
}

function result(exitCode,result) {
  return deepFreeze({exitCode,result});
}

function errorExitCode(error) {
  const value=error.exitCode;
  if (Object.values(EXIT_CODES).includes(value) && value!==EXIT_CODES.SUCCESS) {
    return value;
  }
  const code=error.error.code;
  if (code==="TRACE_STORE_INVALID") return EXIT_CODES.VALIDATION_FAILED;
  if (new Set([
    "TRACE_ARGUMENT_INVALID",
    "TRACE_INPUT_INVALID",
    "TRACE_INPUT_MISSING",
    "TRACE_INPUT_AMBIGUOUS",
    "TRACE_ENTITY_NOT_FOUND",
  ]).has(code)) return EXIT_CODES.INVALID_INPUT;
  return EXIT_CODES.INTERNAL;
}

function defaultFailure() {
  return Object.freeze({
    exitCode:EXIT_CODES.INTERNAL,
    result:failureResult({
      code:"COMMAND_FAILED",
      message:"Command handler failed with an unsupported error",
    }),
  });
}

function closedFailure(error) {
  try {
    const native=inspectNativeCommandError(error);
    if (!native) return defaultFailure();
    const failure=failureResult(native.error);
    return Object.freeze({
      exitCode:errorExitCode(native),
      result:failure,
    });
  } catch {
    return defaultFailure();
  }
}

export async function dispatchCommand(command,context={}) {
  const normalized=assertParsedCommand(command);
  const normalizedContext=normalizeContext(context);
  if (normalized.name==="trace" &&
      normalizedContext.artifacts!==undefined &&
      normalizedContext.artifactStore!==undefined) {
    return result(EXIT_CODES.INVALID_INPUT,failureResult({
      code:"TRACE_INPUT_AMBIGUOUS",
      message:"Trace dispatch context accepts exactly one explicit artifact source",
    }));
  }
  if (normalized.name==="trace" &&
      normalizedContext.artifacts===undefined &&
      normalizedContext.artifactStore===undefined) {
    return result(EXIT_CODES.INVALID_INPUT,failureResult({
      code:"TRACE_INPUT_MISSING",
      message:"Trace dispatch context requires exactly one explicit artifact source",
    }));
  }
  try {
    if (normalized.name==="trace") {
      return result(EXIT_CODES.SUCCESS,successResult(
        await dispatchTrace(normalized,normalizedContext),
      ));
    }
    const handler=handlerFor(normalizedContext,normalized.name) ??
      await builtinHandler(normalized.name);
    if (!handler) {
      return result(EXIT_CODES.NOT_IMPLEMENTED,failureResult({
        code:"COMMAND_NOT_IMPLEMENTED",
        message:`Command is declared but not implemented: ${normalized.name}`,
      }));
    }
    const data=await Reflect.apply(
      handler,undefined,[normalized,normalizedContext.services],
    );
    const succeeded=successResult(data);
    const exitCode=succeeded.data?.blocked===true &&
      succeeded.data?.command_exit_code===EXIT_CODES.BLOCKED ?
      EXIT_CODES.BLOCKED : EXIT_CODES.SUCCESS;
    return result(exitCode,succeeded);
  } catch (error) {
    const failure=closedFailure(error);
    return result(failure.exitCode,failure.result);
  }
}
