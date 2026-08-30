import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  FlyMachinesClient,
  flyEnvironmentAppName,
  flyEnvironmentNetworkName,
} from "./fly-machines";
import {
  EnvironmentProviderError,
  KESTREL_WORKSPACE_STOP_CONFIG,
} from "./contracts";

const environmentTicketPublicKey = generateKeyPairSync("ed25519")
  .publicKey.export({ type: "spki", format: "pem" })
  .toString();
const rotatedEnvironmentTicketPublicKey = generateKeyPairSync("ed25519")
  .publicKey.export({ type: "spki", format: "pem" })
  .toString();
const nonEd25519PublicKey = generateKeyPairSync("x25519")
  .publicKey.export({ type: "spki", format: "pem" })
  .toString();

test("Fly resource names are deterministic and provider-safe", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(flyEnvironmentAppName(id), "kestrel-env-123e4567e89b12d3a456");
  assert.equal(
    flyEnvironmentNetworkName(id),
    "kestrel-123e4567e89b12d3a4564266-network",
  );
});

test("dedicated Browser Machines are ephemeral, private, immutable, and volume-free", async () => {
  let body: Record<string, any> | undefined;
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ id: "browser-machine-1" });
    }) as typeof fetch,
  });
  const digest = `registry.fly.io/kestrel-one-browser-worker@sha256:${"a".repeat(64)}`;
  await client.createBrowserMachine({
    appName: "browser-workers",
    organizationId: "org-1",
    environmentId: "env-1",
    projectId: "project-1",
    userId: "user-1",
    threadId: "thread-1",
    sessionId: "session-1",
    generation: 3,
    region: "iad",
    runtimeImageDigest: digest,
    engineRevision: "v0.35.0",
    chromeRevision: "152.0.7977.54",
    effectiveAllowlistRevision: "revision-1",
    capabilityPublicKeyPem: environmentTicketPublicKey,
  });
  assert.equal(body?.config.image, digest);
  assert.equal(body?.config.auto_destroy, true);
  assert.deepEqual(body?.config.mounts, []);
  assert.deepEqual(body?.config.services, []);
  assert.equal(body?.config.restart.policy, "no");
  assert.equal(body?.config.metadata.kestrel_browser_session_id, "session-1");
  assert.equal(body?.config.metadata.kestrel_browser_generation, "3");
  assert.equal(body?.config.env.FLY_API_TOKEN, undefined);
  assert.equal(body?.config.env.KESTREL_WORKSPACE_ID, undefined);
  assert.equal(body?.config.env.KESTREL_WORKSPACE_SERVICE_TOKEN, undefined);
  assert.equal(body?.config.env.KESTREL_ONE_TOOL_TOKEN, undefined);
  assert.equal(body?.config.env.PORT, "43105");
  assert.equal(body?.config.env.KESTREL_BROWSER_EGRESS_PROXY_URL, undefined);
  assert.equal(
    body?.config.env.KESTREL_BROWSER_EGRESS_OWNER,
    "environment_gateway",
  );
  assert.equal(
    body?.config.metadata.kestrel_browser_egress_owner,
    "environment_gateway",
  );
  assert.equal(
    body?.config.env.KESTREL_BROWSER_EFFECTIVE_ALLOWLIST_REVISION,
    "revision-1",
  );
  assert.equal(body?.config.env.KESTREL_BROWSER_ENGINE_REVISION, undefined);
  assert.equal(body?.config.env.KESTREL_BROWSER_CHROME_REVISION, undefined);
});

test("dedicated Browser Machines reject immutable images from another repository", async () => {
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async () => {
      assert.fail("provider request must not run");
    }) as unknown as typeof fetch,
  });
  await assert.rejects(
    client.createBrowserMachine({
      appName: "browser-workers",
      organizationId: "org-1",
      environmentId: "env-1",
      projectId: "project-1",
      userId: "user-1",
      threadId: "thread-1",
      sessionId: "session-1",
      generation: 3,
      region: "iad",
      runtimeImageDigest: `registry.fly.io/other@sha256:${"a".repeat(64)}`,
      engineRevision: "v0.35.0",
      chromeRevision: "152.0.7977.54",
      effectiveAllowlistRevision: "revision-1",
      capabilityPublicKeyPem: environmentTicketPublicKey,
    }),
    /approved immutable OCI repository/u,
  );
});

test("dedicated Browser Machines reject caller-asserted runtime revision drift", async () => {
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async () => {
      assert.fail("provider request must not run");
    }) as unknown as typeof fetch,
  });
  await assert.rejects(
    client.createBrowserMachine({
      appName: "browser-workers",
      organizationId: "org-1",
      environmentId: "env-1",
      projectId: "project-1",
      userId: "user-1",
      threadId: "thread-1",
      sessionId: "session-1",
      generation: 3,
      region: "iad",
      runtimeImageDigest:
        `registry.fly.io/kestrel-one-browser-worker@sha256:${"a".repeat(64)}`,
      engineRevision: "v999.0.0",
      chromeRevision: "152.0.7977.54",
      effectiveAllowlistRevision: "revision-1",
      capabilityPublicKeyPem: environmentTicketPublicKey,
    }),
    /pinned release manifest/u,
  );
});

test("Browser Machine reconciliation filters labels locally", async () => {
  const requested: string[] = [];
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (url) => {
      requested.push(String(url));
      return Response.json([
        {
          id: "browser-1",
          state: "started",
          region: "iad",
          config: {
            metadata: {
              kestrel_browser_session: "true",
              kestrel_browser_session_id: "session-1",
            },
          },
        },
        {
          id: "workspace-1",
          state: "started",
          region: "iad",
          config: { metadata: { kestrel_workspace_id: "workspace-1" } },
        },
      ]);
    }) as typeof fetch,
  });
  const machines = await client.listBrowserMachines({
    appName: "browser-workers",
    sessionId: "session-1",
  });
  assert.deepEqual(machines.map((machine) => machine.id), ["browser-1"]);
  assert.doesNotMatch(requested[0] ?? "", /metadata\./u);
});

test("Fly Machine inventory preserves authoritative standby relationships", async () => {
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async () =>
      Response.json([
        {
          id: "primary-1",
          state: "started",
          region: "iad",
          image_ref: { digest: `sha256:${"a".repeat(64)}` },
          config: { image: "registry.fly.io/example@sha256:abc" },
        },
        {
          id: "standby-1",
          state: "stopped",
          region: "iad",
          config: {
            image: "registry.fly.io/example@sha256:abc",
            standbys: ["primary-1"],
          },
        },
      ])) as unknown as typeof fetch,
  });

  const machines = await client.listAppMachines({ appName: "app-1" });

  assert.deepEqual(
    machines.map((machine) => ({
      id: machine.id,
      resolvedImageDigest: machine.resolvedImageDigest,
      standbyForMachineIds: machine.standbyForMachineIds,
    })),
    [
      {
        id: "primary-1",
        resolvedImageDigest: `sha256:${"a".repeat(64)}`,
        standbyForMachineIds: [],
      },
      {
        id: "standby-1",
        resolvedImageDigest: undefined,
        standbyForMachineIds: ["primary-1"],
      },
    ],
  );
});

test("Fly waits split long deadlines into accepted request windows", async () => {
  const requests: string[] = [];
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (url: string | URL | Request) => {
      requests.push(String(url));
      if (String(url).includes("/wait?")) {
        return requests.filter((request) => request.includes("/wait?"))
          .length === 1
          ? new Response(null, { status: 408 })
          : Response.json({});
      }
      return Response.json({
        id: "machine-1",
        instance_id: "instance-1",
        state: "starting",
        region: "iad",
        config: {},
      });
    }) as typeof fetch,
  });
  await client.waitForMachine({
    appName: "kestrel-env-abc",
    machineId: "machine-1",
    state: "started",
    timeoutSeconds: 90,
  });
  assert.equal(requests.filter((url) => url.includes("/wait?")).length, 2);
  assert.match(requests[0] ?? "", /[?&]timeout=60(?:&|$)/u);
});

test("Fly waits accept the authoritative target state after a timeout", async () => {
  const requests: string[] = [];
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (url: string | URL | Request) => {
      requests.push(String(url));
      if (String(url).includes("/wait?")) {
        return new Response(null, { status: 408 });
      }
      return Response.json({
        id: "machine-1",
        instance_id: "instance-1",
        state: "started",
        region: "iad",
        config: {},
      });
    }) as typeof fetch,
  });

  await client.waitForMachine({
    appName: "kestrel-env-abc",
    machineId: "machine-1",
    state: "started",
    timeoutSeconds: 60,
  });

  assert.equal(requests.filter((url) => url.includes("/wait?")).length, 1);
});

test("Fly waits continue through an authoritative replacing state", async () => {
  const requests: string[] = [];
  const sleeps: number[] = [];
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    sleepImpl: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    fetchImpl: (async (url: string | URL | Request) => {
      requests.push(String(url));
      if (String(url).includes("/wait?") && requests.length === 1) {
        return new Response(null, { status: 409 });
      }
      if (!String(url).includes("/wait?")) {
        return Response.json({
          id: "machine-1",
          instance_id: "instance-1",
          state: "replacing",
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
    state: "started",
    timeoutSeconds: 60,
  });

  assert.deepEqual(sleeps, [1000]);
  assert.equal(requests.filter((url) => url.includes("/wait?")).length, 2);
});

test("Fly waits preserve a 409 outside the replacing transition", async () => {
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (url: string | URL | Request) => {
      if (String(url).includes("/wait?")) {
        return new Response(null, { status: 409 });
      }
      return Response.json({
        id: "machine-1",
        instance_id: "instance-1",
        state: "destroying",
        region: "iad",
        config: {},
      });
    }) as typeof fetch,
  });

  await assert.rejects(
    client.waitForMachine({
      appName: "kestrel-env-abc",
      machineId: "machine-1",
      state: "started",
      timeoutSeconds: 60,
    }),
    (error: unknown) =>
      error instanceof EnvironmentProviderError && error.status === 409,
  );
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

test("Fly start is idempotent when another request already started the Machine", async () => {
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
    ["POST", "GET"],
  );
});

test("Fly start accepts authoritative started state after an ambiguous timeout", async () => {
  const methods: string[] = [];
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "POST") return new Response(null, { status: 408 });
      return Response.json({
        id: "machine-1",
        state: "started",
        region: "iad",
        config: {},
      });
    }) as typeof fetch,
  });

  await client.startMachine({
    appName: "kestrel-env-abc",
    machineId: "machine-1",
  });

  assert.deepEqual(methods, ["POST", "GET"]);
});

test("Fly start defers mutation replay after a timeout with safe stopped state", async () => {
  const methods: string[] = [];
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "POST") return new Response(null, { status: 408 });
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
    (error: unknown) =>
      error instanceof EnvironmentProviderError &&
      error.status === 408 &&
      (error as EnvironmentProviderError & { authoritativeState?: unknown })
        .authoritativeState !== undefined,
  );
  assert.deepEqual(methods, ["POST", "GET"]);
});

test("Fly start waits out an in-progress stop before issuing the start", async () => {
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
    ["POST", "GET", "GET", "GET", "POST"],
  );
  assert.match(requests[3]?.url ?? "", /[?&]state=stopped(?:&|$)/u);
});

test("Fly start retries a transient stopped-state rejection once per interval", async () => {
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
    ["POST", "GET", "POST"],
  );
  assert.deepEqual(sleeps, [1000]);
});

test("Fly start retries while a replacement Machine is created", async () => {
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
          state: "created",
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
    ["POST", "GET", "POST"],
  );
  assert.deepEqual(sleeps, [1000]);
});

test("Fly start waits for an authoritative replacement to finish", async () => {
  const requests: Array<{ method: string; url: string }> = [];
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const request = { method: init?.method ?? "GET", url: String(url) };
      requests.push(request);
      if (request.method === "POST") return new Response(null, { status: 412 });
      if (request.url.includes("/wait?")) return Response.json({ ok: true });
      return Response.json({
        id: "machine-1",
        state: "replacing",
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
    ["POST", "GET", "GET"],
  );
  assert.match(requests[2]?.url ?? "", /[?&]state=started(?:&|$)/u);
});

test("Fly start fails closed after ten stopped-state retries", async () => {
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
    /remained stopped after 10 bounded start retries/u,
  );

  assert.equal(
    requests.filter((request) => request.method === "POST").length,
    11,
  );
  assert.equal(
    requests.filter((request) => request.method === "GET").length,
    11,
  );
  assert.deepEqual(
    sleeps,
    Array.from({ length: 10 }, () => 1000),
  );
});

test("Fly start fails closed when the authoritative state cannot be retried", async () => {
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
    /authoritative Machine state was suspended/u,
  );
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
        checks: [
          {
            name: "workspace",
            status: "critical",
            output: "token=super-secret\nprocess exited with status 1",
          },
        ],
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
    },
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
    serviceToken: "workspace-service-token",
    source: { type: "blank" },
    idleTimeoutMinutes: 15,
  });
  const volumeCreate = requests.find(
    (request) =>
      request.url.endsWith("/volumes") && request.init.method === "POST",
  );
  const machineCreate = requests.find(
    (request) =>
      request.url.endsWith("/machines") && request.init.method === "POST",
  );
  const volumeBody = JSON.parse(String(volumeCreate?.init.body));
  const machineBody = JSON.parse(String(machineCreate?.init.body));
  assert.equal(volumeBody.encrypted, true);
  assert.equal(volumeBody.size_gb, 20);
  assert.equal(volumeBody.auto_backup_enabled, false);
  assert.equal(volumeBody.snapshot_retention, 14);
  assert.deepEqual(machineBody.config.mounts, [
    { volume: "vol-1", path: "/workspace" },
  ]);
  assert.equal(machineBody.config.guest.memory_mb, 4096);
  assert.equal(machineBody.config.env.KESTREL_ENABLE_MANAGED_WORKTREES, "true");
  assert.equal(machineBody.config.env.KESTREL_REQUIRE_MANAGED_WORKTREE, "true");
  assert.equal(
    machineBody.config.env.KESTREL_MANAGED_WORKTREE_ISOLATION,
    "session",
  );
  assert.equal(machineBody.config.env.FLY_API_TOKEN, undefined);
  assert.equal(
    machineBody.config.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY,
    undefined,
  );
  assert.match(
    machineBody.config.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY,
    /PUBLIC KEY/u,
  );
  assert.equal(
    machineBody.config.env.KESTREL_ONE_APP_URL,
    "https://kestrel.example",
  );
  assert.equal(
    machineBody.config.env.KESTREL_ONE_CREDENTIAL_BROKER_TOKEN,
    undefined,
  );
  assert.equal(
    machineBody.config.env.KESTREL_WORKSPACE_PREVIEWS_ENABLED,
    undefined,
  );
  assert.equal(
    machineBody.config.env.KESTREL_WORKSPACE_SERVICE_TOKEN,
    "workspace-service-token",
  );
  assert.equal(machineBody.config.env.OPENAI_API_KEY, undefined);
  assert.equal(machineBody.config.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(machineBody.config.env.OPENROUTER_API_KEY, undefined);
  assert.equal(machineBody.config.services, undefined);
});

test("existing Fly volumes converge to the Kestrel backup policy in place", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Response.json({ id: "vol-1" });
    }) as typeof fetch,
  });
  await client.reconcileWorkspaceVolumeBackupPolicy({
    appName: "kestrel-env-abc",
    volumeId: "vol-1",
  });
  const request = requests[0];
  assert.match(request?.url ?? "", /\/volumes\/vol-1$/u);
  assert.equal(request?.init?.method, "PUT");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    auto_backup_enabled: false,
    snapshot_retention: 14,
  });
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
    ticketPublicKey: environmentTicketPublicKey.trim(),
    controlPlaneUrl: "https://kestrel.example",
    initExec: ["node", "--eval", "fixture"],
  });
  assert.equal(gateway.routerUrl, "https://kestrel-env-abc.fly.dev");
  assert.equal(gateway.sharedIp, "203.0.113.1");
  const ipCreate = requests.find(
    ({ url, init }) =>
      url.endsWith("/ip_assignments") && init.method === "POST",
  );
  assert.deepEqual(JSON.parse(String(ipCreate?.init.body)), {
    type: "shared_v4",
  });
  const machineCreate = requests.find(
    ({ url, init }) => url.endsWith("/machines") && init.method === "POST",
  );
  const machineBody = JSON.parse(String(machineCreate?.init.body));
  assert.equal(machineBody.config.image, "registry.fly.io/router@sha256:abc");
  assert.equal(machineBody.config.services[0].internal_port, 8080);
  assert.equal(machineBody.config.services[0].min_machines_running, 1);
  assert.deepEqual(machineBody.config.init.exec, [
    "node",
    "--eval",
    "fixture",
  ]);
  assert.equal(
    machineBody.config.env.KESTREL_ENVIRONMENT_APP_NAME,
    "kestrel-env-abc",
  );
  assert.equal(
    machineBody.config.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY,
    environmentTicketPublicKey,
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
      ticketPublicKey: environmentTicketPublicKey,
      controlPlaneUrl: "https://kestrel.example",
    }),
    /immutable ingress contract/u,
  );
});

test("Environment gateway reuses semantically identical canonical ticket keys", async () => {
  const requests: Array<{ method: string; url: string }> = [];
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      requests.push({ method: init?.method ?? "GET", url: path });
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
            image: "registry.fly.io/router@sha256:current",
            env: {
              KESTREL_ENVIRONMENT_APP_NAME: "kestrel-env-abc",
              KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY: environmentTicketPublicKey,
              KESTREL_CONTROL_PLANE_URL: "https://kestrel.example",
              KESTREL_ENVIRONMENT_GATEWAY_SERVICE_TOKEN: "service-token",
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

  await client.ensureEnvironmentGateway({
    appName: "kestrel-env-abc",
    environmentId: "environment-1",
    region: "iad",
    runtimeImage: "registry.fly.io/router@sha256:current",
    ticketPublicKey: environmentTicketPublicKey.trim(),
    controlPlaneUrl: "https://kestrel.example",
  });

  assert.deepEqual(
    requests.map(({ method }) => method),
    ["GET", "GET"],
  );
});

test("Environment gateway rejects different or invalid existing ticket keys", async () => {
  for (const existingTicketPublicKey of [
    rotatedEnvironmentTicketPublicKey,
    "invalid-existing-key",
  ]) {
    const client = new FlyMachinesClient({
      token: "test-token",
      organizationSlug: "kestrel-test",
      fetchImpl: (async (url: string | URL | Request) => {
        if (String(url).endsWith("/ip_assignments")) {
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
              image: "registry.fly.io/router@sha256:current",
              env: {
                KESTREL_ENVIRONMENT_APP_NAME: "kestrel-env-abc",
                KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY: existingTicketPublicKey,
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
        ticketPublicKey: environmentTicketPublicKey,
        controlPlaneUrl: "https://kestrel.example",
      }),
      (error: unknown) =>
        error instanceof EnvironmentProviderError &&
        error.code === "FLY_RESOURCE_CONFLICT",
    );
  }
});

test("Environment gateway rejects invalid desired ticket keys before Fly access", async () => {
  for (const ticketPublicKey of ["invalid-key", nonEd25519PublicKey]) {
    let requests = 0;
    const client = new FlyMachinesClient({
      token: "test-token",
      organizationSlug: "kestrel-test",
      fetchImpl: (async () => {
        requests += 1;
        return Response.json({});
      }) as unknown as typeof fetch,
    });

    await assert.rejects(
      client.ensureEnvironmentGateway({
        appName: "kestrel-env-abc",
        environmentId: "environment-1",
        region: "iad",
        runtimeImage: "registry.fly.io/router@sha256:current",
        ticketPublicKey,
        controlPlaneUrl: "https://kestrel.example",
      }),
      (error: unknown) =>
        error instanceof EnvironmentProviderError &&
        error.code === "FLY_PROVIDER_REJECTED",
    );
    assert.equal(requests, 0);
  }
});

test("Fly rejection retains only bounded, redacted provider evidence", async () => {
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async () =>
      Response.json(
        {
          error: `Machine rejected token=FlyV1-secret ${"detail ".repeat(80)}`,
          request_body: "must-never-be-stored",
        },
        { status: 400, headers: { "fly-request-id": "fly-request-123" } },
      )) as unknown as typeof fetch,
  });
  await assert.rejects(
    () =>
      client.ensureEnvironmentApp({
        appName: "kestrel-env-abc",
        networkName: "kestrel-abc-network",
      }),
    (error: unknown) => {
      assert.ok(error instanceof EnvironmentProviderError);
      assert.equal(error.phase, "fly.environment.app.get");
      assert.equal(error.status, 400);
      assert.equal(error.requestId, "fly-request-123");
      assert.ok((error.providerDetail?.length ?? 0) <= 300);
      assert.match(error.providerDetail ?? "", /token=\[redacted\]/u);
      assert.doesNotMatch(error.message, /FlyV1-secret|must-never-be-stored/u);
      return true;
    },
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
    { id: "snapshot-1", state: "prepare" },
  );
  assert.match(requestedUrl, /\/apps\/app-1\/volumes\/vol-1\/snapshots$/u);
});

test("Fly snapshot inventory uses the provider client's scoped authority", async () => {
  const requests: Array<{ authorization: string | null; url: string }> = [];
  const client = new FlyMachinesClient({
    token: "organization-scoped-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const headers = new Headers(init?.headers);
      requests.push({
        authorization: headers.get("authorization"),
        url: String(input),
      });
      return Response.json([
        { id: "snapshot-1", status: "running" },
        { id: "snapshot-2", state: "created" },
      ]);
    }) as typeof fetch,
  });

  assert.deepEqual(
    await client.listVolumeSnapshots({ appName: "app-1", volumeId: "vol-1" }),
    [
      { id: "snapshot-1", state: "running" },
      { id: "snapshot-2", state: "created" },
    ],
  );
  assert.deepEqual(requests, [
    {
      authorization: "Bearer organization-scoped-token",
      url: "https://api.machines.dev/v1/apps/app-1/volumes/vol-1/snapshots",
    },
  ]);
});

test("Fly image updates are idempotent across tag aliases of the same digest", async () => {
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
    ["GET"],
  );
});

test("Fly platform image updates install the exact named health check", async () => {
  const requests: Array<{ method: string; body: TestMachineRequestBody | null }> = [];
  const currentConfig = {
    image: "registry.fly.io/kestrel-one-turn-worker:production-41-1",
    env: { KESTREL_WORKER_HEALTH_PORT: "8081" },
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
    appName: "kestrel-one-turn-worker",
    machineId: "machine-1",
    runtimeImage: "registry.fly.io/kestrel-one-turn-worker:production-42-1",
    healthCheck: {
      name: "worker",
      port: 8081,
      path: "/healthz",
      timeoutSeconds: 5,
      gracePeriodSeconds: 30,
    },
  });
  assert.equal(requests[1]?.body?.config?.checks?.worker?.path, "/healthz");
  assert.equal(requests[1]?.body?.config?.checks?.worker?.port, 8081);
  assert.equal(
    requests[1]?.body?.config?.checks?.worker?.timeout,
    5_000_000_000,
  );
});

test("Fly platform image updates repair stale health check timing", async () => {
  const requests: Array<{ method: string; body: TestMachineRequestBody | null }> = [];
  const image = "registry.fly.io/kestrel-one-turn-worker:production-42-1";
  const currentConfig = {
    image,
    checks: {
      worker: {
        type: "http",
        port: 8081,
        method: "GET",
        path: "/healthz",
        interval: "15s",
        timeout: "2s",
        grace_period: "10s",
      },
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
    appName: "kestrel-one-turn-worker",
    machineId: "machine-1",
    runtimeImage: image,
    healthCheck: {
      name: "worker",
      port: 8081,
      path: "/healthz",
      timeoutSeconds: 5,
      gracePeriodSeconds: 30,
    },
  });
  assert.equal(requests.length, 2);
  assert.equal(
    requests[1]?.body?.config?.checks?.worker?.timeout,
    5_000_000_000,
  );
  assert.equal(
    requests[1]?.body?.config?.checks?.worker?.grace_period,
    30_000_000_000,
  );
});

test("Fly platform standby creation clones configuration without launching", async () => {
  const requests: Array<{ method: string; body: TestMachineRequestBody | null }> = [];
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ method: init?.method ?? "GET", body });
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({
          id: "active",
          state: "started",
          region: "iad",
          config: {
            image: "registry.fly.io/kestrel-one-runpod-worker:production-41-1",
            env: { KESTREL_WORKER_HEALTH_PORT: "8081" },
          },
        });
      }
      return Response.json({
        id: "standby",
        state: "created",
        region: "iad",
        config: body?.config,
      });
    }) as typeof fetch,
  });
  const standby = await client.cloneMachineAsStoppedStandby({
    appName: "kestrel-one-runpod-worker",
    machineId: "active",
    runtimeImage: "registry.fly.io/kestrel-one-runpod-worker:production-42-1",
    concurrency: 16,
    standbyForMachineIds: ["active"],
    healthCheck: {
      name: "worker",
      port: 8081,
      path: "/healthz",
      timeoutSeconds: 5,
      gracePeriodSeconds: 30,
    },
  });
  assert.equal(standby.id, "standby");
  assert.equal(requests[1]?.body?.skip_launch, true);
  assert.equal(
    requests[1]?.body?.config?.image,
    "registry.fly.io/kestrel-one-runpod-worker:production-42-1",
  );
  assert.equal(requests[1]?.body?.config?.checks?.worker?.path, "/healthz");
  assert.deepEqual(requests[1]?.body?.config?.standbys, ["active"]);
  assert.equal(
    requests[1]?.body?.config?.env?.KESTREL_TURN_WORKER_CONCURRENCY,
    "16",
  );
  await client.cloneMachineAsStoppedIndependent({
    appName: "kestrel-one-runpod-worker",
    machineId: "active",
    runtimeImage: "registry.fly.io/kestrel-one-runpod-worker:production-42-1",
    concurrency: 16,
    healthCheck: {
      name: "worker",
      port: 8081,
      path: "/healthz",
      timeoutSeconds: 5,
      gracePeriodSeconds: 30,
    },
  });
  assert.deepEqual(requests[3]?.body?.config?.standbys, []);
});

type TestMachineRequestBody = {
  skip_launch?: boolean;
  config?: {
    image?: string;
    env?: Record<string, string>;
    standbys?: string[];
    checks?: Record<
      string,
      {
        path?: string;
        port?: number;
        timeout?: number;
        grace_period?: number;
      }
    >;
  };
};

test("Fly Workspace image updates repair missing graceful stop configuration", async () => {
  const requests: Array<{ method: string; body: unknown }> = [];
  const digest = `sha256:${"b".repeat(64)}`;
  const currentConfig = {
    image: `registry.fly.io/kestrel-one-runner@${digest}`,
    env: { KESTREL_WORKSPACE_ID: "workspace-1" },
  };
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : null;
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
    runtimeImage: `registry.fly.io/kestrel-one-runner@${digest}`,
    stopConfig: KESTREL_WORKSPACE_STOP_CONFIG,
  });

  assert.deepEqual(
    requests.map(({ method }) => method),
    ["GET", "POST"],
  );
  const update = requests[1]?.body as {
    config?: { stop_config?: unknown };
  };
  assert.deepEqual(update.config?.stop_config, KESTREL_WORKSPACE_STOP_CONFIG);
});

test("Fly image updates accept authoritative configuration after an ambiguous timeout", async () => {
  const methods: string[] = [];
  const digest = `sha256:${"e".repeat(64)}`;
  const currentConfig = {
    image: `registry.fly.io/kestrel-one-runner@sha256:${"f".repeat(64)}`,
    env: { KESTREL_WORKSPACE_ID: "workspace-1" },
  };
  const desiredConfig = {
    image: `registry.fly.io/kestrel-one-runner@${digest}`,
    env: {
      KESTREL_WORKSPACE_ID: "workspace-1",
      KESTREL_WORKSPACE_SERVICE_TOKEN: "rotated-token",
    },
    stop_config: KESTREL_WORKSPACE_STOP_CONFIG,
  };
  let getCount = 0;
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "POST") return new Response(null, { status: 408 });
      getCount += 1;
      return Response.json({
        id: "machine-1",
        state: "started",
        region: "iad",
        instance_id: `instance-${getCount}`,
        config: getCount === 1 ? currentConfig : desiredConfig,
      });
    }) as typeof fetch,
  });

  const machine = await client.updateMachineImage({
    appName: "app-1",
    machineId: "machine-1",
    runtimeImage: desiredConfig.image,
    envPatch: { KESTREL_WORKSPACE_SERVICE_TOKEN: "rotated-token" },
    stopConfig: KESTREL_WORKSPACE_STOP_CONFIG,
  });

  assert.equal(machine.image, desiredConfig.image);
  assert.deepEqual(methods, ["GET", "POST", "GET"]);
});

test("Fly Workspace image updates verify the persisted graceful stop configuration", async () => {
  const methods: string[] = [];
  const digest = `sha256:${"d".repeat(64)}`;
  const currentConfig = {
    image: `registry.fly.io/kestrel-one-runner@${digest}`,
    env: { KESTREL_WORKSPACE_ID: "workspace-1" },
  };
  let getCount = 0;
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    healthPollIntervalMs: 0,
    sleepImpl: async () => {},
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "GET") getCount += 1;
      return Response.json({
        id: "machine-1",
        state: "started",
        region: "iad",
        instance_id: "instance-1",
        config:
          getCount >= 2
            ? {
                ...currentConfig,
                stop_config: KESTREL_WORKSPACE_STOP_CONFIG,
              }
            : currentConfig,
      });
    }) as typeof fetch,
  });

  await client.updateMachineImage({
    appName: "app-1",
    machineId: "machine-1",
    runtimeImage: `registry.fly.io/kestrel-one-runner@${digest}`,
    stopConfig: KESTREL_WORKSPACE_STOP_CONFIG,
  });

  assert.deepEqual(methods, ["GET", "POST", "GET"]);
});

test("Fly Workspace image updates accept canonical graceful stop durations", async () => {
  const requests: Array<{ method: string; body: unknown }> = [];
  const digest = `sha256:${"c".repeat(64)}`;
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ method: init?.method ?? "GET", body });
      return Response.json({
        id: "machine-1",
        state: "started",
        region: "iad",
        instance_id: "instance-1",
        config: {
          image: `registry.fly.io/kestrel-one-runner@${digest}`,
          env: { KESTREL_WORKSPACE_ID: "workspace-1" },
          stop_config: {
            signal: "SIGTERM",
            timeout: "2m0s",
          },
        },
      });
    }) as typeof fetch,
  });

  await client.updateMachineImage({
    appName: "app-1",
    machineId: "machine-1",
    runtimeImage: `registry.fly.io/kestrel-one-runner@${digest}`,
    stopConfig: KESTREL_WORKSPACE_STOP_CONFIG,
  });

  assert.deepEqual(
    requests.map(({ method }) => method),
    ["GET"],
  );
});

test("Fly workspace updates reconcile environment values without replacing unrelated configuration", async () => {
  const requests: Array<{ method: string; body: unknown }> = [];
  const digest = `sha256:${"a".repeat(64)}`;
  const currentConfig = {
    image: `registry.fly.io/kestrel-one-runner@${digest}`,
    env: {
      KESTREL_WORKSPACE_ID: "workspace-1",
      KESTREL_WORKSPACE_PREVIEWS_ENABLED: "true",
      KESTREL_RUNTIME_REVISION: "old-revision",
    },
  };
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : null;
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
      KESTREL_RUNTIME_REVISION: "new-revision",
    },
  });

  assert.deepEqual(
    requests.map(({ method }) => method),
    ["GET", "POST"],
  );
  const update = requests[1]?.body as {
    config?: { env?: Record<string, string> };
  };
  assert.deepEqual(update.config?.env, {
    KESTREL_WORKSPACE_ID: "workspace-1",
    KESTREL_WORKSPACE_PREVIEWS_ENABLED: "true",
    KESTREL_RUNTIME_REVISION: "new-revision",
  });

  await client.updateMachineImage({
    appName: "app-1",
    machineId: "machine-1",
    runtimeImage: `registry.fly.io/kestrel-one-runner@${digest}`,
    envPatch: {
      KESTREL_WORKSPACE_PREVIEWS_ENABLED: undefined,
      KESTREL_RUNTIME_REVISION: undefined,
    },
  });
  const disableUpdate = requests[3]?.body as {
    config?: { env?: Record<string, string> };
  };
  assert.deepEqual(disableUpdate.config?.env, {
    KESTREL_WORKSPACE_ID: "workspace-1",
  });
});

test("Fly idempotent Workspace provisioning rotates the scoped service identity", async () => {
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
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ method: init?.method ?? "GET", body });
      return Response.json(
        init?.method === "POST"
          ? { ...current, config: body.config }
          : [current],
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
    ticketPublicKey:
      "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
    controlPlaneUrl: "https://kestrel.example",
    serviceToken: "new-token",
    source: { type: "blank" },
    idleTimeoutMinutes: 15,
  });
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["GET", "POST"],
  );
  const update = requests[1]?.body as {
    config?: { env?: Record<string, string> };
  };
  assert.deepEqual(update.config?.env, {
    KESTREL_WORKSPACE_ID: "workspace-1",
    KESTREL_WORKSPACE_SERVICE_TOKEN: "new-token",
  });
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
    ],
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
      if (init?.method === "GET" && pathname.endsWith("/machines")) {
        return Response.json([
          {
            id: "old-machine-id",
            state: "stopped",
            region: "iad",
            config: {
              image: "registry.fly.io/runtime@sha256:old",
              stop_config: null,
            },
          },
        ]);
      }
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
        config: {
          mounts: null,
          services: null,
          stop_config: null,
        },
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
    ({ url, init }) => url.endsWith("/volumes") && init.method === "POST",
  );
  const machineCreate = requests.find(
    ({ url, init }) => url.endsWith("/machines") && init.method === "POST",
  );
  const volumeBody = JSON.parse(String(volumeCreate?.init.body));
  const machineBody = JSON.parse(String(machineCreate?.init.body));
  assert.match(volumeBody.name, /_r_/u);
  assert.equal(
    machineBody.config.metadata.kestrel_replacement_id,
    "restore-operation-1",
  );
  assert.equal(machineBody.config.mounts[0].volume, "replacement-volume-id");
  assert.deepEqual(
    machineBody.config.stop_config,
    KESTREL_WORKSPACE_STOP_CONFIG,
  );
});

test("Fly snapshot replacement volumes validate ownership and wait until created", async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    healthPollIntervalMs: 1,
    sleepImpl: async () => {},
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ url: requestUrl, method, body });
      const pathname = new URL(requestUrl).pathname;
      if (pathname.endsWith("/volumes/source-volume/snapshots")) {
        return Response.json([{ id: "snapshot-created", status: "created" }]);
      }
      if (pathname.endsWith("/volumes") && method === "GET") {
        return Response.json([]);
      }
      if (pathname.endsWith("/volumes") && method === "POST") {
        return Response.json(
          {
            id: "replacement-volume",
            name: body.name,
            region: "iad",
            size_gb: 20,
            encrypted: true,
            state: "restoring",
          },
          { status: 202 },
        );
      }
      return Response.json({
        id: "replacement-volume",
        name: "replacement-volume",
        region: "iad",
        size_gb: 20,
        encrypted: true,
        state: "created",
      });
    }) as typeof fetch,
  });

  const volume = await client.createReplacementWorkspaceVolume({
    appName: "app-1",
    workspaceId: "workspace-1",
    region: "iad",
    replacementId: "restore-operation-1",
    sourceVolumeId: "source-volume",
    snapshotId: "snapshot-created",
  });

  assert.equal(volume.id, "replacement-volume");
  const create = requests.find(
    (request) =>
      request.method === "POST" &&
      new URL(request.url).pathname.endsWith("/volumes"),
  );
  assert.equal(
    (create?.body as { snapshot_id?: string }).snapshot_id,
    "snapshot-created",
  );
  assert.equal(
    requests.some((request) =>
      new URL(request.url).pathname.endsWith("/volumes/replacement-volume"),
    ),
    true,
  );
});

test("Fly snapshot replacement rejects foreign or incomplete snapshots", async () => {
  const createClient = (snapshots: unknown) =>
    new FlyMachinesClient({
      token: "test-token",
      organizationSlug: "kestrel-test",
      fetchImpl: (async () =>
        Response.json(snapshots)) as unknown as typeof fetch,
    });
  const input = {
    appName: "app-1",
    workspaceId: "workspace-1",
    region: "iad",
    replacementId: "restore-operation-1",
    sourceVolumeId: "source-volume",
    snapshotId: "snapshot-requested",
  };

  await assert.rejects(
    createClient([
      { id: "snapshot-from-another-volume", status: "created" },
    ]).createReplacementWorkspaceVolume(input),
    (error: unknown) =>
      error instanceof EnvironmentProviderError &&
      error.code === "FLY_RESOURCE_CONFLICT",
  );
  await assert.rejects(
    createClient([
      { id: "snapshot-requested", status: "preparing" },
    ]).createReplacementWorkspaceVolume(input),
    (error: unknown) =>
      error instanceof EnvironmentProviderError &&
      error.code === "FLY_RESOURCE_CONFLICT",
  );
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
              state: "pending_destroy",
              region: "iad",
              size_gb: 20,
              encrypted: true,
              attached_machine_id: "machine-1",
            },
            {
              id: "volume-tombstone",
              name: "ws_workspace1_r_operation1",
              state: "pending_destroy",
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
          state: "started",
          region: "iad",
          workspaceId: "workspace-1",
          replacementId: "restore-1",
          mountedVolumeIds: ["volume-1"],
        },
      ],
      volumes: [
        {
          id: "volume-1",
          name: "ws_workspace1",
          state: "pending_destroy",
          region: "iad",
          sizeGb: 20,
          attachedMachineId: "machine-1",
        },
        {
          id: "volume-tombstone",
          name: "ws_workspace1_r_operation1",
          state: "pending_destroy",
          region: "iad",
          sizeGb: 20,
          attachedMachineId: undefined,
        },
      ],
    },
  );
});

test("Fly Machine lookup preserves exact Workspace mount evidence", async () => {
  const client = new FlyMachinesClient({
    token: "test-token",
    organizationSlug: "kestrel-test",
    fetchImpl: (async () =>
      Response.json({
        id: "machine-1",
        state: "stopped",
        region: "iad",
        checks: [
          {
            name: "workspace",
            status: "critical",
            output: "Authorization: Bearer secret-token\nrunner unavailable",
            updated_at: "2026-08-20T17:00:00.000Z",
          },
        ],
        config: {
          guest: { cpu_kind: "shared", cpus: 2, memory_mb: 4096 },
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
      standbyForMachineIds: [],
      cpuKind: "shared",
      cpus: 2,
      memoryMb: 4096,
      workspaceId: "workspace-1",
      checks: [
        {
          name: "workspace",
          status: "critical",
          output: "Authorization=[redacted] runner unavailable",
          updatedAt: "2026-08-20T17:00:00.000Z",
        },
      ],
      mounts: [
        {
          volumeId: "volume-1",
          name: "ws_workspace1",
          path: "/workspace",
        },
      ],
    },
  );
});
