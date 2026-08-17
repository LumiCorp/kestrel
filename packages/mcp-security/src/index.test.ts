import test from "node:test";
import assert from "node:assert/strict";

import {
  assertPublicMcpResolvedAddresses,
  assertPublicResolvedAddresses,
} from "./index.js";

test("generic and MCP compatibility exports enforce the same public address policy", () => {
  const publicAddresses = [{ address: "93.184.216.34", family: 4 as const }];
  assert.doesNotThrow(() => assertPublicResolvedAddresses(publicAddresses));
  assert.doesNotThrow(() => assertPublicMcpResolvedAddresses(publicAddresses));
  assert.throws(
    () => assertPublicResolvedAddresses([
      ...publicAddresses,
      { address: "127.0.0.1", family: 4 },
    ]),
    /non-public/u,
  );
});
