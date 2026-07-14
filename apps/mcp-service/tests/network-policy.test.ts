import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPublicResolvedAddresses,
  createPinnedMcpFetch,
} from "../src/network-policy.js";

test("remote MCP DNS policy accepts only entirely public resolutions", () => {
  assert.doesNotThrow(() =>
    assertPublicResolvedAddresses([
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "::ffff:8.8.8.8", family: 6 },
      { address: "::ffff:808:808", family: 6 },
    ]),
  );
  for (const address of [
    { address: "127.0.0.1", family: 4 as const },
    { address: "10.0.0.2", family: 4 as const },
    { address: "169.254.169.254", family: 4 as const },
    { address: "100.64.0.1", family: 4 as const },
    { address: "198.18.0.1", family: 4 as const },
    { address: "203.0.113.1", family: 4 as const },
    { address: "192.168.1.2", family: 4 as const },
    { address: "::1", family: 6 as const },
    { address: "fd00::1", family: 6 as const },
    { address: "fe80::1", family: 6 as const },
    { address: "2001:2::1", family: 6 as const },
    { address: "2001:db8::1", family: 6 as const },
    { address: "3fff::1", family: 6 as const },
    { address: "2002::1", family: 6 as const },
    { address: "ff02::1", family: 6 as const },
    { address: "::ffff:127.0.0.1", family: 6 as const },
    { address: "::ffff:7f00:1", family: 6 as const },
  ]) {
    assert.throws(
      () => assertPublicResolvedAddresses([address]),
      /non-public address/u,
      address.address,
    );
  }
});

test("remote MCP DNS policy rejects mixed public and private answers", () => {
  assert.throws(
    () =>
      assertPublicResolvedAddresses([
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    /non-public address/u,
  );
  assert.throws(() => assertPublicResolvedAddresses([]), /did not resolve/u);
});

test("remote MCP pinning resolves public IPv6 literals without URL brackets", async () => {
  let resolvedHostname: string | undefined;
  const pinned = await createPinnedMcpFetch({
    endpoint: new URL("https://[2606:4700:4700::1111]/mcp"),
    resolve: async (hostname) => {
      resolvedHostname = hostname;
      return [{ address: "2606:4700:4700::1111", family: 6 }];
    },
  });
  try {
    assert.equal(resolvedHostname, "2606:4700:4700::1111");
  } finally {
    await pinned.close();
  }
});
