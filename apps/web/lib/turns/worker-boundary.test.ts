import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "the durable turn image builds workspace runtime dependencies", async () => {
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
  assert.match(dockerignore, /^apps\/web\/\.next$/mu);
  assert.match(dockerignore, /^apps\/web\/node_modules$/mu);
  assert.equal(
    packageJson.scripts?.["worker:turns"],
    "node --import ./scripts/register-server-only.mjs --import tsx scripts/turn-worker.ts"
  );
  assert.equal((packageJson as { type?: string }).type, "module");
});

contractTest("web.hermetic", "an exhausted queue job fails its durable turn visibly", async () => {
  const queueSource = await readFile(
    new URL("./queue.ts", import.meta.url),
    "utf8"
  );

  assert.match(queueSource, /input\.retryCount < input\.retryLimit/u);
  assert.match(queueSource, /failureCode: "TURN_DISPATCH_FAILED"/u);
  assert.match(queueSource, /await finalizeExhaustedDurableTurnJob\(/u);
});

contractTest("web.hermetic", "the running worker reconciles missing jobs and interrupted turns", async () => {
  const queueSource = await readFile(
    new URL("./queue.ts", import.meta.url),
    "utf8"
  );

  assert.match(queueSource, /await reconcileDurableThreadTurnQueueWithBoss/u);
  assert.match(queueSource, /NONTERMINAL_JOB_STATES/u);
  assert.match(queueSource, /await dispatchTurnOrFail\(/u);
  assert.match(queueSource, /failureCode: "TURN_WORKER_INTERRUPTED"/u);
});

contractTest("web.hermetic", "terminal pg-boss jobs cannot block durable turn recovery", async () => {
  const queueSource = await readFile(
    new URL("./queue.ts", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(queueSource, /singletonKey:\s*turnId/u);
  assert.match(queueSource, /if \(!jobId\)/u);
});

contractTest("web.hermetic", "the worker entrypoint starts without top-level await", async () => {
  const workerSource = await readFile(
    new URL("../../scripts/turn-worker.ts", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(workerSource, /^await startDurableThreadTurnWorker/mu);
  assert.match(workerSource, /void main\(\)\.catch/u);
});

contractTest("web.hermetic", "dev:all supervises the durable turn worker with the app", async () => {
  const devAllSource = await readFile(
    new URL("../../scripts/dev-all.sh", import.meta.url),
    "utf8"
  );

  assert.match(devAllSource, /pnpm worker:turns &/u);
  assert.match(devAllSource, /run runner:service &/u);
  assert.match(
    devAllSource,
    /KESTREL_DISABLE_DOTENV=1 DATABASE_URL="\$KESTREL_RUNNER_DATABASE_URL"[\s\\]*pnpm --dir "\$ROOT_DIR\/\.\.\/\.\." run db:migrate/u
  );
  assert.match(devAllSource, /RUNNER_PID=\$!/u);
  assert.match(
    devAllSource,
    /export KESTREL_ENVIRONMENT_RUNTIME="\$\{KESTREL_ENVIRONMENT_RUNTIME:-local\}"/u
  );
  assert.match(devAllSource, /TURN_WORKER_PID=\$!/u);
  assert.match(
    devAllSource,
    /export REDIS_URL="\$\{REDIS_URL:-redis:\/\/127\.0\.0\.1:\$\{LOCAL_REDIS_PORT:-56379\}\}"/u
  );
  assert.match(devAllSource, /monitor_app_processes/u);
  assert.match(devAllSource, /kill -0 "\$TURN_WORKER_PID"/u);
  assert.match(devAllSource, /kill -0 "\$RUNNER_PID"/u);
  assert.ok(
    devAllSource.indexOf('log "Starting durable turn worker"') <
      devAllSource.indexOf('log "Ready at http://')
  );
});
