import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ENVIRONMENT_ROUTER_AUDIENCE,
  signEnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import {
  FlyMachinesClient,
  flyEnvironmentAppName,
  flyEnvironmentNetworkName,
} from "@/lib/environments/providers/fly-machines";

const execFileAsync = promisify(execFile);
const token = required("FLY_API_TOKEN");
const organizationSlug = required("KESTREL_FLY_ORGANIZATION_SLUG");
const routerImage = immutableImage("KESTREL_ENVIRONMENT_ROUTER_IMAGE");
const workspaceImage = immutableImage("KESTREL_WORKSPACE_RUNTIME_IMAGE");
const region = process.env.KESTREL_FLY_CANARY_REGION?.trim() || "iad";
const apiBaseUrl = "https://api.machines.dev/v1";
const provider = new FlyMachinesClient({ token, organizationSlug });
const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const environmentA = canaryIdentity();
const environmentB = canaryIdentity();
const createdApps: string[] = [];

try {
  const a = await provisionCanaryEnvironment(environmentA);
  const b = await provisionCanaryEnvironment(environmentB);
  await assertGatewayBoundary(a);
  await assertGatewayBoundary(b);
  await assertCrossNetworkIsolation(a, b);
  await assertPersistence(a);
  await assertBackupRestore(a);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      region,
      environments: [
        summarize(a),
        summarize(b),
      ],
      proofs: [
        "dedicated_custom_networks",
        "gateway_only_public_ingress",
        "signed_private_routing",
        "cross_network_dns_isolation",
        "stop_start_persistence",
        "replacement_volume_backup_restore",
        "idempotent_provider_ensure",
      ],
    })}\n`
  );
} finally {
  for (const appName of createdApps.reverse()) {
    await provider.deleteEnvironmentApp({ appName }).catch(() => undefined);
  }
  for (const appName of createdApps) {
    const response = await flyRequest(`/apps/${encodeURIComponent(appName)}`, {
      method: "GET",
    });
    if (response.status !== 404) {
      throw new Error(`Fly canary cleanup did not delete ${appName}.`);
    }
  }
}

type CanaryIdentity = ReturnType<typeof canaryIdentity>;
type CanaryEnvironment = Awaited<ReturnType<typeof provisionCanaryEnvironment>>;

function canaryIdentity() {
  const environmentId = randomUUID();
  return {
    environmentId,
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    threadId: randomUUID(),
    appName: flyEnvironmentAppName(environmentId),
    networkName: flyEnvironmentNetworkName(environmentId),
  };
}

async function provisionCanaryEnvironment(identity: CanaryIdentity) {
  const app = await provider.ensureEnvironmentApp(identity);
  createdApps.push(identity.appName);
  const gateway = await provider.ensureEnvironmentGateway({
    appName: identity.appName,
    environmentId: identity.environmentId,
    region,
    runtimeImage: routerImage,
    ticketPublicKey: publicKey,
  });
  if (gateway.state !== "started") {
    await provider.waitForMachine({
      appName: identity.appName,
      machineId: gateway.machineId,
      state: "started",
      timeoutSeconds: 90,
    });
  }
  const volume = await provider.ensureWorkspaceVolume({
    appName: identity.appName,
    workspaceId: identity.workspaceId,
    region,
  });
  const machineInput = {
    appName: identity.appName,
    environmentId: identity.environmentId,
    organizationId: identity.organizationId,
    workspaceId: identity.workspaceId,
    volumeId: volume.id,
    region,
    runtimeImage: workspaceImage,
    ticketPublicKey: publicKey,
    controlPlaneUrl: "https://canary.invalid",
    credentialBrokerToken: "canary-not-used",
    source: { type: "blank" as const },
    idleTimeoutMinutes: 15,
  };
  const machine = await provider.ensureWorkspaceMachine(machineInput);
  if (machine.state !== "started") {
    await provider.waitForMachine({
      appName: identity.appName,
      machineId: machine.id,
      state: "started",
      timeoutSeconds: 90,
    });
  }
  const repeated = await Promise.all([
    provider.ensureEnvironmentApp(identity),
    provider.ensureEnvironmentGateway({
      appName: identity.appName,
      environmentId: identity.environmentId,
      region,
      runtimeImage: routerImage,
      ticketPublicKey: publicKey,
    }),
    provider.ensureWorkspaceVolume({
      appName: identity.appName,
      workspaceId: identity.workspaceId,
      region,
    }),
    provider.ensureWorkspaceMachine(machineInput),
  ]);
  if (
    repeated[0].id !== app.id ||
    repeated[1].machineId !== gateway.machineId ||
    repeated[2].id !== volume.id ||
    repeated[3].id !== machine.id
  ) {
    throw new Error("Fly provider ensure operations were not idempotent.");
  }
  await waitForHealth(gateway.routerUrl);
  return { ...identity, app, gateway, volume, machine, machineInput };
}

async function assertGatewayBoundary(environment: CanaryEnvironment) {
  const [app, gateway, workspace, ips] = await Promise.all([
    flyJson<{ network?: string }>(
      `/apps/${encodeURIComponent(environment.appName)}`
    ),
    machineDetails(environment.appName, environment.gateway.machineId),
    machineDetails(environment.appName, environment.machine.id),
    flyJson<{ ips: Array<{ ip: string; shared?: boolean }> }>(
      `/apps/${encodeURIComponent(environment.appName)}/ip_assignments`
    ),
  ]);
  if (app.network !== environment.networkName) {
    throw new Error("Environment App is not attached to its custom network.");
  }
  if (!Array.isArray(gateway.config?.services) || gateway.config.services.length === 0) {
    throw new Error("Environment gateway has no public service contract.");
  }
  if (Array.isArray(workspace.config?.services) && workspace.config.services.length > 0) {
    throw new Error("Workspace Machine unexpectedly exposes a public service.");
  }
  if (!ips.ips.some((assignment) => assignment.shared === true)) {
    throw new Error("Environment gateway has no shared public ingress.");
  }
  const unauthorized = await fetch(
    new URL("/v1/tree", environment.gateway.routerUrl)
  );
  if (unauthorized.status !== 401) {
    throw new Error("Environment gateway did not reject an unsigned request.");
  }
  const response = await routeFetch(environment, "/v1/tree", {
    capability: "workspace.files.read",
  });
  if (!response.ok) {
    throw new Error(`Signed private routing failed with HTTP ${response.status}.`);
  }
}

async function assertCrossNetworkIsolation(
  source: CanaryEnvironment,
  target: CanaryEnvironment
) {
  const targetHost = `${target.machine.id}.vm.${target.appName}.internal`;
  const code = `require('node:dns').promises.lookup(${JSON.stringify(targetHost)}).then(()=>console.log('CROSS_ENVIRONMENT_RESOLVED')).catch(()=>console.log('CROSS_ENVIRONMENT_ISOLATED'))`;
  const { stdout } = await execFileAsync(
    "fly",
    [
      "machine",
      "exec",
      "--app",
      source.appName,
      "--timeout",
      "30",
      source.machine.id,
      "node",
      "-e",
      code,
    ],
    {
      env: { ...process.env, FLY_API_TOKEN: token },
      maxBuffer: 1024 * 1024,
    }
  );
  if (stdout.includes("CROSS_ENVIRONMENT_RESOLVED")) {
    throw new Error("A Workspace resolved another Environment's private Machine.");
  }
  if (!stdout.includes("CROSS_ENVIRONMENT_ISOLATED")) {
    throw new Error("Cross-Environment DNS isolation proof was inconclusive.");
  }
}

async function assertPersistence(environment: CanaryEnvironment) {
  const created = await routeFetch(environment, "/v1/terminal/exec", {
    capability: "workspace.terminal.exec",
    method: "POST",
    body: JSON.stringify({ command: "printf live-fly-canary > canary.txt" }),
    headers: { "content-type": "application/json" },
  });
  if (!created.ok) throw new Error("Canary file creation failed.");
  await assertCanaryFile(environment, environment.machine.id);
  await provider.stopMachine({
    appName: environment.appName,
    machineId: environment.machine.id,
  });
  await provider.waitForMachine({
    appName: environment.appName,
    machineId: environment.machine.id,
    state: "stopped",
    timeoutSeconds: 60,
  });
  await provider.startMachine({
    appName: environment.appName,
    machineId: environment.machine.id,
  });
  await provider.waitForMachine({
    appName: environment.appName,
    machineId: environment.machine.id,
    state: "started",
    timeoutSeconds: 90,
  });
  await assertCanaryFile(environment, environment.machine.id);
}

async function assertBackupRestore(environment: CanaryEnvironment) {
  const exported = await routeFetch(environment, "/v1/backups/export", {
    capability: "workspace.backups.export",
  });
  if (!exported.ok) throw new Error("Workspace backup export failed.");
  const archive = Buffer.from(await exported.arrayBuffer());
  const checksumSha256 = createHash("sha256").update(archive).digest("hex");
  const replacementId = randomUUID();
  const replacementVolume = await provider.createReplacementWorkspaceVolume({
    appName: environment.appName,
    workspaceId: environment.workspaceId,
    region,
    replacementId,
  });
  const replacementMachine = await provider.createReplacementWorkspaceMachine({
    ...environment.machineInput,
    volumeId: replacementVolume.id,
    replacementId,
  });
  if (replacementMachine.state !== "started") {
    await provider.waitForMachine({
      appName: environment.appName,
      machineId: replacementMachine.id,
      state: "started",
      timeoutSeconds: 90,
    });
  }
  const route = (pathname: string, init: RequestInit = {}) =>
    routeFetch(environment, pathname, {
      capability: "workspace.backups.restore",
      machineId: replacementMachine.id,
      ...init,
    });
  const created = await route("/v1/backups/imports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ checksumSha256 }),
  });
  const payload = (await created.json()) as { id?: string };
  if (!(created.ok && payload.id)) throw new Error("Backup import creation failed.");
  const chunkSize = 512 * 1024;
  for (let offset = 0, index = 0; offset < archive.length; offset += chunkSize, index += 1) {
    const response = await route(
      `/v1/backups/imports/${payload.id}/chunks/${index}`,
      { method: "PUT", body: archive.subarray(offset, offset + chunkSize) }
    );
    if (!response.ok) throw new Error("Backup import chunk failed.");
  }
  const completed = await route(
    `/v1/backups/imports/${payload.id}/complete`,
    { method: "POST" }
  );
  if (!completed.ok) throw new Error("Backup import completion failed.");
  await assertCanaryFile(environment, replacementMachine.id);
}

async function assertCanaryFile(
  environment: CanaryEnvironment,
  machineId: string
) {
  const response = await routeFetch(environment, "/v1/files?path=canary.txt", {
    capability: "workspace.files.read",
    machineId,
  });
  if (!response.ok || (await response.text()) !== "live-fly-canary") {
    throw new Error("Workspace file did not survive the lifecycle operation.");
  }
}

async function routeFetch(
  environment: CanaryEnvironment,
  pathname: string,
  input: RequestInit & { capability: string; machineId?: string }
) {
  const { capability, machineId = environment.machine.id, ...init } = input;
  const now = Math.floor(Date.now() / 1000);
  const authToken = signEnvironmentExecutionTicket({
    privateKey,
    ticket: {
      version: 1,
      audience: ENVIRONMENT_ROUTER_AUDIENCE,
      organizationId: environment.organizationId,
      environmentId: environment.environmentId,
      workspaceId: environment.workspaceId,
      threadId: environment.threadId,
      runId: randomUUID(),
      actorId: "fly-canary",
      agentId: "fly-canary",
      flyAppName: environment.appName,
      flyMachineId: machineId,
      capabilities: [capability],
      issuedAt: now,
      expiresAt: now + 300,
      nonce: randomUUID(),
    },
  });
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${authToken}`);
  return fetch(new URL(pathname, environment.gateway.routerUrl), {
    ...init,
    headers,
  });
}

async function waitForHealth(routerUrl: string) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/health", routerUrl));
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Environment gateway did not become healthy: ${routerUrl}`);
}

async function machineDetails(appName: string, machineId: string) {
  return flyJson<{ config?: { services?: unknown[] } }>(
    `/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}`
  );
}

async function flyJson<T>(pathname: string): Promise<T> {
  const response = await flyRequest(pathname, { method: "GET" });
  if (!response.ok) throw new Error(`Fly API returned HTTP ${response.status}.`);
  return (await response.json()) as T;
}

function flyRequest(pathname: string, init: RequestInit) {
  return fetch(`${apiBaseUrl}${pathname}`, {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });
}

function summarize(environment: CanaryEnvironment) {
  return {
    appName: environment.appName,
    networkName: environment.networkName,
    gatewayMachineId: environment.gateway.machineId,
    workspaceMachineId: environment.machine.id,
    volumeId: environment.volume.id,
  };
}

function immutableImage(name: string) {
  const value = required(name);
  if (!/@sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${name} must be an immutable sha256 image reference.`);
  }
  return value;
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
