import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test(
  "the durable turn image builds workspace runtime dependencies",
  async () => {
    const [dockerfile, dockerignore, packageJsonSource] = await Promise.all([
      readFile(
        new URL(
          "../../../../deploy/fly/kestrel-one-turn-worker/Dockerfile",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../../../../deploy/fly/kestrel-one-turn-worker/Dockerfile.dockerignore",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ]);
    const packageJson = JSON.parse(packageJsonSource) as {
      scripts?: Record<string, string>;
    };

    assert.match(dockerfile, /RUN pnpm run web:prepare/u);
    assert.ok(
      dockerfile.indexOf("ENV NODE_ENV=production") >
        dockerfile.indexOf("RUN pnpm run web:prepare"),
    );
    assert.match(dockerignore, /^runs$/mu);
    assert.match(dockerignore, /^tmp$/mu);
    assert.match(dockerignore, /^\.pnpm-store$/mu);
    assert.match(dockerignore, /^apps\/web\/\.next$/mu);
    assert.match(dockerignore, /^apps\/web\/node_modules$/mu);
    assert.equal(
      packageJson.scripts?.["worker:turns"],
      "node --import ./scripts/register-server-only.mjs --import tsx scripts/turn-worker.ts",
    );
    assert.equal((packageJson as { type?: string }).type, "module");
  },
);
test(
  "an exhausted queue job fails its durable turn visibly",
  async () => {
    const queueSource = await readFile(
      new URL("./queue.ts", import.meta.url),
      "utf8",
    );

    assert.match(queueSource, /input\.retryCount < input\.retryLimit/u);
    assert.match(queueSource, /failureCode: "TURN_DISPATCH_FAILED"/u);
    assert.match(queueSource, /await finalizeExhaustedDurableTurnJob\(/u);
  },
);

test(
  "the running worker reconciles missing jobs and interrupted turns",
  async () => {
    const queueSource = await readFile(
      new URL("./queue.ts", import.meta.url),
      "utf8",
    );

    assert.match(queueSource, /await reconcileDurableThreadTurnQueueWithBoss/u);
    assert.match(queueSource, /NONTERMINAL_JOB_STATES/u);
    assert.match(queueSource, /await dispatchTurnOrReconcile\(/u);
    assert.match(queueSource, /failureCode: "TURN_WORKER_INTERRUPTED"/u);
  },
);

test(
  "Runtime event persistence reconciliation survives queue retry exhaustion",
  async () => {
    const [queueSource, runtimeSource] = await Promise.all([
      readFile(new URL("./queue.ts", import.meta.url), "utf8"),
      readFile(new URL("./process-runtime.ts", import.meta.url), "utf8"),
    ]);

    assert.match(
      queueSource,
      /runtimeEventReconciliationState === "pending"[\s\S]*return false/u,
    );
    assert.match(
      queueSource,
      /turn\.runtimeEventReconciliationState === "pending"[\s\S]*dispatchTurnOrReconcile/u,
    );
    assert.match(
      runtimeSource,
      /interruptedExecution\?\.runtimeEventReconciliationState === "pending"/u,
    );
    assert.match(
      runtimeSource,
      /markRuntimeEventReconciliationPending\(\{ turnId: turn\.id \}\)/u,
    );
  },
);

test(
  "durable turns use a long lease with worker heartbeats",
  async () => {
    const queueSource = await readFile(
      new URL("./queue.ts", import.meta.url),
      "utf8",
    );

    assert.match(queueSource, /DURABLE_TURN_EXPIRE_SECONDS = 12 \* 60 \* 60/u);
    assert.match(queueSource, /DURABLE_TURN_HEARTBEAT_SECONDS = 60/u);
    assert.match(queueSource, /DURABLE_TURN_HEARTBEAT_REFRESH_SECONDS = 30/u);
    assert.match(queueSource, /heartbeatRefreshSeconds:/u);
    assert.match(queueSource, /workerSignal: job\.signal/u);
    assert.match(queueSource, /retryCount: job\.retryCount/u);
  },
);

test(
  "a late worker lease signal cannot override a completed runtime outcome",
  async () => {
    const runtimeSource = await readFile(
      new URL("./process-runtime.ts", import.meta.url),
      "utf8",
    );

    assert.match(
      runtimeSource,
      /const completionStatus = terminalTurnStatus\(terminal\.status\)/u,
    );
    assert.doesNotMatch(
      runtimeSource,
      /const completionStatus = workerInterrupted/u,
    );
  },
);

test(
  "model authentication failures retain their normalized durable code",
  async () => {
    const [runtimeSource, storeSource] = await Promise.all([
      readFile(new URL("./process-runtime.ts", import.meta.url), "utf8"),
      readFile(new URL("./store.ts", import.meta.url), "utf8"),
    ]);

    assert.match(
      runtimeSource,
      /terminal\.errorCode === "MODEL_AUTH_ERROR"/u
    );
    assert.match(runtimeSource, /errorCode === "MODEL_AUTH_ERROR"/u);
    assert.match(
      storeSource,
      /invalidateTurnGatewayCredentialForAuthFailure/u
    );
    assert.match(
      storeSource,
      /schema\.environmentModelGrants\.gatewayCredentialRevision/u
    );
    assert.match(storeSource, /schema\.adminEventLogs/u);
    assert.match(storeSource, /gateway\.credential\.invalidated/u);
  }
);

test(
  "runtime execution binding is part of execution creation",
  async () => {
    const routeSource = await readFile(
      new URL("../environments/execution-route.ts", import.meta.url),
      "utf8",
    );

    assert.match(routeSource, /durableTurnId\?: string/u);
    assert.match(routeSource, /knowledgeDb\.transaction/u);
    assert.match(routeSource, /environmentExecutionId: input\.id/u);
    assert.match(routeSource, /Durable turn could not be bound/u);
  },
);

test(
  "user Stop has a bounded safe-boundary deadline",
  async () => {
    const [runtimeSource, storeSource] = await Promise.all([
      readFile(new URL("./process-runtime.ts", import.meta.url), "utf8"),
      readFile(new URL("./store.ts", import.meta.url), "utf8"),
    ]);

    assert.match(runtimeSource, /DURABLE_TURN_STOP_GRACE_MS/u);
    assert.match(runtimeSource, /scheduleCancellationDeadline/u);
    assert.match(runtimeSource, /isSafeInterruptBoundary/u);
    assert.match(runtimeSource, /status: stopped \? "cancelled" : "failed"/u);
    assert.match(storeSource, /interruptMode: "safe_boundary_deadline"/u);
    assert.match(storeSource, /interruptDeadlineAt:/u);
  },
);

test(
  "project context Redis failures stay inside the worker boundary",
  async () => {
    const source = await readFile(
      new URL("../projects/context-grants.ts", import.meta.url),
      "utf8",
    );

    assert.match(source, /redisClient\?\.isReady/u);
    assert.match(source, /client\.on\("error", discardClient\)/u);
    assert.match(source, /client\.on\("end", discardClient\)/u);
  },
);

test(
  "terminal pg-boss jobs cannot block durable turn recovery",
  async () => {
    const queueSource = await readFile(
      new URL("./queue.ts", import.meta.url),
      "utf8",
    );

    assert.doesNotMatch(queueSource, /singletonKey:\s*turnId/u);
    assert.match(queueSource, /if \(!jobId\)/u);
  },
);

test(
  "the worker entrypoint starts without top-level await",
  async () => {
    const workerSource = await readFile(
      new URL("../../scripts/turn-worker.ts", import.meta.url),
      "utf8",
    );

    assert.doesNotMatch(workerSource, /^await startDurableThreadTurnWorker/mu);
    assert.doesNotMatch(workerSource, /startEnvironmentLifecycleWorker/u);
    assert.match(workerSource, /getGatewayCredentialAuthorityReadiness/u);
    assert.match(workerSource, /Gateway credential readiness failed/u);
    assert.doesNotMatch(workerSource, /stopEnvironmentLifecycleWorker/u);
    assert.match(workerSource, /void main\(\)\.catch/u);
  },
);

test("the dedicated control worker owns release and lifecycle queues", async () => {
  const source = await readFile(
    new URL("../../scripts/control-worker.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /startEnvironmentLifecycleWorker/u);
  assert.match(source, /stopEnvironmentLifecycleWorker/u);
  assert.match(source, /releaseControllerHeartbeats/u);
  assert.match(source, /RELEASE_CONTROLLER_CONTRACT_REVISION/u);
});

test(
  "title failures remain non-blocking and emit a durable sanitized diagnostic",
  async () => {
    const source = await readFile(
      new URL("./process-runtime.ts", import.meta.url),
      "utf8",
    );

    assert.match(source, /TITLE_FAILURE_CODE_PATTERN/u);
    assert.match(source, /stage: "thread\.title\.failed"/u);
    assert.match(source, /appendDurableTurnEvent/u);
    assert.match(source, /return null;/u);
  },
);

test(
  "dev:all supervises the durable turn worker with the app",
  async () => {
    const devAllSource = await readFile(
      new URL("../../scripts/dev-all.sh", import.meta.url),
      "utf8",
    );

    assert.match(devAllSource, /pnpm worker:turns &/u);
    assert.match(devAllSource, /run runner:service &/u);
    assert.match(
      devAllSource,
      /KESTREL_DISABLE_DOTENV=1 DATABASE_URL="\$KESTREL_RUNNER_DATABASE_URL"[\s\\]*pnpm --dir "\$ROOT_DIR\/\.\.\/\.\." run db:migrate/u,
    );
    assert.match(devAllSource, /RUNNER_PID=\$!/u);
    assert.match(
      devAllSource,
      /export KESTREL_ENVIRONMENT_RUNTIME="\$\{KESTREL_ENVIRONMENT_RUNTIME:-local\}"/u,
    );
    assert.match(devAllSource, /TURN_WORKER_PID=\$!/u);
    assert.match(
      devAllSource,
      /export REDIS_URL="\$\{REDIS_URL:-redis:\/\/127\.0\.0\.1:\$\{LOCAL_REDIS_PORT:-56379\}\}"/u,
    );
    assert.match(devAllSource, /monitor_app_processes/u);
    assert.match(devAllSource, /kill -0 "\$TURN_WORKER_PID"/u);
    assert.match(devAllSource, /kill -0 "\$RUNNER_PID"/u);
    assert.ok(
      devAllSource.indexOf('log "Starting durable turn worker"') <
        devAllSource.indexOf('log "Ready at http://'),
    );
  },
);
