import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

function deny() {
  throw new Error("FORBIDDEN_NETWORK_ACCESS");
}

globalThis.fetch = deny;
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
net.connect = deny;
net.createConnection = deny;
tls.connect = deny;

const dnsMethods = [
  "lookup",
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse",
];

for (const method of dnsMethods) {
  if (typeof dns[method] === "function") dns[method] = deny;
  if (typeof dns.promises[method] === "function") dns.promises[method] = deny;
}

syncBuiltinESMExports();
