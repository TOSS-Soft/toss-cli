import {execFile as execFileCallback} from "node:child_process";
import {promisify} from "node:util";

import {createCoreRuntime} from "./runtime.js";

export const DEFAULT_LOCAL_CONTROL_PATH=".toss-core-control";

function unavailable(message) {
  const error=new Error(message);
  error.code="COMMAND_NOT_IMPLEMENTED";
  error.exitCode=69;
  return error;
}

function localGitHub() {
  return Object.freeze({
    async snapshot(query) {
      if (query?.kind==="repository-list" && Array.isArray(query.repositories) &&
          query.repositories.length===0) {
        return Object.freeze({kind:"repository-list",revisions:Object.freeze([])});
      }
      throw unavailable("Local toss-core runtime does not provide GitHub access");
    },
    async inspect() {
      throw unavailable("Local toss-core runtime does not provide GitHub access");
    },
    async apply() {
      throw unavailable("Local toss-core runtime does not provide GitHub access");
    },
  });
}

/**
 * Compose the only runtime available to the shipped executable. It intentionally
 * supports local control reads only; remote, bootstrap, and mutation operations
 * must receive a future explicitly trusted adapter.
 */
export function createLocalCoreRuntimeProvider() {
  const execFile=promisify(execFileCallback);
  const github=localGitHub();
  return async ({cwd,command}) => Object.freeze({
    services:createCoreRuntime({
      cwd,
      controlPath:command.options.control ?? DEFAULT_LOCAL_CONTROL_PATH,
      execFile,
      github,
      clock:() => new Date().toISOString(),
      idGenerator:kind => `${kind.toUpperCase()}-LOCAL-UNAVAILABLE`,
      authorityRegistry:Object.freeze({}),
      policyRevision:() => "LOCAL-UNAVAILABLE",
    }),
  });
}
