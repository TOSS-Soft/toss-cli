import assert from "node:assert/strict";
import {generateKeyPairSync} from "node:crypto";
import test from "node:test";

import {createDesignOrchestrator} from "../src/pipeline/design-orchestrator.js";
import {trustedDesignAuthorityRegistry} from "../src/pipeline/design-state-readiness.js";
import {authorityRegistry} from "./support/design-command-fixture.js";

const PRIVATE_KEY=`-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEICMMwUatUwxz9nHC1Z8Ycl5we3pAdGkWjX497KGuvT2y
-----END PRIVATE KEY-----`;

function withKey(publicKey) {
  const registry=authorityRegistry();
  registry.actors[0].public_key=publicKey;
  return registry;
}

test("shared design authority normalization matches orchestrator LF and CRLF PEM acceptance",() => {
  const lf=authorityRegistry().actors[0].public_key;
  for (const publicKey of [lf,lf.replaceAll("\n","\r\n")]) {
    const registry=withKey(publicKey);
    assert.doesNotThrow(() => createDesignOrchestrator({authorityRegistry:registry}));
    assert.doesNotThrow(() => trustedDesignAuthorityRegistry(registry));
  }
});

test("shared design authority normalization rejects lone CR, private, non-SPKI, multiple, and extra material",() => {
  const lf=authorityRegistry().actors[0].public_key;
  const {publicKey:rsa}=generateKeyPairSync("rsa",{modulusLength:2048});
  const invalid=[
    lf.replaceAll("\n","\r"),
    PRIVATE_KEY,
    rsa.export({format:"pem",type:"spki"}).toString(),
    `${lf}${lf}`,
    `${lf}extra material`,
  ];
  for (const publicKey of invalid) {
    const registry=withKey(publicKey);
    assert.throws(() => createDesignOrchestrator({authorityRegistry:registry}));
    assert.throws(() => trustedDesignAuthorityRegistry(registry));
  }
});

test("shared design authority normalization rejects accessors and proxies without reading traps",() => {
  let accessorReads=0;
  const accessor=authorityRegistry();
  Object.defineProperty(accessor.actors[0],"public_key",{
    enumerable:true,
    get() { accessorReads+=1; return authorityRegistry().actors[0].public_key; },
  });
  assert.throws(() => trustedDesignAuthorityRegistry(accessor));
  assert.equal(accessorReads,0);

  let proxyReads=0;
  const proxy=new Proxy(authorityRegistry(),{
    get(target,key,receiver) { proxyReads+=1; return Reflect.get(target,key,receiver); },
  });
  assert.throws(() => trustedDesignAuthorityRegistry(proxy));
  assert.equal(proxyReads,0);
});
