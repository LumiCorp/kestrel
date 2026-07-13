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

test("Fly waits split long deadlines into accepted request windows", async () => {
  const requests: string[] = [];
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (url: string | URL | Request) => {
      requests.push(String(url));
      return requests.length === 1
        ? new Response(null, { status: 408 })
        : Response.json({});
    }) as typeof fetch,
  });
  await client.waitForMachine({
    appName: "kestrel-env-abc",
    machineId: "machine-1",
    state: "started",
    timeoutSeconds: 90,
  });
  assert.equal(requests.length, 2);
  assert.match(requests[0] ?? "", /[?&]timeout=60(?:&|$)/u);
});

test("Fly stopped waits bind the current Machine instance", async () => {
  const requests: string[] = [];
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (url: string | URL | Request) => {
      requests.push(String(url));
      if (!String(url).includes("/wait?")) {
        return Response.json({
          id: "machine-1",
          instance_id: "instance-1",
          state: "stopping",
          region: "iad",
          config: {},
        });
      }
      return Response.json({});
    }) as typeof fetch,
  });
  await client.waitForMachine({
    appName: "kestrel-env-abc",
    machineId: "machine-1",
    state: "stopped",
    timeoutSeconds: 60,
  });
  assert.equal(requests.length, 2);
  assert.match(requests[1] ?? "", /[?&]instance_id=instance-1(?:&|$)/u);
});

test("Fly readiness waits for the exact named Machine check to pass", async () => {
  const responses = [
    {
      id: "machine-1",
      state: "started",
      region: "iad",
      checks: [{ name: "workspace", status: "warning" }],
    },
    {
      id: "machine-1",
      state: "started",
      region: "iad",
      checks: [
        { name: "another-check", status: "passing" },
        { name: "workspace", status: "passing" },
      ],
    },
  ];
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    healthPollIntervalMs: 0,
    fetchImpl: (async () =>
      Response.json(responses.shift())) as unknown as typeof fetch,
  });

  await client.waitForMachineHealth({
    appName: "kestrel-env-abc",
    machineId: "machine-1",
    checkName: "workspace",
    timeoutSeconds: 1,
  });
  assert.equal(responses.length, 0);
});

test("Fly readiness fails closed when the named Machine check never passes", async () => {
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    healthPollIntervalMs: 0,
    fetchImpl: (async () =>
      Response.json({
        id: "machine-1",
        state: "started",
        region: "iad",
        checks: [{ name: "workspace", status: "critical" }],
      })) as unknown as typeof fetch,
  });

  await assert.rejects(
    client.waitForMachineHealth({
      appName: "kestrel-env-abc",
      machineId: "machine-1",
      checkName: "workspace",
      timeoutSeconds: 0,
    }),
    /workspace did not pass/u
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

test("Environment App ownership resolves configured organization aliases", async () => {
  const requests: string[] = [];
  const app = {
    id: "fly-app-id",
    name: "kestrel-env-abc",
    network: "kestrel-abc-network",
    organization: { slug: "canonical-organization" },
  };
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "personal",
    fetchImpl: (async (url: string | URL | Request) => {
      requests.push(String(url));
      return requests.length === 1
        ? Response.json(app)
        : Response.json({ total_apps: 1, apps: [app] });
    }) as typeof fetch,
  });
  const resolved = await client.ensureEnvironmentApp({
    appName: app.name,
    networkName: app.network,
  });
  assert.equal(resolved.id, app.id);
  assert.equal(resolved.organizationSlug, "canonical-organization");
  assert.match(requests[1] ?? "", /[?&]org_slug=personal(?:&|$)/u);
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
  assert.equal(machineBody.config.services, undefined);
});

test("Environment gateway owns public ingress while Workspace Machines remain private", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      const path = String(url);
      if (path.endsWith("/ip_assignments") && init?.method === "GET") {
        return Response.json({ ips: [] });
      }
      if (path.endsWith("/ip_assignments") && init?.method === "POST") {
        return Response.json({
          created_at: null,
          ip: "203.0.113.1",
          region: null,
          service_name: null,
          shared: false,
        });
      }
      if (path.includes("/machines?")) return Response.json([]);
      return Response.json({
        id: "gateway-machine-1",
        state: "started",
        region: "iad",
        config: {
          metadata: {
            kestrel_environment_gateway: "true",
            kestrel_environment_id: "environment-1",
          },
        },
      });
    }) as typeof fetch,
  });
  const gateway = await client.ensureEnvironmentGateway({
    appName: "kestrel-env-abc",
    environmentId: "environment-1",
    region: "iad",
    runtimeImage: "registry.fly.io/router@sha256:abc",
    ticketPublicKey:
      "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
  });
  assert.equal(gateway.routerUrl, "https://kestrel-env-abc.fly.dev");
  assert.equal(gateway.sharedIp, "203.0.113.1");
  const ipCreate = requests.find(
    ({ url, init }) => url.endsWith("/ip_assignments") && init.method === "POST"
  );
  assert.deepEqual(JSON.parse(String(ipCreate?.init.body)), {
    type: "shared_v4",
  });
  const machineCreate = requests.find(
    ({ url, init }) => url.endsWith("/machines") && init.method === "POST"
  );
  const machineBody = JSON.parse(String(machineCreate?.init.body));
  assert.equal(machineBody.config.image, "registry.fly.io/router@sha256:abc");
  assert.equal(machineBody.config.services[0].internal_port, 8080);
  assert.equal(machineBody.config.services[0].min_machines_running, 1);
  assert.equal(
    machineBody.config.env.KESTREL_ENVIRONMENT_APP_NAME,
    "kestrel-env-abc"
  );
});

test("Environment gateway rejects an existing Machine with stale immutable configuration", async () => {
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/ip_assignments")) {
        return Response.json({
          ips: [{ ip: "203.0.113.1", shared: true }],
        });
      }
      return Response.json([
        {
          id: "gateway-machine-1",
          state: "started",
          region: "iad",
          config: {
            image: "registry.fly.io/router@sha256:stale",
            env: {
              KESTREL_ENVIRONMENT_APP_NAME: "kestrel-env-abc",
              KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY: "old-key",
            },
            metadata: {
              kestrel_environment_gateway: "true",
              kestrel_environment_id: "environment-1",
            },
            services: [{}],
          },
        },
      ]);
    }) as typeof fetch,
  });
  await assert.rejects(
    client.ensureEnvironmentGateway({
      appName: "kestrel-env-abc",
      environmentId: "environment-1",
      region: "iad",
      runtimeImage: "registry.fly.io/router@sha256:current",
      ticketPublicKey: "current-key",
    }),
    /immutable ingress contract/u
  );
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
