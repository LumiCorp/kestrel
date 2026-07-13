import assert from "node:assert/strict";
import test from "node:test";
import {
  FlyMachinesClient,
  flyEnvironmentAppName,
  flyEnvironmentNetworkName,
} from "./fly-machines";

test("Fly resource names are deterministic and provider-safe", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(flyEnvironmentAppName(id), "kestrel-env-123e4567e89b12d3a456");
  assert.equal(
    flyEnvironmentNetworkName(id),
    "kestrel-123e4567e89b12d3a4564266-network"
  );
});

test("Environment App creation always supplies the custom network", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      if (requests.length === 1) {
        return new Response(null, { status: 404 });
      }
      return Response.json({ id: "fly-app-id" }, { status: 201 });
    }) as typeof fetch,
  });
  const app = await client.ensureEnvironmentApp({
    appName: "kestrel-env-abc",
    networkName: "kestrel-abc-network",
  });
  assert.equal(app.network, "kestrel-abc-network");
  assert.deepEqual(JSON.parse(String(requests[1]?.init.body)), {
    app_name: "kestrel-env-abc",
    org_slug: "kestrel-test",
    network: "kestrel-abc-network",
  });
});

test("Workspace provisioning requests encrypted storage and a private runtime Machine", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      const path = String(url);
      if (path.endsWith("/volumes") && init?.method === "GET") {
        return Response.json([]);
      }
      if (path.endsWith("/volumes") && init?.method === "POST") {
        return Response.json({
          id: "vol-1",
          name: "ws_123e4567e89b12d3a456",
          region: "iad",
          size_gb: 20,
          encrypted: true,
        });
      }
      if (path.includes("/machines?")) {
        return Response.json([]);
      }
      return Response.json({
        id: "machine-1",
        state: "started",
        region: "iad",
        config: { metadata: { kestrel_workspace_id: "workspace-id" } },
      });
    }) as typeof fetch,
  });
  const volume = await client.ensureWorkspaceVolume({
    appName: "kestrel-env-abc",
    workspaceId: "123e4567-e89b-12d3-a456-426614174000",
    region: "iad",
  });
  await client.ensureWorkspaceMachine({
    appName: "kestrel-env-abc",
    environmentId: "environment-id",
    organizationId: "organization-id",
    workspaceId: "workspace-id",
    volumeId: volume.id,
    region: "iad",
    runtimeImage: "registry.fly.io/kestrel-workspace@sha256:abc",
    ticketPublicKey:
      "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
    controlPlaneUrl: "https://kestrel.example",
    credentialBrokerToken: "credential-broker-token",
    source: { type: "blank" },
    idleTimeoutMinutes: 15,
  });
  const volumeCreate = requests.find(
    (request) =>
      request.url.endsWith("/volumes") && request.init.method === "POST"
  );
  const machineCreate = requests.find(
    (request) =>
      request.url.endsWith("/machines") && request.init.method === "POST"
  );
  const volumeBody = JSON.parse(String(volumeCreate?.init.body));
  const machineBody = JSON.parse(String(machineCreate?.init.body));
  assert.equal(volumeBody.encrypted, true);
  assert.equal(volumeBody.size_gb, 20);
  assert.deepEqual(machineBody.config.mounts, [
    { volume: "vol-1", path: "/workspace" },
  ]);
  assert.equal(machineBody.config.guest.memory_mb, 4096);
  assert.equal(machineBody.config.env.KESTREL_ENABLE_MANAGED_WORKTREES, "true");
  assert.equal(
    machineBody.config.env.KESTREL_MANAGED_WORKTREE_ISOLATION,
    "session"
  );
  assert.equal(machineBody.config.env.FLY_API_TOKEN, undefined);
  assert.equal(
    machineBody.config.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY,
    undefined
  );
  assert.match(
    machineBody.config.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY,
    /PUBLIC KEY/u
  );
  assert.equal(
    machineBody.config.env.KESTREL_ONE_APP_URL,
    "https://kestrel.example"
  );
  assert.equal(
    machineBody.config.env.KESTREL_ONE_CREDENTIAL_BROKER_TOKEN,
    "credential-broker-token"
  );
  assert.equal(machineBody.config.env.OPENAI_API_KEY, undefined);
  assert.equal(machineBody.config.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(machineBody.config.env.OPENROUTER_API_KEY, undefined);
  assert.equal(machineBody.config.services[0].internal_port, 43_104);
});

test("Fly rejection discards provider response bodies", async () => {
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async () =>
      new Response("reflected-secret", {
        status: 401,
      })) as unknown as typeof fetch,
  });
  await assert.rejects(
    () =>
      client.ensureEnvironmentApp({
        appName: "kestrel-env-abc",
        networkName: "kestrel-abc-network",
      }),
    (error: unknown) =>
      error instanceof Error && !error.message.includes("reflected-secret")
  );
});

test("Fly on-demand snapshots use the Workspace volume endpoint", async () => {
  let requestedUrl = "";
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (url: string | URL | Request) => {
      requestedUrl = String(url);
      return Response.json({
        Msg: {
          backup: {
            id: "internal-backup-1",
            graph_id: "snapshot-1",
            state: "prepare",
          },
        },
      });
    }) as typeof fetch,
  });
  assert.deepEqual(
    await client.createVolumeSnapshot({ appName: "app-1", volumeId: "vol-1" }),
    { id: "snapshot-1", state: "prepare" }
  );
  assert.match(requestedUrl, /\/apps\/app-1\/volumes\/vol-1\/snapshots$/u);
});

test("Fly deletion operations are idempotent on missing resources", async () => {
  const requests: Array<{ url: string; method: string | undefined }> = [];
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method });
      return new Response(null, { status: 404 });
    }) as typeof fetch,
  });
  await client.deleteMachine({ appName: "app-1", machineId: "machine-1" });
  await client.deleteVolume({ appName: "app-1", volumeId: "volume-1" });
  await client.deleteEnvironmentApp({ appName: "app-1" });
  assert.deepEqual(
    requests.map(({ url, method }) => [
      new URL(url).pathname + new URL(url).search,
      method,
    ]),
    [
      ["/v1/apps/app-1/machines/machine-1?force=true", "DELETE"],
      ["/v1/apps/app-1/volumes/volume-1", "DELETE"],
      ["/v1/apps/app-1", "DELETE"],
    ]
  );
});

test("replacement resources are idempotently namespaced away from the active Workspace", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      const pathname = new URL(String(url)).pathname;
      if (init?.method === "GET") return Response.json([]);
      if (pathname.endsWith("/volumes")) {
        const body = JSON.parse(String(init?.body));
        return Response.json({
          id: "replacement-volume-id",
          name: body.name,
          region: "iad",
          size_gb: 20,
          encrypted: true,
        });
      }
      return Response.json({
        id: "replacement-machine-id",
        state: "started",
        region: "iad",
      });
    }) as typeof fetch,
  });
  const volume = await client.createReplacementWorkspaceVolume({
    appName: "app-1",
    workspaceId: "workspace-1",
    region: "iad",
    replacementId: "restore-operation-1",
  });
  await client.createReplacementWorkspaceMachine({
    appName: "app-1",
    environmentId: "environment-1",
    organizationId: "organization-1",
    workspaceId: "workspace-1",
    volumeId: volume.id,
    region: "iad",
    runtimeImage: "registry.fly.io/runtime@sha256:abc",
    ticketPublicKey:
      "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
    controlPlaneUrl: "https://kestrel.example",
    credentialBrokerToken: "credential-broker-token",
    source: { type: "blank" },
    idleTimeoutMinutes: 15,
    replacementId: "restore-operation-1",
  });
  const volumeCreate = requests.find(
    ({ url, init }) => url.endsWith("/volumes") && init.method === "POST"
  );
  const machineCreate = requests.find(
    ({ url, init }) => url.endsWith("/machines") && init.method === "POST"
  );
  const volumeBody = JSON.parse(String(volumeCreate?.init.body));
  const machineBody = JSON.parse(String(machineCreate?.init.body));
  assert.match(volumeBody.name, /_r_/u);
  assert.equal(
    machineBody.config.metadata.kestrel_replacement_id,
    "restore-operation-1"
  );
  assert.equal(machineBody.config.mounts[0].volume, "replacement-volume-id");
});

test("Fly inventory preserves exact Workspace ownership metadata", async () => {
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (url: string | URL | Request) =>
      String(url).endsWith("/machines")
        ? Response.json([
            {
              id: "machine-1",
              state: "started",
              region: "iad",
              config: {
                metadata: {
                  kestrel_workspace_id: "workspace-1",
                  kestrel_replacement_id: "restore-1",
                },
              },
            },
          ])
        : Response.json([
            {
              id: "volume-1",
              name: "ws_workspace1",
              region: "iad",
              size_gb: 20,
              encrypted: true,
            },
          ])) as typeof fetch,
  });
  assert.deepEqual(
    await client.listEnvironmentResources({ appName: "app-1" }),
    {
      machines: [
        {
          id: "machine-1",
          workspaceId: "workspace-1",
          replacementId: "restore-1",
        },
      ],
      volumes: [{ id: "volume-1", name: "ws_workspace1" }],
    }
  );
});
