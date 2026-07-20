import assert from "node:assert/strict";
import test from "node:test";
import { allocateProductContractPorts } from "../../apps/web/scripts/run-product-contract.js";

test("product contract ports are unique and outside the default Linux ephemeral range", async () => {
  const ports = Object.values(await allocateProductContractPorts());

  assert.equal(new Set(ports).size, ports.length);
  for (const port of ports) {
    assert.ok(port >= 20_000);
    assert.ok(port <= 29_999);
  }
});
