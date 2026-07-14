import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the durable turn image builds workspace runtime dependencies", async () => {
  const [dockerfile, dockerignore, packageJsonSource] = await Promise.all([
    readFile(
      new URL(
        "../../../../deploy/fly/kestrel-one-turn-worker/Dockerfile",
        import.meta.url
      ),
      "utf8"
    ),
    readFile(
      new URL(
        "../../../../deploy/fly/kestrel-one-turn-worker/Dockerfile.dockerignore",
        import.meta.url
      ),
      "utf8"
    ),
    readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ]);
  const packageJson = JSON.parse(packageJsonSource) as {
    scripts?: Record<string, string>;
  };

  assert.match(dockerfile, /RUN pnpm run web:prepare/u);
  assert.ok(
    dockerfile.indexOf("ENV NODE_ENV=production") >
      dockerfile.indexOf("RUN pnpm run web:prepare")
  );
  assert.match(dockerignore, /^runs$/mu);
  assert.match(dockerignore, /^tmp$/mu);
  assert.match(dockerignore, /^\.pnpm-store$/mu);
  assert.equal(
    packageJson.scripts?.["worker:turns"],
    "node --import ./scripts/register-server-only.mjs --import tsx scripts/turn-worker.ts"
  );
});

test("an exhausted queue job fails its durable turn visibly", async () => {
  const queueSource = await readFile(
    new URL("./queue.ts", import.meta.url),
    "utf8"
  );

  assert.match(queueSource, /job\.retryCount >= job\.retryLimit/u);
  assert.match(queueSource, /failureCode: "TURN_DISPATCH_FAILED"/u);
  assert.match(queueSource, /await completeDurableThreadTurn\(/u);
});

test("terminal pg-boss jobs cannot block durable turn recovery", async () => {
  const queueSource = await readFile(
    new URL("./queue.ts", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(queueSource, /singletonKey:\s*turnId/u);
  assert.match(queueSource, /if \(!jobId\)/u);
});

test("the worker entrypoint starts without top-level await", async () => {
  const workerSource = await readFile(
    new URL("../../scripts/turn-worker.ts", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(workerSource, /^await startDurableThreadTurnWorker/mu);
  assert.match(workerSource, /void main\(\)\.catch/u);
});
