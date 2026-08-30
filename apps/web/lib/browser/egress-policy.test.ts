import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_EFFECTIVE_DOMAIN_AUTHORITY_VERSION,
  BROWSER_PUBLIC_DOMAIN_AUTHORITY_VERSION,
  type BrowserEffectiveDomainAuthorityV1,
} from "../../../../src/browser/domainAuthority.js";
import {
  HOSTED_BROWSER_NETWORK_KINDS,
  HostedBrowserEgressAuthority,
} from "./egress-policy";

function authority(revision = "revision-1"): BrowserEffectiveDomainAuthorityV1 {
  return {
    version: BROWSER_EFFECTIVE_DOMAIN_AUTHORITY_VERSION,
    environmentId: "env-1",
    projectId: "project-1",
    userId: "user-1",
    enabledModes: ["operator"],
    personalGrantsEnabled: true,
    publicDomains: [
      {
        version: BROWSER_PUBLIC_DOMAIN_AUTHORITY_VERSION,
        scheme: "https",
        canonicalDomain: "example.com",
        includeSubdomains: true,
        port: 443,
      },
    ],
    qaTarget: null,
    effectiveAllowlistRevision: revision,
  };
}

test("every browser request kind uses one HTTPS allowlist and public-address check", async () => {
  const resolved: string[] = [];
  const proxy = new HostedBrowserEgressAuthority({
    authority: authority(),
    resolve: async (hostname) => {
      resolved.push(hostname);
      return [{ address: "93.184.216.34", family: 4 }];
    },
  });
  for (const kind of HOSTED_BROWSER_NETWORK_KINDS) {
    const result = await proxy.authorize({
      url: "https://assets.example.com/path?secret=hidden",
      kind,
      revision: "revision-1",
    });
    assert.equal(result.normalizedOrigin, "https://assets.example.com");
  }
  assert.equal(resolved.length, HOSTED_BROWSER_NETWORK_KINDS.length);
  await assert.rejects(
    proxy.authorize({
      url: "http://example.com",
      kind: "navigation",
      revision: "revision-1",
    }),
  );
  await assert.rejects(
    proxy.authorize({
      url: "https://other.example.net",
      kind: "redirect",
      revision: "revision-1",
    }),
  );
});

test("DNS rebinding and stale revisions fail closed", async () => {
  let privateResolution = false;
  const proxy = new HostedBrowserEgressAuthority({
    authority: authority(),
    resolve: async () => [
      privateResolution
        ? { address: "127.0.0.1", family: 4 as const }
        : { address: "93.184.216.34", family: 4 as const },
    ],
  });
  await proxy.authorize({
    url: "https://example.com",
    kind: "fetch",
    revision: "revision-1",
  });
  privateResolution = true;
  await assert.rejects(
    proxy.authorize({
      url: "https://example.com",
      kind: "fetch",
      revision: "revision-1",
    }),
  );
  await assert.rejects(
    proxy.authorize({
      url: "https://example.com",
      kind: "fetch",
      revision: "stale",
    }),
  );
});

test("revision installation closes long-lived connections before success", () => {
  const closed: string[] = [];
  const proxy = new HostedBrowserEgressAuthority({
    authority: authority(),
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  proxy.registerLongLivedConnection({
    connectionId: "socket-1",
    hostname: "example.com",
    revision: "revision-1",
    close: () => closed.push("socket-1"),
  });
  const installed = proxy.install(authority("revision-2"));
  assert.deepEqual(installed, {
    effectiveAllowlistRevision: "revision-2",
    closedUnauthorizedConnections: 1,
  });
  assert.deepEqual(closed, ["socket-1"]);
});
