import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateProductContractPorts,
  cleanupProductContract,
  runProductContract,
} from "../../apps/web/scripts/run-product-contract.js";

test("product contract ports are unique and outside the default Linux ephemeral range", async () => {
  const ports = Object.values(await allocateProductContractPorts());

  assert.equal(new Set(ports).size, ports.length);
  for (const port of ports) {
    assert.ok(port >= 20_000);
    assert.ok(port <= 29_999);
  }
});

test("product contract launcher always cleans up its isolated compose project", async () => {
  const events: string[] = [];

  const result = await runProductContract({
    runSuite: async () => {
      events.push("run");
      return 0;
    },
    cleanup: async (context) => {
      events.push(`cleanup:${context.environment.COMPOSE_PROJECT_NAME}`);
    },
  });

  assert.equal(result, 0);
  assert.equal(events[0], "run");
  assert.match(
    events[1] ?? "",
    /^cleanup:kestrel-one-product-contract-\d+-\d+$/u
  );
});

test("product contract launcher cleans up when the suite fails", async () => {
  let cleanedUp = false;

  await assert.rejects(
    runProductContract({
      runSuite: () => Promise.reject(new Error("suite failed")),
      cleanup: async () => {
        cleanedUp = true;
      },
    }),
    /suite failed/u
  );

  assert.equal(cleanedUp, true);
});

test("product contract cleanup tears down the matching compose project", async () => {
  const calls: unknown[][] = [];
  const environment = {
    COMPOSE_PROJECT_NAME: "kestrel-one-product-contract-test",
  };

  await cleanupProductContract(
    { environment, webRoot: "/tmp/kestrel-one-product-contract-test" },
    (file, args, options) => {
      calls.push([file, args, options]);
      return Promise.resolve({ stderr: "", stdout: "" });
    }
  );

  assert.deepEqual(calls, [
    [
      "docker",
      ["compose", "down", "--volumes", "--remove-orphans"],
      {
        cwd: "/tmp/kestrel-one-product-contract-test",
        env: environment,
      },
    ],
  ]);
});
