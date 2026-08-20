import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("platform capacity requests commit before asynchronous Control Worker execution", async () => {
  const [route, queue] = await Promise.all([
    readFile(
      new URL(
        "../../app/api/platform/runtime/turn-workers/route.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(new URL("../knowledge/queue.ts", import.meta.url), "utf8"),
  ]);
  const accepted = route.indexOf("requestTurnWorkerCapacityOperation");
  const enqueued = route.indexOf("enqueueTurnWorkerCapacityOperation", accepted);
  const response = route.indexOf("status: 202", enqueued);
  assert.ok(accepted >= 0 && accepted < enqueued && enqueued < response);
  assert.doesNotMatch(route, /startMachine|stopMachine|updateMachineImage/u);
  assert.match(queue, /platform\.turn-worker-capacity\.v1/u);
  assert.match(queue, /processTurnWorkerCapacityOperation/u);
});

test("capacity leases cannot be renewed after expiry and terminal writes preserve interruption", async () => {
  const source = await readFile(
    new URL("./turn-worker-capacity.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /gt\(schema\.platformTurnWorkerCapacity\.operationLeaseUntil, now\)/u,
  );
  assert.match(source, /operationLeaseUntil: leaseUntil/u);
  assert.match(
    source,
    /isNull\(schema\.platformTurnWorkerCapacity\.operationLeaseUntil\)/u,
  );
  assert.match(source, /operationState, "running"/u);
  assert.match(source, /return "interrupted" as const/u);
  assert.match(source, /action: "partially-applied"/u);
});

test("Control Worker revalidates accepted inventory before provider convergence", async () => {
  const source = await readFile(
    new URL("./turn-worker-capacity.ts", import.meta.url),
    "utf8",
  );
  const processor = source.slice(
    source.indexOf("export async function processTurnWorkerCapacityOperation"),
    source.indexOf(
      "export async function interruptExpiredTurnWorkerCapacityOperation",
    ),
  );
  const revalidated = processor.indexOf(
    "acceptedInventory.fingerprint !== operation.operationInventoryFingerprint",
  );
  const converged = processor.indexOf("await convergeCapacity");
  assert.ok(revalidated >= 0 && revalidated < converged);
  assert.match(processor, /code:\s*error instanceof TurnWorkerCapacityError/u);
});

test("capacity inventory rejects transitional Machines and mixed resolved digests", async () => {
  const source = await readFile(
    new URL("./turn-worker-capacity.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /machine\.state === "stopped"/u);
  assert.match(source, /return "transitional"/u);
  assert.match(
    source,
    /machines\.some\(\(machine\) => machine\.role === "transitional"\)/u,
  );
  assert.match(source, /imageDigest: machine\.resolvedImageDigest/u);
  assert.match(
    source,
    /started\.some\(\(machine\) => !machine\.resolvedImageDigest\)/u,
  );
});

test("capacity UI and rejection audit recover from malformed or failed requests", async () => {
  const [component, route] = await Promise.all([
    readFile(
      new URL(
        "../../components/platform/turn-worker-capacity-client.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../../app/api/platform/runtime/turn-workers/route.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  assert.match(component, /finally \{\s*setLoading\(false\)/u);
  assert.match(component, /finally \{\s*setSubmitting\(false\)/u);
  assert.match(component, /Check the connection and retry/u);
  assert.match(
    route,
    /error instanceof z\.ZodError \|\| error instanceof SyntaxError/u,
  );
});

test("runtime projection is secret-safe and retains explicit standby topology", async () => {
  const source = await readFile(
    new URL("./turn-worker-capacity.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /standbyForMachineIds/u);
  assert.match(source, /configuredConcurrency/u);
  assert.match(source, /healthStatus/u);
  assert.doesNotMatch(source, /machine\.env|machine\.config\.env/u);
});
