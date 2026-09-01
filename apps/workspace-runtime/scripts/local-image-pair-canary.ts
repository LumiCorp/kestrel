import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  KestrelClient,
  type KestrelRequestContext,
} from "@kestrel-agents/sdk/runner";
import {
  ENVIRONMENT_ROUTER_AUDIENCE,
  PREVIEW_EDGE_AUTHORIZATION_HEADER,
  PREVIEW_EDGE_ROUTE_TICKET_AUDIENCE,
  PREVIEW_EDGE_ROUTE_TICKET_VERSION,
  PREVIEW_RELAY_TICKET_AUDIENCE,
  PREVIEW_RELAY_TICKET_VERSION,
  signEnvironmentExecutionTicket,
  signPreviewEdgeRouteTicket,
  signPreviewRelayTicket,
} from "@lumi/kestrel-environment-auth";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const openRouterApiKey = requiredEnvironment("OPENROUTER_API_KEY");
const openRouterBaseUrl = normalizeOpenRouterBaseUrl(
  process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai",
);
const rawModelId = "openai/gpt-5.6-luna";
const suffix = randomUUID().slice(0, 8);
const selectedImages = parseSelectedImages(process.argv.slice(2));
const workspaceImage =
  selectedImages?.workspaceImage ?? `kestrel-workspace-qualification:${suffix}`;
const routerImage =
  selectedImages?.routerImage ?? `kestrel-router-qualification:${suffix}`;
const workspaceContainer = `kestrel-workspace-qualification-${suffix}`;
const routerContainer = `kestrel-router-qualification-${suffix}`;
const workspaceVolume = `kestrel-workspace-qualification-${suffix}`;
const network = `kestrel-image-pair-${suffix}`;
const fixtureRoot = await mkdtemp(
  path.join(tmpdir(), "kestrel-local-image-pair-"),
);
const gatewayConfigPath = path.join(fixtureRoot, "gateway-config.json");
const gatewayModePath = path.join(fixtureRoot, "gateway-mode.txt");
const routerFixturePath = path.join(fixtureRoot, "router-fixture.mjs");
const marker = `local-image-pair-${suffix}`;
const previewMarker = `local-image-preview-${suffix}`;
const previewHostname = `preview-${suffix}.local.test`;
const previewPort = 4174;
const previewId = randomUUID();
const gatewayId = `gateway-${suffix}`;
const identities = {
  organizationId: `org-${suffix}`,
  environmentId: `environment-${suffix}`,
  workspaceId: `workspace-${suffix}`,
  threadId: `thread-${suffix}`,
  actorId: `actor-${suffix}`,
  agentId: "kestrel-one",
  appName: `kestrel-env-${suffix}`,
  machineId: `machine-${suffix}`,
  runId: `run-${suffix}`,
};
const workspaceServiceToken = randomUUID();
const gatewayServiceToken = randomUUID();
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateKeyPem = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const publicKeyPem = publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const failures: string[] = [];
let workspaceUrl: URL | undefined;
let routerUrl: URL | undefined;
let applicationId: string | undefined;
let applicationProcessId: number | undefined;
let managedWorktree = "";
let workspaceImageId = "";
let routerImageId = "";
let fatalError: unknown;

try {
  if (!selectedImages) {
    progress("Building the exact Workspace Runtime image");
    await buildImage("apps/workspace-runtime/Dockerfile", workspaceImage);
    progress("Building the exact Environment Router image");
    await buildImage("apps/environment-router/Dockerfile", routerImage);
  } else {
    progress("Using the operator-selected Workspace Runtime and Router images");
  }
  workspaceImageId = await imageId(workspaceImage);
  routerImageId = await imageId(routerImage);

  progress("Seeding an unpinned Git project in a Linux named volume");
  await docker("volume", "create", workspaceVolume);
  await seedWorkspaceVolume();
  await prepareRouterFixture();
  await docker("network", "create", network);

  progress("Starting the production-sized Workspace and Router pair");
  await startWorkspaceContainer();
  await startRouterContainer();
  const workspacePort = await publishedPort(workspaceContainer, 43_104);
  const routerPort = await publishedPort(workspaceContainer, 8080);
  workspaceUrl = new URL(`http://127.0.0.1:${workspacePort}`);
  routerUrl = new URL(`http://127.0.0.1:${routerPort}`);
  await Promise.all([
    waitForHealth(new URL("/health", workspaceUrl), workspaceContainer),
    waitForHealth(new URL("/health", routerUrl), routerContainer),
  ]);

  progress("Running one hosted OpenRouter turn through the inner runner");
  const runProof = await runHostedProviderProof(routerUrl);
  managedWorktree = runProof.managedWorktree;
  await verify("hosted turn completed", () =>
    assert.equal(runProof.terminalType, "run.completed"),
  );
  await verify("exactly one exec_command completed", () =>
    assert.equal(runProof.completedExecCommands, 1),
  );
  await verify("no exec_command failed", () =>
    assert.equal(runProof.failedExecCommands, 0),
  );
  await verify("unpinned project uses pnpm 9.12.2", () =>
    assert.equal(runProof.pnpmVersion, "9.12.2"),
  );
  await verify("execution uses a managed worktree", () => {
    assert.notEqual(managedWorktree, "/workspace");
    assert.match(managedWorktree, /^\/workspace\/\.kestrel\//u);
  });
  await verify("managed worktree is a real Git worktree", async () => {
    const topLevel = await docker(
      "exec",
      workspaceContainer,
      "git",
      "-C",
      managedWorktree,
      "rev-parse",
      "--show-toplevel",
    );
    assert.equal(topLevel.trim(), managedWorktree);
  });
  await verify("the hosted command has executed only once", async () => {
    assert.equal(await executionCount(), 1);
  });

  progress("Starting Vite from that exact managed worktree");
  const authorization = `Bearer ${signExecutionTicket()}`;
  const created = await requestJson<{
    application?: { id?: string; status?: string; processId?: number | null };
  }>(new URL("/v1/apps", routerUrl), {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({
      name: "Local Router/Workspace qualification",
      command: applicationCommand(),
      workingDirectory: workspaceRelativePath(managedWorktree),
      port: previewPort,
    }),
  });
  applicationId = created.application?.id;
  applicationProcessId = created.application?.processId ?? undefined;
  assert.ok(
    applicationId,
    "Workspace image did not create the Vite application.",
  );
  assert.ok(
    applicationProcessId,
    "Workspace image did not report the Vite process ID.",
  );
  await waitForApplication(routerUrl, authorization, applicationId, "running");
  await waitForPreview(routerUrl);

  const rootResponse = await previewRequest(routerUrl, "/");
  const clientResponse = await previewRequest(routerUrl, "/@vite/client");
  const environmentResponse = await previewRequest(
    routerUrl,
    "/child-environment-proof.json",
  );
  await verify("Preview root routes through Router and Workspace", () => {
    assert.equal(rootResponse.status, 200);
    assert.match(rootResponse.body, new RegExp(previewMarker, "u"));
  });
  await verify("Vite client routes through Router and Workspace", () => {
    assert.equal(clientResponse.status, 200);
    assert.match(clientResponse.body, /createHotContext/u);
  });
  await verify("application child environment is sanitized", () => {
    assert.equal(environmentResponse.status, 200);
    const proof = JSON.parse(environmentResponse.body) as {
      leaked?: string[];
      retained?: Record<string, boolean>;
    };
    assert.deepEqual(proof.leaked, []);
    assert.deepEqual(proof.retained, {
      COREPACK_HOME: true,
      PATH: true,
      PORT: true,
      userVariable: true,
    });
  });
  await verify("Vite WebSocket upgrades through both images", async () => {
    await assertWebSocketUpgrade(routerUrl!, clientResponse.body);
  });

  progress("Proving application stop, runner replacement, and persistence");
  await requestJson(
    new URL(`/v1/apps/${encodeURIComponent(applicationId)}/stop`, routerUrl),
    { method: "POST", headers: { authorization } },
  );
  await waitForApplication(routerUrl, authorization, applicationId, "stopped");
  await verify("application process tree is gone", async () => {
    assert.equal(
      await dockerSucceeds(
        "exec",
        workspaceContainer,
        "ps",
        "-p",
        String(applicationProcessId),
      ),
      false,
    );
  });
  await verify("application port is released", async () => {
    const response = await fetch(
      new URL(`/v1/preview-ports/${previewPort}`, routerUrl),
      { headers: { authorization } },
    );
    assert.equal(response.status, 409);
  });
  await requestJson(
    new URL(`/v1/apps/${encodeURIComponent(applicationId)}/start`, routerUrl),
    { method: "POST", headers: { authorization } },
  );
  await waitForApplication(routerUrl, authorization, applicationId, "running");
  await waitForPreview(routerUrl);

  const startingBefore = await runnerStartingGenerations();
  await killInnerRunner();
  await waitForHealth(new URL("/health", workspaceUrl), workspaceContainer);
  await sleep(1_000);
  const startingAfter = await runnerStartingGenerations();
  await verify("one inner runner replacement becomes healthy", () => {
    assert.equal(startingAfter.length, startingBefore.length + 1);
    assert.equal(startingAfter.at(-1), (startingBefore.at(-1) ?? 0) + 1);
  });
  await verify("stored session survives inner runner replacement", async () => {
    await describeStoredSession(routerUrl!);
  });

  progress("Restarting both containers on the same named volume");
  await docker("stop", routerContainer);
  await docker("restart", workspaceContainer);
  const restartedWorkspacePort = await publishedPort(
    workspaceContainer,
    43_104,
  );
  const restartedRouterPort = await publishedPort(workspaceContainer, 8080);
  workspaceUrl = new URL(`http://127.0.0.1:${restartedWorkspacePort}`);
  routerUrl = new URL(`http://127.0.0.1:${restartedRouterPort}`);
  await waitForHealth(new URL("/health", workspaceUrl), workspaceContainer);
  await docker("start", routerContainer);
  await waitForHealth(new URL("/health", routerUrl), routerContainer);
  await waitForApplication(routerUrl, authorization, applicationId, "running");
  await waitForPreview(routerUrl);
  await verify("stored session survives container restart", async () => {
    await describeStoredSession(routerUrl!);
  });
  await verify("Preview survives container restart", async () => {
    const response = await previewRequest(routerUrl!, "/");
    assert.equal(response.status, 200);
    assert.match(response.body, new RegExp(previewMarker, "u"));
  });
  await verify("the failed turn was not replayed", async () => {
    assert.equal(await executionCount(), 1);
  });

  progress("Forcing one hung Router config request and retrying it");
  await writeFile(gatewayModePath, "hang\n");
  const timeoutStartedAt = Date.now();
  const timedOutRefresh = await fetch(
    new URL("/internal/config/refresh", routerUrl),
    {
      method: "POST",
      headers: { authorization },
      signal: AbortSignal.timeout(10_000),
    },
  );
  const timeoutDurationMs = Date.now() - timeoutStartedAt;
  await verify(
    "hung Router config refresh returns after its five-second deadline",
    () => {
      assert.equal(timedOutRefresh.status, 503);
      assert.ok(timeoutDurationMs >= 4_500 && timeoutDurationMs < 9_000);
    },
  );
  await writeFile(gatewayModePath, "ready\n");
  const recoveredRefresh = await fetch(
    new URL("/internal/config/refresh", routerUrl),
    { method: "POST", headers: { authorization } },
  );
  await verify("a subsequent Router config refresh succeeds", () =>
    assert.equal(recoveredRefresh.status, 200),
  );

  if (failures.length > 0) {
    throw new Error(
      `Local qualification assertions failed:\n${failures.join("\n")}`,
    );
  }
} catch (error) {
  fatalError = error;
} finally {
  if (fatalError || failures.length > 0) {
    const [workspaceLogs, routerLogs, applicationDiagnostics] =
      await Promise.all([
        docker("logs", workspaceContainer).catch(
          () => "workspace logs unavailable",
        ),
        docker("logs", routerContainer).catch(() => "router logs unavailable"),
        readApplicationDiagnostics().catch(
          () => "application diagnostics unavailable",
        ),
      ]);
    process.stderr.write(
      `\n--- Workspace logs ---\n${workspaceLogs}\n--- Router logs ---\n${routerLogs}\n--- Application diagnostics ---\n${applicationDiagnostics}\n`,
    );
  }
  await cleanup();
}

if (fatalError) throw fatalError;

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      workspaceImage,
      workspaceImageId,
      routerImage,
      routerImageId,
      imageSource: selectedImages ? "prebuilt" : "built_by_canary",
      rawModelId,
      managedWorktree,
      proofs: [
        "workspace_and_router_health",
        "hosted_openrouter_run_through_inner_runner",
        "single_completed_exec_command",
        "unpinned_project_pnpm_9.12.2",
        "session_managed_git_worktree",
        "sanitized_application_environment",
        "vite_http_and_websocket_preview",
        "application_process_tree_and_port_release",
        "single_inner_runner_replacement",
        "same_volume_container_restart",
        "stored_session_visible_after_restart",
        "preview_visible_after_restart",
        "no_turn_replay",
        "gateway_config_timeout_and_retry",
        "complete_resource_cleanup",
      ],
    },
    null,
    2,
  )}\n`,
);

async function buildImage(dockerfile: string, tag: string) {
  await docker(
    "build",
    "--platform",
    "linux/amd64",
    "--file",
    dockerfile,
    "--tag",
    tag,
    "--build-arg",
    "KESTREL_BUILD_ID=local-qualification",
    ".",
  );
}

function parseSelectedImages(args: string[]) {
  if (args[0] === "--") args = args.slice(1);
  let workspaceImage: string | undefined;
  let routerImage: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1]?.trim();
    if (flag !== "--workspace-image" && flag !== "--router-image") {
      throw new Error(`Unknown local image-pair canary argument: ${flag}`);
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a Docker image reference.`);
    }
    if (flag === "--workspace-image") workspaceImage = value;
    if (flag === "--router-image") routerImage = value;
    index += 1;
  }
  if (!workspaceImage && !routerImage) return undefined;
  if (!workspaceImage || !routerImage) {
    throw new Error(
      "--workspace-image and --router-image must be provided together.",
    );
  }
  return { workspaceImage, routerImage };
}

async function seedWorkspaceVolume() {
  const seedScript = [
    'const fs = require("node:fs");',
    'fs.writeFileSync("/workspace/package.json", JSON.stringify({ private: true, scripts: { dev: "vite --host 0.0.0.0" }, devDependencies: { vite: "7.3.2" } }, null, 2) + "\\n");',
    `fs.writeFileSync("/workspace/index.html", ${JSON.stringify(`<!doctype html><html><body>${previewMarker}<script type="module" src="/src.js"></script></body></html>\n`)});`,
    `fs.writeFileSync("/workspace/src.js", ${JSON.stringify("document.body.dataset.qualification = 'ready';\n")});`,
    'fs.writeFileSync("/workspace/.gitignore", "node_modules/\\n.kestrel/\\n");',
  ].join("");
  await docker(
    "run",
    "--rm",
    "--platform",
    "linux/amd64",
    "--volume",
    `${workspaceVolume}:/workspace`,
    "--entrypoint",
    "node",
    workspaceImage,
    "-e",
    seedScript,
  );
  await docker(
    "run",
    "--rm",
    "--platform",
    "linux/amd64",
    "--volume",
    `${workspaceVolume}:/workspace`,
    "--workdir",
    "/workspace",
    "--entrypoint",
    "pnpm",
    workspaceImage,
    "install",
    "--prod=false",
    "--frozen-lockfile=false",
  );
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "Kestrel Qualification"],
    ["config", "user.email", "qualification@kestrel.invalid"],
    [
      "add",
      "package.json",
      "pnpm-lock.yaml",
      "index.html",
      "src.js",
      ".gitignore",
    ],
    ["commit", "-m", "qualification fixture"],
  ]) {
    await docker(
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "--volume",
      `${workspaceVolume}:/workspace`,
      "--entrypoint",
      "git",
      workspaceImage,
      "-C",
      "/workspace",
      ...args,
    );
  }
  const packageJson = await docker(
    "run",
    "--rm",
    "--platform",
    "linux/amd64",
    "--volume",
    `${workspaceVolume}:/workspace`,
    "--entrypoint",
    "node",
    workspaceImage,
    "-e",
    'process.stdout.write(require("node:fs").readFileSync("/workspace/package.json", "utf8"))',
  );
  assert.equal(
    Object.hasOwn(JSON.parse(packageJson) as object, "packageManager"),
    false,
    "The qualification project must not declare packageManager.",
  );
}

async function prepareRouterFixture() {
  const now = Math.floor(Date.now() / 1000);
  const relayTicket = signPreviewRelayTicket({
    privateKey: privateKeyPem,
    ticket: {
      version: PREVIEW_RELAY_TICKET_VERSION,
      audience: PREVIEW_RELAY_TICKET_AUDIENCE,
      organizationId: identities.organizationId,
      environmentId: identities.environmentId,
      workspaceId: identities.workspaceId,
      flyAppName: identities.appName,
      flyMachineId: identities.machineId,
      previewId,
      hostname: previewHostname,
      port: previewPort,
      issuedAt: now,
      expiresAt: now + 300,
      nonce: randomUUID(),
    },
  });
  const config = {
    version: 3,
    environmentId: identities.environmentId,
    revision: `local-image-pair-${suffix}`,
    workspaces: [
      {
        id: identities.workspaceId,
        machineId: identities.machineId,
        serviceTokenHash: createHash("sha256")
          .update(workspaceServiceToken)
          .digest("base64url"),
      },
    ],
    previews: [
      {
        id: previewId,
        workspaceId: identities.workspaceId,
        machineId: identities.machineId,
        hostname: previewHostname,
        port: previewPort,
        expiresAt: new Date((now + 3_600) * 1000).toISOString(),
        relayTicket,
      },
    ],
    modelGrants: [
      {
        runId: identities.runId,
        workspaceId: identities.workspaceId,
        gatewayId,
        rawModelId,
        provider: "openrouter",
        protocol: "openai",
        baseUrl: openRouterBaseUrl,
        apiKey: openRouterApiKey,
        credentialExpiresAt: new Date((now + 3_600) * 1000).toISOString(),
      },
    ],
    appGrants: [],
  };
  await Promise.all([
    writeFile(gatewayConfigPath, `${JSON.stringify(config)}\n`),
    writeFile(gatewayModePath, "ready\n"),
    writeFile(
      routerFixturePath,
      [
        'import { createServer } from "node:http";',
        'import { readFile } from "node:fs/promises";',
        `const expected = ${JSON.stringify(`Bearer ${gatewayServiceToken}`)};`,
        "const fixture = createServer(async (request, response) => {",
        '  if (request.url === "/api/runtime/environments/idle") { response.writeHead(202, { "content-type": "application/json" }); response.end("{}"); return; }',
        "  if (request.headers.authorization !== expected) { response.writeHead(401).end(); return; }",
        '  const mode = await readFile("/tmp/gateway-mode.txt", "utf8");',
        '  if (mode.trim() === "hang") return;',
        '  const config = await readFile("/tmp/gateway-config.json", "utf8");',
        '  response.writeHead(200, { "content-type": "application/json" });',
        "  response.end(config);",
        "});",
        'await new Promise((resolve, reject) => { fixture.once("error", reject); fixture.listen(18081, "127.0.0.1", resolve); });',
        'await import("file:///app/apps/environment-router/dist/server.js");',
      ].join("\n"),
    ),
  ]);
}

async function startWorkspaceContainer() {
  await docker(
    "run",
    "--detach",
    "--platform",
    "linux/amd64",
    "--name",
    workspaceContainer,
    "--network",
    network,
    "--network-alias",
    `${identities.machineId}.vm.${identities.appName}.internal`,
    "--cpus",
    "2",
    "--memory",
    "4g",
    "--publish",
    "127.0.0.1::43104",
    "--publish",
    "127.0.0.1::8080",
    "--volume",
    `${workspaceVolume}:/workspace`,
    "--env",
    `FLY_MACHINE_ID=${identities.machineId}`,
    "--env",
    "FLY_API_TOKEN=must-not-reach-children",
    "--env",
    "KESTREL_CONTROL_PLANE_URL=https://control.invalid",
    "--env",
    "KESTREL_ENABLE_MANAGED_WORKTREES=true",
    "--env",
    "KESTREL_ENVIRONMENT_GATEWAY_URL=http://127.0.0.1:8080",
    "--env",
    `KESTREL_ENVIRONMENT_ID=${identities.environmentId}`,
    "--env",
    "KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY=must-not-reach-children",
    "--env",
    `KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY=${publicKeyPem}`,
    "--env",
    "KESTREL_MANAGED_WORKTREE_ISOLATION=session",
    "--env",
    "KESTREL_ONE_CREDENTIAL_BROKER_TOKEN=must-not-reach-children",
    "--env",
    "KESTREL_QUALIFICATION_USER_VARIABLE=visible",
    "--env",
    "KESTREL_REQUIRE_MANAGED_WORKTREE=true",
    "--env",
    "KESTREL_RUNNER_SERVICE_TOKEN=must-not-reach-children",
    "--env",
    `KESTREL_ORGANIZATION_ID=${identities.organizationId}`,
    "--env",
    `KESTREL_WORKSPACE_ID=${identities.workspaceId}`,
    "--env",
    "KESTREL_WORKSPACE_ROOT=/workspace",
    "--env",
    `KESTREL_WORKSPACE_SERVICE_TOKEN=${workspaceServiceToken}`,
    workspaceImage,
  );
}

async function startRouterContainer() {
  await docker(
    "run",
    "--detach",
    "--platform",
    "linux/amd64",
    "--name",
    routerContainer,
    "--network",
    `container:${workspaceContainer}`,
    "--cpus",
    "1",
    "--memory",
    "512m",
    "--volume",
    `${gatewayConfigPath}:/tmp/gateway-config.json:ro`,
    "--volume",
    `${gatewayModePath}:/tmp/gateway-mode.txt:ro`,
    "--volume",
    `${routerFixturePath}:/tmp/router-fixture.mjs:ro`,
    "--env",
    `FLY_MACHINE_ID=${gatewayId}`,
    "--env",
    "KESTREL_CONTROL_PLANE_URL=http://127.0.0.1:18081",
    "--env",
    `KESTREL_ENVIRONMENT_APP_NAME=${identities.appName}`,
    "--env",
    `KESTREL_ENVIRONMENT_GATEWAY_SERVICE_TOKEN=${gatewayServiceToken}`,
    "--env",
    `KESTREL_ENVIRONMENT_ID=${identities.environmentId}`,
    "--env",
    `KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY=${publicKeyPem}`,
    "--entrypoint",
    "node",
    routerImage,
    "/tmp/router-fixture.mjs",
  );
}

async function runHostedProviderProof(baseUrl: URL) {
  const token = signExecutionTicket();
  const context: KestrelRequestContext = {
    actor: {
      actorId: identities.actorId,
      actorType: "end_user",
      tenantId: identities.organizationId,
    },
    tenantId: identities.organizationId,
  };
  const client = new KestrelClient({
    target: { kind: "remote", baseUrl: baseUrl.toString(), authToken: token },
  });
  try {
    const profile = await client.resolveExecutionProfile(
      {
        environmentPresetId: "workspace_hosted",
        managedConfiguration: {
          label: "Local image-pair qualification",
          modelProvider: "openrouter",
          model: rawModelId,
          agentStageConfig: { modelByStage: { "agent.loop": rawModelId } },
          modelTimeoutMs: 60_000,
          modelCredential: {
            source: "kestrel-one",
            runId: identities.runId,
            gatewayId,
            organizationId: identities.organizationId,
            environmentId: identities.environmentId,
            rawModelId,
            provider: "openrouter",
          },
          default: false,
        },
      },
      context,
    );
    const command = [
      'test -z "${KESTREL_ONE_CREDENTIAL_BROKER_TOKEN:-}"',
      'test -z "${KESTREL_WORKSPACE_SERVICE_TOKEN:-}"',
      'test -z "${KESTREL_RUNNER_SERVICE_TOKEN:-}"',
      'test -z "${KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY:-}"',
      'test -z "${FLY_API_TOKEN:-}"',
      "printf '1\\n' >> /workspace/.kestrel/local-qualification-executions",
      `printf 'QUAL_CWD=%s\\nQUAL_PNPM=%s\\nQUAL_MARKER=%s\\n' "$PWD" "$(pnpm --version)" ${shellQuote(marker)} | tee /workspace/.kestrel/local-qualification-proof`,
    ].join(" && ");
    const stream = client.streamRun(
      {
        profileId: profile.profileId,
        signal: AbortSignal.timeout(90_000),
        abortBehavior: "cancel",
        turn: {
          sessionId: identities.threadId,
          runId: identities.runId,
          message: `Run exactly one exec_command with this exact command: ${command}`,
          eventType: "user.message",
          noninteractive: true,
          interactionMode: "build",
          actSubmode: "full_auto",
          workspace: {
            managedWorktreeRequired: true,
            managedWorktreeIsolation: "session",
          },
        },
      },
      context,
    );
    const completedOutputs: unknown[] = [];
    const runEvidence: unknown[] = [];
    let completedExecCommands = 0;
    let failedExecCommands = 0;
    for await (const event of stream) {
      if (
        event.type === "run.tool.started" ||
        event.type === "run.tool.completed" ||
        event.type === "run.tool.failed"
      ) {
        runEvidence.push({ type: event.type, update: event.payload.update });
      } else if (event.type === "run.failed" || event.type === "runner.error") {
        runEvidence.push({ type: event.type, payload: event.payload });
      }
      if (
        event.type === "run.tool.completed" &&
        event.payload.update.toolName === "exec_command"
      ) {
        if (execCommandSucceeded(event.payload.update.output)) {
          completedExecCommands += 1;
          completedOutputs.push(event.payload.update.output);
        } else {
          failedExecCommands += 1;
        }
      }
      if (
        event.type === "run.tool.failed" &&
        event.payload.update.toolName === "exec_command"
      ) {
        failedExecCommands += 1;
      }
    }
    const terminal = await stream.result;
    if (completedExecCommands !== 1 || failedExecCommands !== 0) {
      throw new Error(
        `Hosted run did not complete exactly one exec_command: ${JSON.stringify({ terminal, runEvidence })}`,
      );
    }
    const persistedOutput = await docker(
      "exec",
      workspaceContainer,
      "cat",
      "/workspace/.kestrel/local-qualification-proof",
    ).catch((error) => {
      throw new Error(
        `The hosted exec_command did not persist its proof: ${JSON.stringify({ terminal, runEvidence, completedOutputs, error: error instanceof Error ? error.message : String(error) })}`,
      );
    });
    const outputText = [
      ...collectStrings(completedOutputs),
      persistedOutput,
    ].join("\n");
    const cwd = outputText.match(/QUAL_CWD=([^\r\n]+)/u)?.[1]?.trim();
    const pnpmVersion = outputText.match(/QUAL_PNPM=([^\r\n]+)/u)?.[1]?.trim();
    assert.ok(cwd, `exec_command output did not report its cwd: ${outputText}`);
    assert.ok(outputText.includes(`QUAL_MARKER=${marker}`));
    if (cwd === "/workspace") {
      const [sessionState, worktreeDirectories] = await Promise.all([
        client.getSessionState(identities.threadId, context),
        docker(
          "exec",
          workspaceContainer,
          "find",
          "/workspace/.kestrel",
          "-maxdepth",
          "8",
          "-type",
          "d",
          "-name",
          "worktrees",
        ).catch(() => ""),
      ]);
      throw new Error(
        `Managed-worktree execution fell back to /workspace: ${JSON.stringify({ sessionState, worktreeDirectories })}`,
      );
    }
    return {
      terminalType: terminal.type,
      completedExecCommands,
      failedExecCommands,
      managedWorktree: cwd,
      pnpmVersion,
    };
  } finally {
    await client.close();
  }
}

async function describeStoredSession(baseUrl: URL) {
  const client = new KestrelClient({
    target: {
      kind: "remote",
      baseUrl: baseUrl.toString(),
      authToken: signExecutionTicket(),
    },
  });
  try {
    const session = await client.describeSession(identities.threadId, {
      actor: {
        actorId: identities.actorId,
        actorType: "end_user",
        tenantId: identities.organizationId,
      },
      tenantId: identities.organizationId,
    });
    assert.equal(session.sessionId, identities.threadId);
  } finally {
    await client.close();
  }
}

function signExecutionTicket() {
  const now = Math.floor(Date.now() / 1000);
  return signEnvironmentExecutionTicket({
    privateKey: privateKeyPem,
    ticket: {
      version: 1,
      audience: ENVIRONMENT_ROUTER_AUDIENCE,
      organizationId: identities.organizationId,
      environmentId: identities.environmentId,
      workspaceId: identities.workspaceId,
      threadId: identities.threadId,
      runId: identities.runId,
      actorId: identities.actorId,
      agentId: identities.agentId,
      flyAppName: identities.appName,
      flyMachineId: identities.machineId,
      capabilities: [
        "events.subscribe",
        "gateway.config.refresh",
        "profile.read",
        "run.cancel",
        "run.stream",
        "session.read",
        "workspace.apps.read",
        "workspace.apps.write",
        "workspace.previews.read",
        "workspace.terminal.exec",
      ],
      issuedAt: now,
      expiresAt: now + 300,
      nonce: randomUUID(),
    },
  });
}

function previewAuthorization() {
  const now = Math.floor(Date.now() / 1000);
  return `Bearer ${signPreviewEdgeRouteTicket({
    privateKey: privateKeyPem,
    ticket: {
      version: PREVIEW_EDGE_ROUTE_TICKET_VERSION,
      audience: PREVIEW_EDGE_ROUTE_TICKET_AUDIENCE,
      organizationId: identities.organizationId,
      environmentId: identities.environmentId,
      workspaceId: identities.workspaceId,
      flyAppName: identities.appName,
      previewId,
      hostname: previewHostname,
      issuedAt: now,
      expiresAt: now + 300,
      nonce: randomUUID(),
    },
  })}`;
}

function applicationCommand() {
  const secretNames = [
    "KESTREL_ONE_CREDENTIAL_BROKER_TOKEN",
    "KESTREL_WORKSPACE_SERVICE_TOKEN",
    "KESTREL_RUNNER_SERVICE_TOKEN",
    "KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY",
    "FLY_API_TOKEN",
  ];
  const proofScript = [
    'const fs = require("node:fs");',
    `const names = ${JSON.stringify(secretNames)};`,
    "const leaked = names.filter((name) => process.env[name]);",
    "const retained = { COREPACK_HOME: Boolean(process.env.COREPACK_HOME), PATH: Boolean(process.env.PATH), PORT: Boolean(process.env.PORT), userVariable: process.env.KESTREL_QUALIFICATION_USER_VARIABLE === 'visible' };",
    'fs.writeFileSync("child-environment-proof.json", JSON.stringify({ leaked, retained }));',
  ].join("");
  return `node -e ${shellQuote(proofScript)} && exec /workspace/node_modules/.bin/vite --host 0.0.0.0 --port ${previewPort} --strictPort`;
}

async function killInnerRunner() {
  await docker(
    "exec",
    workspaceContainer,
    "/bin/sh",
    "-lc",
    'pid=$(pgrep -f \'[d]ist/cli/runner/service.js\' | head -n 1); test -n "$pid"; kill -KILL "$pid"',
  );
}

async function runnerStartingGenerations() {
  const logs = await docker("logs", workspaceContainer);
  return logs.split("\n").flatMap((line) => {
    try {
      const event = JSON.parse(line) as { type?: string; generation?: number };
      return event.type === "workspace.runner.starting" &&
        typeof event.generation === "number"
        ? [event.generation]
        : [];
    } catch {
      return [];
    }
  });
}

async function executionCount() {
  const output = await docker(
    "exec",
    workspaceContainer,
    "/bin/sh",
    "-lc",
    "test -f /workspace/.kestrel/local-qualification-executions && wc -l < /workspace/.kestrel/local-qualification-executions",
  );
  return Number.parseInt(output.trim(), 10);
}

function previewRequest(router: URL, pathname: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: Number(router.port),
        path: pathname,
        headers: {
          host: previewHostname,
          [PREVIEW_EDGE_AUTHORIZATION_HEADER]: previewAuthorization(),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end();
  });
}

async function assertWebSocketUpgrade(router: URL, viteClient: string) {
  const webSocketToken = viteClient.match(
    /const wsToken = ("(?:[^"\\]|\\.)*");/u,
  )?.[1];
  assert.ok(webSocketToken, "Vite client did not expose its HMR token.");
  const websocketPath = `/?token=${encodeURIComponent(
    JSON.parse(webSocketToken) as string,
  )}`;
  const socket = connect(Number(router.port), "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    [
      `GET ${websocketPath} HTTP/1.1`,
      `Host: ${previewHostname}`,
      `Origin: http://${previewHostname}`,
      `${PREVIEW_EDGE_AUTHORIZATION_HEADER}: ${previewAuthorization()}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Protocol: vite-hmr",
      "",
      "",
    ].join("\r\n"),
  );
  const response = await Promise.race([
    new Promise<Buffer>((resolve, reject) => {
      socket.once("data", resolve);
      socket.once("error", reject);
    }),
    sleep(10_000).then(() => {
      throw new Error("Vite WebSocket upgrade timed out.");
    }),
  ]);
  socket.destroy();
  assert.match(
    response.toString("utf8"),
    /^HTTP\/1\.1 101 Switching Protocols/u,
  );
}

async function waitForPreview(router: URL) {
  const deadline = Date.now() + 30_000;
  let last = "unavailable";
  while (Date.now() < deadline) {
    try {
      const response = await previewRequest(router, "/");
      last = `${response.status} ${response.body}`;
      if (response.status === 200 && response.body.includes(previewMarker))
        return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(150);
  }
  throw new Error(`Preview did not become ready: ${last}`);
}

async function waitForApplication(
  router: URL,
  authorization: string,
  id: string,
  expected: "running" | "stopped",
) {
  const deadline = Date.now() + 30_000;
  let lastStatus = "missing";
  while (Date.now() < deadline) {
    const payload = await requestJson<{
      applications?: Array<{ id?: string; status?: string }>;
    }>(new URL("/v1/apps", router), { headers: { authorization } });
    lastStatus =
      payload.applications?.find((application) => application.id === id)
        ?.status ?? "missing";
    if (lastStatus === expected) return;
    if (lastStatus === "failed") break;
    await sleep(100);
  }
  throw new Error(
    `Application did not become ${expected}; last status ${lastStatus}.`,
  );
}

async function waitForHealth(url: URL, container: string) {
  const deadline = Date.now() + 120_000;
  let last = "unavailable";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(6_000) });
      last = `${response.status} ${await response.text()}`;
      if (response.ok) return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  const logs = await docker("logs", container).catch(() => "logs unavailable");
  throw new Error(`${url} did not become healthy: ${last}\n${logs}`);
}

async function publishedPort(container: string, port: number) {
  const output = await docker("port", container, `${port}/tcp`);
  const match = output.trim().match(/:(\d+)$/u);
  if (!match?.[1])
    throw new Error(`Docker did not publish ${port} for ${container}.`);
  return Number(match[1]);
}

async function requestJson<T = unknown>(url: URL, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${url} failed (${response.status}): ${body}`,
    );
  }
  return JSON.parse(body) as T;
}

async function imageId(image: string) {
  return (
    await docker("image", "inspect", "--format", "{{.Id}}", image)
  ).trim();
}

async function verify(name: string, assertion: () => void | Promise<void>) {
  try {
    await assertion();
  } catch (error) {
    failures.push(
      `${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function cleanup() {
  await docker("rm", "-f", routerContainer).catch(() => undefined);
  await docker("rm", "-f", workspaceContainer).catch(() => undefined);
  await docker("network", "rm", network).catch(() => undefined);
  await docker("volume", "rm", workspaceVolume).catch(() => undefined);
  if (!selectedImages) {
    await docker("image", "rm", routerImage).catch(() => undefined);
    await docker("image", "rm", workspaceImage).catch(() => undefined);
  }
  await rm(fixtureRoot, { recursive: true, force: true });
}

async function docker(...args: string[]) {
  const result = await execFileAsync("docker", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: 20 * 60_000,
  });
  return result.stdout;
}

async function dockerSucceeds(...args: string[]) {
  try {
    await docker(...args);
    return true;
  } catch {
    return false;
  }
}

async function readApplicationDiagnostics() {
  if (!applicationId) return "application was not created";
  return docker(
    "exec",
    workspaceContainer,
    "node",
    "-e",
    [
      'const fs = require("node:fs");',
      `const id = ${JSON.stringify(applicationId)};`,
      'for (const file of ["/workspace/.kestrel/applications.json", `/workspace/.kestrel/application-${id}.log`]) {',
      "  process.stdout.write(`\\n>>> ${file}\\n`);",
      '  try { process.stdout.write(fs.readFileSync(file, "utf8")); } catch (error) { process.stdout.write(String(error)); }',
      "}",
    ].join(""),
  );
}

function workspaceRelativePath(absolute: string) {
  const relative = path.posix.relative("/workspace", absolute);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.posix.isAbsolute(relative)
  ) {
    throw new Error(`Managed worktree is outside /workspace: ${absolute}`);
  }
  return relative;
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value as Record<string, unknown>).flatMap(
    collectStrings,
  );
}

function execCommandSucceeded(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const output = value as Record<string, unknown>;
  return (
    output.status === "OK" ||
    (output.status === "completed" && output.exitCode === 0)
  );
}

function normalizeOpenRouterBaseUrl(value: string) {
  const url = new URL(value.trim());
  if (
    url.protocol !== "https:" &&
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "localhost"
  ) {
    throw new Error("OPENROUTER_BASE_URL must use HTTPS or a loopback host.");
  }
  const normalized = url.toString().replace(/\/+$/u, "");
  return normalized.endsWith("/api/v1")
    ? normalized.slice(0, -"/api/v1".length)
    : normalized;
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function progress(message: string) {
  process.stdout.write(`[local-image-pair] ${message}\n`);
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
