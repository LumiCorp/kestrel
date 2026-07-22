import assert from "node:assert/strict";
import {
  FlyMachinesClient,
  flyEnvironmentAppName,
  flyEnvironmentNetworkName,
} from "./fly-machines";
import { EnvironmentProviderError } from "./contracts";
import { contractTest } from "../../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "Fly resource names are deterministic and provider-safe", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(flyEnvironmentAppName(id), "kestrel-env-123e4567e89b12d3a456");
  assert.equal(
    flyEnvironmentNetworkName(id),
    "kestrel-123e4567e89b12d3a4564266-network"
  );
});

contractTest("web.hermetic", "Fly waits split long deadlines into accepted request windows", async () => {
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

contractTest("web.hermetic", "Fly stopped waits bind the current Machine instance", async () => {
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

contractTest("web.hermetic", "Fly start is idempotent when another request already started the Machine", async () => {
  const requests: Array<{ method: string; url: string }> = [];
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ method: init?.method ?? "GET", url: String(url) });
      if (requests.length === 1) return new Response(null, { status: 412 });
      return Response.json({
        id: "machine-1",
        state: "starting",
        region: "iad",
        config: {},
      });
    }) as typeof fetch,
  });
  await client.startMachine({
    appName: "kestrel-env-abc",
    machineId: "machine-1",
  });
  assert.deepEqual(
    requests.map((request) => request.method),
    ["POST", "GET"]
  );
});

contractTest("web.hermetic", "Fly start waits out an in-progress stop before issuing the start", async () => {
  const requests: Array<{ method: string; url: string }> = [];
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    sleepImpl: async () => {},
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const request = { method: init?.method ?? "GET", url: String(url) };
      requests.push(request);
      if (requests.length === 1) return new Response(null, { status: 412 });
      if (request.url.includes("/wait?")) return Response.json({ ok: true });
      if (request.method === "POST") return Response.json({ ok: true });
      return Response.json({
        id: "machine-1",
        instance_id: "instance-1",
        state: "stopping",
        region: "iad",
        config: {},
      });
    }) as typeof fetch,
  });
  await client.startMachine({
    appName: "kestrel-env-abc",
    machineId: "machine-1",
  });
  assert.deepEqual(
    requests.map((request) => request.method),
    ["POST", "GET", "GET", "GET", "POST"]
  );
  assert.match(requests[3]?.url ?? "", /[?&]state=stopped(?:&|$)/u);
});

contractTest("web.hermetic", "Fly start retries a transient stopped-state rejection once per interval", async () => {
  const requests: Array<{ method: string; url: string }> = [];
  const sleeps: number[] = [];
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    sleepImpl: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const request = { method: init?.method ?? "GET", url: String(url) };
      requests.push(request);
      if (request.method === "POST" && requests.length === 1) {
        return new Response(null, { status: 412 });
      }
      if (request.method === "GET") {
        return Response.json({
          id: "machine-1",
          state: "stopped",
          region: "iad",
          config: {},
        });
      }
      return Response.json({ ok: true });
    }) as typeof fetch,
  });

  await client.startMachine({
    appName: "kestrel-env-abc",
    machineId: "machine-1",
  });

  assert.deepEqual(
    requests.map((request) => request.method),
    ["POST", "GET", "POST"]
  );
  assert.deepEqual(sleeps, [1000]);
});

contractTest("web.hermetic", "Fly start fails closed after ten stopped-state retries", async () => {
  const requests: Array<{ method: string; url: string }> = [];
  const sleeps: number[] = [];
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    sleepImpl: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const request = { method: init?.method ?? "GET", url: String(url) };
      requests.push(request);
      if (request.method === "POST") {
        return new Response(null, { status: 412 });
      }
      return Response.json({
        id: "machine-1",
        state: "stopped",
        region: "iad",
        config: {},
      });
    }) as typeof fetch,
  });

  await assert.rejects(
    client.startMachine({
      appName: "kestrel-env-abc",
      machineId: "machine-1",
    }),
    /remained stopped after 10 bounded start retries/u
  );

  assert.equal(
    requests.filter((request) => request.method === "POST").length,
    11
  );
  assert.equal(
    requests.filter((request) => request.method === "GET").length,
    11
  );
  assert.deepEqual(
    sleeps,
    Array.from({ length: 10 }, () => 1000)
  );
});

contractTest("web.hermetic", "Fly start fails closed when the authoritative state cannot be retried", async () => {
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        return new Response(null, { status: 412 });
      }
      return Response.json({
        id: "machine-1",
        state: "suspended",
        region: "iad",
        config: {},
      });
    }) as typeof fetch,
  });

  await assert.rejects(
    client.startMachine({
      appName: "kestrel-env-abc",
      machineId: "machine-1",
    }),
    /authoritative Machine state was suspended/u
  );
});

contractTest("web.hermetic", "Fly readiness waits for the exact named Machine check to pass", async () => {
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

contractTest("web.hermetic", "Fly readiness fails closed when the named Machine check never passes", async () => {
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    healthPollIntervalMs: 0,
    fetchImpl: (async () =>
      Response.json({
        id: "machine-1",
        state: "started",
        region: "iad",
        checks: [{
          name: "workspace",
          status: "critical",
          output: "token=super-secret\nprocess exited with status 1",
        }],
      })) as unknown as typeof fetch,
  });

  await assert.rejects(
    client.waitForMachineHealth({
      appName: "kestrel-env-abc",
      machineId: "machine-1",
      checkName: "workspace",
      timeoutSeconds: 0,
    }),
    (error: unknown) => {
      assert.ok(error instanceof EnvironmentProviderError);
      assert.match(error.message, /machine-1 was started/u);
      assert.match(error.message, /workspace was critical/u);
      assert.match(error.message, /token=\[redacted\]/u);
      assert.doesNotMatch(error.message, /super-secret/u);
      return true;
    }
  );
});

contractTest("web.hermetic", "Environment App creation always supplies the custom network", async () => {
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

contractTest("web.hermetic", "Environment App ownership resolves configured organization aliases", async () => {
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

contractTest("web.hermetic", "Workspace provisioning requests encrypted storage and a private runtime Machine", async () => {
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
    serviceToken: "workspace-service-token",
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
  assert.equal(machineBody.config.env.KESTREL_REQUIRE_MANAGED_WORKTREE, "true");
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
    undefined
  );
  assert.equal(
    machineBody.config.env.KESTREL_WORKSPACE_PREVIEWS_ENABLED,
    undefined
  );
  assert.equal(machineBody.config.env.NGROK_AUTHTOKEN, undefined);
  assert.equal(
    machineBody.config.env.KESTREL_WORKSPACE_SERVICE_TOKEN,
    "workspace-service-token"
  );
  assert.equal(machineBody.config.env.OPENAI_API_KEY, undefined);
  assert.equal(machineBody.config.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(machineBody.config.env.OPENROUTER_API_KEY, undefined);
  assert.equal(machineBody.config.services, undefined);
});

contractTest("web.hermetic", "Environment gateway owns public ingress while Workspace Machines remain private", async () => {
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
    controlPlaneUrl: "https://kestrel.example",
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

contractTest("web.hermetic", "Environment gateway rejects an existing Machine with stale immutable configuration", async () => {
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
      controlPlaneUrl: "https://kestrel.example",
    }),
    /immutable ingress contract/u
  );
});

contractTest("web.hermetic", "Fly rejection discards provider response bodies", async () => {
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

contractTest("web.hermetic", "Fly on-demand snapshots use the Workspace volume endpoint", async () => {
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

contractTest("web.hermetic", "Fly image updates are idempotent across tag aliases of the same digest", async () => {
  const requests: Array<{ method: string; url: string }> = [];
  const digest = `sha256:${"a".repeat(64)}`;
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ method: init?.method ?? "GET", url: String(url) });
      return Response.json({
        id: "machine-1",
        state: "started",
        region: "iad",
        config: {
          image: `registry.fly.io/kestrel-one-runner:workspace-current@${digest}`,
        },
      });
    }) as typeof fetch,
  });
  const machine = await client.updateMachineImage({
    appName: "app-1",
    machineId: "machine-1",
    runtimeImage: `registry.fly.io/kestrel-one-runner@${digest}`,
  });
  assert.equal(machine.image?.endsWith(digest), true);
  assert.deepEqual(
    requests.map((request) => request.method),
    ["GET"]
  );
});

contractTest("web.hermetic", "Fly workspace updates reconcile preview environment without replacing unrelated configuration", async () => {
  const requests: Array<{ method: string; body: unknown }> = [];
  const digest = `sha256:${"a".repeat(64)}`;
  const currentConfig = {
    image: `registry.fly.io/kestrel-one-runner@${digest}`,
    env: {
      KESTREL_WORKSPACE_ID: "workspace-1",
      KESTREL_WORKSPACE_PREVIEWS_ENABLED: "true",
      NGROK_AUTHTOKEN: "old-token",
    },
  };
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ method: init?.method ?? "GET", body });
      return Response.json({
        id: "machine-1",
        state: "started",
        region: "iad",
        instance_id: "instance-1",
        config: body?.config ?? currentConfig,
      });
    }) as typeof fetch,
  });

  await client.updateMachineImage({
    appName: "app-1",
    machineId: "machine-1",
    runtimeImage: `registry.fly.io/kestrel-one-runner:current@${digest}`,
    envPatch: {
      KESTREL_WORKSPACE_PREVIEWS_ENABLED: "true",
      NGROK_AUTHTOKEN: "new-token",
    },
  });

  assert.deepEqual(requests.map(({ method }) => method), ["GET", "POST"]);
  const update = requests[1]?.body as {
    config?: { env?: Record<string, string> };
  };
  assert.deepEqual(update.config?.env, {
    KESTREL_WORKSPACE_ID: "workspace-1",
    KESTREL_WORKSPACE_PREVIEWS_ENABLED: "true",
    NGROK_AUTHTOKEN: "new-token",
  });

  await client.updateMachineImage({
    appName: "app-1",
    machineId: "machine-1",
    runtimeImage: `registry.fly.io/kestrel-one-runner@${digest}`,
    envPatch: {
      KESTREL_WORKSPACE_PREVIEWS_ENABLED: undefined,
      NGROK_AUTHTOKEN: undefined,
    },
  });
  const disableUpdate = requests[3]?.body as {
    config?: { env?: Record<string, string> };
  };
  assert.deepEqual(disableUpdate.config?.env, {
    KESTREL_WORKSPACE_ID: "workspace-1",
  });
});

contractTest("web.hermetic", "Fly idempotent Workspace provisioning rotates the scoped service identity", async () => {
  const requests: Array<{ method: string; body: unknown }> = [];
  const current = {
    id: "machine-1",
    state: "started",
    region: "iad",
    config: {
      image: "registry.fly.io/runtime@sha256:abc",
      metadata: { kestrel_workspace_id: "workspace-1" },
      env: {
        KESTREL_WORKSPACE_ID: "workspace-1",
        KESTREL_WORKSPACE_SERVICE_TOKEN: "old-token",
      },
    },
  };
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ method: init?.method ?? "GET", body });
      return Response.json(
        init?.method === "POST"
          ? { ...current, config: body.config }
          : [current]
      );
    }) as typeof fetch,
  });
  await client.ensureWorkspaceMachine({
    appName: "app-1",
    environmentId: "environment-1",
    organizationId: "organization-1",
    workspaceId: "workspace-1",
    volumeId: "volume-1",
    region: "iad",
    runtimeImage: "registry.fly.io/runtime@sha256:abc",
    ticketPublicKey: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
    controlPlaneUrl: "https://kestrel.example",
    serviceToken: "new-token",
    source: { type: "blank" },
    idleTimeoutMinutes: 15,
  });
  assert.deepEqual(requests.map(({ method }) => method), ["GET", "POST"]);
  const update = requests[1]?.body as { config?: { env?: Record<string, string> } };
  assert.deepEqual(update.config?.env, {
    KESTREL_WORKSPACE_ID: "workspace-1",
    KESTREL_WORKSPACE_SERVICE_TOKEN: "new-token",
  });
});

contractTest("web.hermetic", "Fly deletion operations are idempotent on missing resources", async () => {
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

contractTest("web.hermetic", "replacement resources are idempotently namespaced away from the active Workspace", async () => {
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

contractTest("web.hermetic", "Fly inventory preserves exact Workspace ownership metadata", async () => {
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
                mounts: [
                  {
                    volume: "volume-1",
                    name: "ws_workspace1",
                    path: "/workspace",
                  },
                ],
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
              attached_machine_id: "machine-1",
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
          mountedVolumeIds: ["volume-1"],
        },
      ],
      volumes: [
        {
          id: "volume-1",
          name: "ws_workspace1",
          region: "iad",
          attachedMachineId: "machine-1",
        },
      ],
    }
  );
});

contractTest("web.hermetic", "Fly Machine lookup preserves exact Workspace mount evidence", async () => {
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async () =>
      Response.json({
        id: "machine-1",
        state: "stopped",
        region: "iad",
        config: {
          metadata: { kestrel_workspace_id: "workspace-1" },
          mounts: [
            {
              volume: "volume-1",
              name: "ws_workspace1",
              path: "/workspace",
            },
          ],
        },
      })) as unknown as typeof fetch,
  });
  assert.deepEqual(
    await client.getMachine({ appName: "app-1", machineId: "machine-1" }),
    {
      id: "machine-1",
      state: "stopped",
      region: "iad",
      workspaceId: "workspace-1",
      mounts: [
        {
          volumeId: "volume-1",
          name: "ws_workspace1",
          path: "/workspace",
        },
      ],
    }
  );
});
