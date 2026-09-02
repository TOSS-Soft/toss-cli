import {types as utilTypes} from "node:util";

import {failureResult,renderCommandHuman,renderCommandJson} from "../output/command-result.js";
import {CORE_PACKAGE_VERSION} from "./metadata.js";
import {
  CORE_EXIT_CODES,
  CoreCommandUsageError,
  dispatchCoreCommand,
  parseCoreCommand,
} from "./commands/router.js";

class CoreCliError extends Error {
  constructor(code,message,exitCode) {
    super(message);
    this.name="CoreCliError";
    this.code=code;
    this.exitCode=exitCode;
  }
}

export const CORE_HELP=`Usage: toss-core <command> [options]

Commands:
  init
  repo add <OWNER/REPO> --from <FILE>
  repo list

Common options:
  --json
  --control <PATH>  Local control repository (default: .toss-core-control)
  --apply --non-interactive
  --dry-run`;

function isPlainRecord(value) {
  return Boolean(value) && typeof value==="object" && !Array.isArray(value) &&
    !utilTypes.isProxy(value) && new Set([Object.prototype,null]).has(Object.getPrototypeOf(value));
}

function ownDataRecord(value,label,allowed) {
  if (!isPlainRecord(value)) throw new TypeError(label+" must be a plain non-proxy object");
  const descriptors=Object.getOwnPropertyDescriptors(value);
  const result=Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor=descriptors[key];
    if (typeof key!=="string" || !descriptor.enumerable || !("value" in descriptor) ||
        !allowed.has(key)) {
      throw new TypeError(label+" contains an accessor, hidden, symbol, or unexpected property");
    }
    result[key]=descriptor.value;
  }
  return result;
}

function assertWriter(value,label) {
  if (!value || typeof value.write!=="function") {
    throw new TypeError(label+" must provide write(value)");
  }
  return value;
}

function renderFailure(error) {
  const exitCode=error instanceof CoreCommandUsageError ? CORE_EXIT_CODES.USAGE :
    Object.values(CORE_EXIT_CODES).includes(error?.exitCode) ? error.exitCode :
      CORE_EXIT_CODES.INTERNAL;
  const code=typeof error?.code==="string" && /^[A-Z][A-Z0-9_]*$/.test(error.code) ?
    error.code : "COMMAND_FAILED";
  const message=typeof error?.message==="string" && /\S/.test(error.message) ?
    error.message : "Core CLI failed";
  return Object.freeze({exitCode,result:failureResult({code,message})});
}

async function coreContext(runtimeProvider,request) {
  if (runtimeProvider===undefined) return Object.freeze({});
  if (typeof runtimeProvider!=="function" || utilTypes.isProxy(runtimeProvider)) {
    throw new TypeError("core runtimeProvider must be a non-proxy function");
  }
  const provided=ownDataRecord(
    await Reflect.apply(runtimeProvider,undefined,[request]),
    "core runtime provider result",new Set(["handlers","prompt","services"]),
  );
  const context=Object.create(null);
  if (Object.hasOwn(provided,"handlers")) context.handlers=provided.handlers;
  if (Object.hasOwn(provided,"services")) context.services=provided.services;
  if (Object.hasOwn(provided,"prompt")) {
    if (typeof provided.prompt!=="function" || utilTypes.isProxy(provided.prompt)) {
      throw new TypeError("core runtime prompt must be a non-proxy function");
    }
    context.prompt=provided.prompt;
  }
  return Object.freeze(context);
}

function wantsJson(argv) {
  return Array.isArray(argv) && argv.some(value => value==="--json");
}

function topLevelOutput(argv) {
  if (!Array.isArray(argv) || argv.length!==1 || typeof argv[0]!=="string") return null;
  if (argv[0]==="--help" || argv[0]==="-h") return CORE_HELP;
  if (argv[0]==="--version" || argv[0]==="-v") return CORE_PACKAGE_VERSION;
  return null;
}

export async function runCoreCli(argv,{cwd,stdin,stdout,stderr,runtimeProvider}={}) {
  let json=wantsJson(argv);
  let dispatched;
  try {
    if (typeof cwd!=="string" || cwd.trim().length===0) {
      throw new TypeError("core CLI cwd must be a non-blank path");
    }
    assertWriter(stdout,"core CLI stdout");
    assertWriter(stderr,"core CLI stderr");
    const topLevel=topLevelOutput(argv);
    if (topLevel!==null) {
      stdout.write(topLevel+"\n");
      return CORE_EXIT_CODES.SUCCESS;
    }
    const command=parseCoreCommand(argv);
    json=command.options.json;
    const request=Object.freeze({cwd,stdin,command});
    const context=await coreContext(runtimeProvider,request);
    const {prompt,...dispatchContext}=context;
    if (command.options.apply && command.interactive &&
        ["init","repo.add","release.plan","release.activate"].includes(command.name)) {
      if (typeof prompt!=="function") {
        throw new CoreCliError(
          "CONFIRMATION_REQUIRED",
          "Interactive apply requires an injected confirmation capability",
          CORE_EXIT_CODES.BLOCKED,
        );
      }
      dispatchContext.confirm=async preview => Reflect.apply(prompt,undefined,[Object.freeze({kind:"confirm-apply",command,preview})]);
    }
    dispatched=await dispatchCoreCommand(command,dispatchContext);
  } catch (error) {
    dispatched=renderFailure(error);
  }
  const rendered=json ? renderCommandJson(dispatched.result) : renderCommandHuman(dispatched.result);
  const target=json || dispatched.result.ok ? stdout : stderr;
  target.write(rendered+"\n");
  return dispatched.exitCode;
}
