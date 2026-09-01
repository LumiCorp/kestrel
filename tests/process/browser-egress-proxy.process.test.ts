import assert from "node:assert/strict";
import http, { type Server as HttpServer } from "node:http";
import net, {
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from "node:net";
import test from "node:test";

import type { McpResolvedAddress } from "../../packages/mcp-security/src/index.js";

import {
  createLocalCoreBrowserEgressProxy,
  type LocalCoreBrowserEgressMetric,
  type LocalCoreBrowserEgressAuthorityBindingV1,
  type LocalCoreBrowserEgressLaunchBindingV1,
  type LocalCoreBrowserEgressProxy,
} from "../../src/localCore/browserEgressProxy.js";
import {
  BROWSER_EFFECTIVE_DOMAIN_AUTHORITY_VERSION,
  canonicalizePublicBrowserDestination,
  canonicalizeTrustedBrowserQaTarget,
  type BrowserEffectiveDomainAuthorityV1,
} from "../../src/browser/domainAuthority.js";

test("Local Core proxy authenticates and forwards only the exact recorded QA origin", async (t) => {
  const upstream = http.createServer((request, response) => {
    assert.equal(request.headers["proxy-authorization"], undefined);
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "http://localhost:1/escaped" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`${request.method}:${request.url}`);
  });
  const upstreamPort = await listen(upstream);

  let resolutions = 0;
  const metrics: LocalCoreBrowserEgressMetric[] = [];
  const proxy = await createLocalCoreBrowserEgressProxy({
    ...binding(qaAuthority(upstreamPort, "qa-r1"), "qa"),
    dependencies: {
      resolve: async () => {
        resolutions += 1;
        return [{ address: "127.0.0.1", family: 4 }];
      },
      randomSecret: () => "qa-session-secret",
      metrics: { record: (metric) => metrics.push(metric) },
    },
  });
  t.after(async () => {
    await proxy.close();
    await closeServer(upstream);
  });

  assert.equal(new URL(proxy.launchBinding.proxyServer).hostname, "127.0.0.1");
  assert.ok(
    proxy.launchBinding.chromiumFlags.includes(
      "--proxy-bypass-list=<-loopback>",
    ),
  );
  assert.ok(proxy.launchBinding.chromiumFlags.includes("--disable-quic"));
  assert.doesNotMatch(
    JSON.stringify(proxy.launchBinding.chromiumFlags),
    /qa-session-secret/u,
  );

  assert.equal(
    await proxyRequest(
      proxy.launchBinding,
      `http://localhost:${upstreamPort}/snapshot`,
    ),
    "GET:/snapshot",
  );
  assert.equal(
    await proxyRequest(
      proxy.launchBinding,
      `http://localhost:${upstreamPort}/worker.js`,
    ),
    "GET:/worker.js",
  );
  assert.equal(
    await proxyRequest(
      proxy.launchBinding,
      `http://localhost:${upstreamPort}/beacon`,
      "POST",
    ),
    "POST:/beacon",
  );
  assert.equal(
    resolutions,
    3,
    "every browser-generated request resolves in the proxy",
  );

  const unauthenticated = await proxyStatus(
    proxy.launchBinding,
    `http://localhost:${upstreamPort}/image.png`,
    null,
  );
  assert.equal(unauthenticated, 407);

  const wrongPort = await proxyStatus(
    proxy.launchBinding,
    "http://localhost:1/escaped?token=metric-secret-sentinel",
  );
  assert.equal(wrongPort, 403);

  const redirect = await proxyResponse(
    proxy.launchBinding,
    `http://localhost:${upstreamPort}/redirect`,
  );
  assert.equal(redirect.status, 302);
  assert.equal(redirect.location, "http://localhost:1/escaped");
  assert.equal(
    await proxyStatus(proxy.launchBinding, redirect.location ?? ""),
    403,
    "the redirected request receives a fresh exact-target decision",
  );
  assert.equal(
    metrics.some(
      (metric) =>
        metric.transport === "request" &&
        metric.reason === "proxy_authentication",
    ),
    true,
  );
  assert.equal(
    metrics.some(
      (metric) =>
        metric.transport === "request" &&
        metric.reason === "destination_policy",
    ),
    true,
  );
  assert.doesNotMatch(JSON.stringify(metrics), /metric-secret-sentinel/u);
});

test("Local Core proxy fails closed when a trusted QA hostname resolves beyond loopback", async (t) => {
  const proxy = await createLocalCoreBrowserEgressProxy({
    ...binding(qaAuthority(4173, "qa-rebind-r1"), "qa"),
    dependencies: {
      resolve: async () => [
        { address: "127.0.0.1", family: 4 },
        { address: "10.0.0.8", family: 4 },
      ],
    },
  });
  t.after(() => proxy.close());

  assert.equal(
    await proxyStatus(proxy.launchBinding, "http://localhost:4173/script.js"),
    403,
  );
});

test("proxy transport failures do not emit destination policy metrics", async (t) => {
  const unavailable = http.createServer();
  const unavailablePort = await listen(unavailable);
  await closeServer(unavailable);
  const metrics: LocalCoreBrowserEgressMetric[] = [];
  const proxy = await createLocalCoreBrowserEgressProxy({
    ...binding(qaAuthority(unavailablePort, "qa-transport-r1"), "qa"),
    dependencies: {
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      dial: () => {
        throw new Error("upstream transport unavailable");
      },
      metrics: { record: (metric) => metrics.push(metric) },
    },
  });
  t.after(() => proxy.close());

  await assert.rejects(
    proxyStatus(
      proxy.launchBinding,
      `http://localhost:${unavailablePort}/unavailable`,
    ),
    /socket hang up|ECONNRESET/u,
  );
  const upgrade = await rawProxyExchange(
    proxy.launchBinding,
    [
      `GET ws://localhost:${unavailablePort}/socket HTTP/1.1`,
      `Host: localhost:${unavailablePort}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      `Proxy-Authorization: ${authorization(proxy.launchBinding)}`,
      "",
      "",
    ].join("\r\n"),
  );
  assert.match(upgrade, /^HTTP\/1\.1 403/u);

  const connectProxy = await createLocalCoreBrowserEgressProxy({
    ...binding(
      operatorAuthority(["example.com"], "operator-transport-r1"),
      "operator",
    ),
    dependencies: {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      dial: () => {
        throw new Error("upstream transport unavailable");
      },
      metrics: { record: (metric) => metrics.push(metric) },
    },
  });
  t.after(() => connectProxy.close());
  assert.equal(
    await connectStatus(connectProxy.launchBinding, "example.com:443"),
    403,
  );
  assert.deepEqual(metrics, []);
});

test("Local Core proxy contains public HTTPS and WSS in authenticated CONNECT tunnels", async (t) => {
  const upstream = net.createServer((socket) => socket.pipe(socket));
  const upstreamPort = await listen(upstream);

  const resolved: string[] = [];
  const dialed: Array<{ address: string; port: number }> = [];
  const metrics: LocalCoreBrowserEgressMetric[] = [];
  const proxy = await createLocalCoreBrowserEgressProxy({
    ...binding(operatorAuthority(["example.com"], "public-r1"), "operator"),
    dependencies: {
      resolve: async (hostname) => {
        resolved.push(hostname);
        return [{ address: "93.184.216.34", family: 4 }];
      },
      dial: ({ address, port }) => {
        dialed.push({ address: address.address, port });
        return net.connect({ host: "127.0.0.1", port: upstreamPort });
      },
      randomSecret: () => "operator-session-secret",
      metrics: { record: (metric) => metrics.push(metric) },
    },
  });
  t.after(async () => {
    await proxy.close();
    await closeServer(upstream);
  });

  const tunnel = await openTunnel(
    proxy.launchBinding,
    "assets.example.com:443",
  );
  t.after(() => tunnel.destroy());
  tunnel.write("browser-subresource");
  assert.equal(await readChunk(tunnel), "browser-subresource");
  assert.deepEqual(resolved, ["assets.example.com"]);
  assert.deepEqual(dialed, [{ address: "93.184.216.34", port: 443 }]);

  assert.equal(
    await connectStatus(proxy.launchBinding, "other.example.net:443"),
    403,
  );
  assert.equal(
    metrics.some(
      (metric) =>
        metric.transport === "connect" &&
        metric.reason === "destination_policy",
    ),
    true,
  );
  assert.equal(
    await connectStatus(proxy.launchBinding, "example.com:8443"),
    403,
  );
  assert.equal(
    await proxyStatus(proxy.launchBinding, "http://example.com/plaintext"),
    403,
  );
});

test("public CONNECT rejects private, mixed, reserved, and changed DNS answers", async (t) => {
  let answers: McpResolvedAddress[] = [{ address: "93.184.216.34", family: 4 }];
  const proxy = await createLocalCoreBrowserEgressProxy({
    ...binding(operatorAuthority(["example.com"], "dns-r1"), "operator"),
    dependencies: {
      resolve: async () => answers,
      dial: () => new net.Socket(),
    },
  });
  t.after(() => proxy.close());

  answers = [{ address: "127.0.0.1", family: 4 }];
  assert.equal(
    await connectStatus(proxy.launchBinding, "example.com:443"),
    403,
  );
  answers = [
    { address: "93.184.216.34", family: 4 },
    { address: "169.254.169.254", family: 4 },
  ];
  assert.equal(
    await connectStatus(proxy.launchBinding, "example.com:443"),
    403,
  );
  answers = [{ address: "2001:db8::1", family: 6 }];
  assert.equal(
    await connectStatus(proxy.launchBinding, "example.com:443"),
    403,
  );
  answers = [{ address: "10.0.0.9", family: 4 }];
  assert.equal(
    await connectStatus(proxy.launchBinding, "example.com:443"),
    403,
    "a later DNS change receives a new address decision",
  );
});

test("revision adoption rebinds stable session credentials and closes revoked tunnels", async (t) => {
  const upstream = net.createServer((socket) => socket.pipe(socket));
  const upstreamPort = await listen(upstream);
  const proxy = await createLocalCoreBrowserEgressProxy({
    ...binding(operatorAuthority(["example.com"], "revision-r1"), "operator"),
    dependencies: {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      dial: () => net.connect({ host: "127.0.0.1", port: upstreamPort }),
      randomSecret: () => "stable-generation-secret",
    },
  });
  t.after(async () => {
    await proxy.close();
    await closeServer(upstream);
  });
  const firstBinding = proxy.launchBinding;
  const tunnel = await openTunnel(firstBinding, "example.com:443");

  const revoked = await proxy.adoptAuthority(
    binding(operatorAuthority([], "revision-r2"), "operator"),
  );
  assert.deepEqual(revoked.receipt, {
    version: "browser_allowlist_adoption_receipt_v1",
    sessionId: "browser-session-1",
    effectiveAllowlistRevision: "revision-r2",
    closedUnauthorizedConnections: 1,
  });
  assert.equal(revoked.launchBinding.username, firstBinding.username);
  assert.equal(revoked.launchBinding.password, firstBinding.password);
  assert.equal(revoked.launchBinding.effectiveAllowlistRevision, "revision-r2");
  await waitForClose(tunnel);
  assert.equal(await connectStatus(firstBinding, "example.com:443"), 403);

  const granted = await proxy.adoptAuthority(
    binding(operatorAuthority(["example.net"], "revision-r3"), "operator"),
  );
  assert.equal(granted.receipt.closedUnauthorizedConnections, 0);
  const nextTunnel = await openTunnel(firstBinding, "www.example.net:443");
  nextTunnel.destroy();

  const replay = await proxy.adoptAuthority(
    binding(operatorAuthority(["example.net"], "revision-r3"), "operator"),
  );
  assert.equal(replay.receipt.closedUnauthorizedConnections, 0);
  assert.equal(replay.launchBinding.password, firstBinding.password);

  await assert.rejects(
    proxy.adoptAuthority({
      ...binding(operatorAuthority(["example.net"], "revision-r4"), "operator"),
      sessionId: "different-session",
    }),
    /different Thread, session, generation, mode, person, Environment, or Project/u,
  );
});

test("a DNS lookup started before revocation cannot establish stale authority afterward", async (t) => {
  let releaseDns: (() => void) | undefined;
  const dnsStarted = new Promise<void>((resolve) => {
    releaseDns = resolve;
  });
  let lookupEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    lookupEntered = resolve;
  });
  let dialCount = 0;
  const proxy = await createLocalCoreBrowserEgressProxy({
    ...binding(operatorAuthority(["example.com"], "race-r1"), "operator"),
    dependencies: {
      resolve: async () => {
        lookupEntered?.();
        await dnsStarted;
        return [{ address: "93.184.216.34", family: 4 }];
      },
      dial: () => {
        dialCount += 1;
        return new net.Socket();
      },
    },
  });
  t.after(() => proxy.close());

  const pending = connectStatus(proxy.launchBinding, "example.com:443");
  await entered;
  const adopted = await proxy.adoptAuthority(
    binding(operatorAuthority([], "race-r2"), "operator"),
  );
  assert.equal(adopted.receipt.closedUnauthorizedConnections, 0);
  releaseDns?.();
  assert.equal(await pending, 403);
  assert.equal(dialCount, 0);
});

test("adoption closes a long-lived EventSource-style response when QA mode is disabled", async (t) => {
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: ready\n\n");
  });
  const upstreamPort = await listen(upstream);
  const proxy = await createLocalCoreBrowserEgressProxy({
    ...binding(qaAuthority(upstreamPort, "stream-r1"), "qa"),
    dependencies: {
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    },
  });
  t.after(async () => {
    await proxy.close();
    await closeServer(upstream);
  });

  const response = await openProxyStream(
    proxy.launchBinding,
    `http://localhost:${upstreamPort}/events`,
  );
  const closed = new Promise<void>((resolve) =>
    response.once("close", () => resolve()),
  );
  const adopted = await proxy.adoptAuthority(
    binding(disabledAuthority("stream-r2"), "qa"),
  );
  assert.equal(adopted.receipt.closedUnauthorizedConnections, 1);
  await closed;
});

test("QA WebSocket upgrade is proxied as an origin-form request with no credential leak", async (t) => {
  let received = "";
  const metrics: LocalCoreBrowserEgressMetric[] = [];
  const upstream = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      received = chunk.toString("utf8");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
    });
  });
  const upstreamPort = await listen(upstream);
  const proxy = await createLocalCoreBrowserEgressProxy({
    ...binding(qaAuthority(upstreamPort, "ws-r1"), "qa"),
    dependencies: {
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      metrics: { record: (metric) => metrics.push(metric) },
    },
  });
  t.after(async () => {
    await proxy.close();
    await closeServer(upstream);
  });

  const response = await rawProxyExchange(
    proxy.launchBinding,
    [
      `GET ws://localhost:${upstreamPort}/socket?channel=browser HTTP/1.1`,
      `Host: localhost:${upstreamPort}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      `Proxy-Authorization: ${authorization(proxy.launchBinding)}`,
      "",
      "",
    ].join("\r\n"),
  );
  assert.match(response, /^HTTP\/1\.1 101/u);
  assert.match(received, /^GET \/socket\?channel=browser HTTP\/1\.1/iu);
  assert.doesNotMatch(
    received,
    /proxy-authorization|stable-generation-secret/iu,
  );
  const denied = await rawProxyExchange(
    proxy.launchBinding,
    [
      "GET ws://localhost:1/blocked?token=upgrade-secret-sentinel HTTP/1.1",
      "Host: localhost:1",
      "Connection: Upgrade",
      "Upgrade: websocket",
      `Proxy-Authorization: ${authorization(proxy.launchBinding)}`,
      "",
      "",
    ].join("\r\n"),
  );
  assert.match(denied, /^HTTP\/1\.1 403/u);
  assert.equal(
    metrics.some(
      (metric) =>
        metric.transport === "upgrade" &&
        metric.reason === "destination_policy",
    ),
    true,
  );
  assert.doesNotMatch(JSON.stringify(metrics), /upgrade-secret-sentinel/u);
});

test("proxy close revokes listener and authority deterministically", async () => {
  const proxy = await createLocalCoreBrowserEgressProxy({
    ...binding(operatorAuthority(["example.com"], "close-r1"), "operator"),
    dependencies: {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    },
  });
  const launch = proxy.launchBinding;
  await proxy.close();
  await proxy.close();
  assert.throws(() => proxy.launchBinding, /proxy is closed/u);
  await assert.rejects(
    proxy.adoptAuthority(
      binding(operatorAuthority(["example.com"], "close-r2"), "operator"),
    ),
    /proxy is closed/u,
  );
  await assert.rejects(
    proxyStatus(launch, "http://example.com/"),
    /ECONNREFUSED|socket hang up/u,
  );
});

function binding(
  authority: BrowserEffectiveDomainAuthorityV1,
  mode: "qa" | "operator",
): LocalCoreBrowserEgressAuthorityBindingV1 {
  return {
    threadId: "thread-1",
    sessionId: "browser-session-1",
    generation: 7,
    mode,
    authority,
  };
}

function operatorAuthority(
  domains: readonly string[],
  revision: string,
): BrowserEffectiveDomainAuthorityV1 {
  return {
    version: BROWSER_EFFECTIVE_DOMAIN_AUTHORITY_VERSION,
    environmentId: "environment-1",
    projectId: "project-1",
    userId: "user-1",
    enabledModes: ["operator"],
    personalGrantsEnabled: true,
    publicDomains: domains.map((domain) =>
      canonicalizePublicBrowserDestination(`https://${domain}`),
    ),
    qaTarget: null,
    effectiveAllowlistRevision: revision,
  };
}

function qaAuthority(
  port: number,
  revision: string,
): BrowserEffectiveDomainAuthorityV1 {
  return {
    version: BROWSER_EFFECTIVE_DOMAIN_AUTHORITY_VERSION,
    environmentId: "environment-1",
    projectId: "project-1",
    userId: "user-1",
    enabledModes: ["qa"],
    personalGrantsEnabled: false,
    publicDomains: [],
    qaTarget: canonicalizeTrustedBrowserQaTarget(`http://localhost:${port}`),
    effectiveAllowlistRevision: revision,
  };
}

function disabledAuthority(
  revision: string,
): BrowserEffectiveDomainAuthorityV1 {
  return {
    version: BROWSER_EFFECTIVE_DOMAIN_AUTHORITY_VERSION,
    environmentId: "environment-1",
    projectId: "project-1",
    userId: "user-1",
    enabledModes: [],
    personalGrantsEnabled: false,
    publicDomains: [],
    qaTarget: null,
    effectiveAllowlistRevision: revision,
  };
}

async function listen(server: HttpServer | NetServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return address.port;
}

async function closeServer(server: HttpServer | NetServer): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function authorization(binding: LocalCoreBrowserEgressLaunchBindingV1): string {
  return `Basic ${Buffer.from(`${binding.username}:${binding.password}`, "utf8").toString("base64")}`;
}

async function proxyRequest(
  binding: LocalCoreBrowserEgressLaunchBindingV1,
  url: string,
  method = "GET",
): Promise<string> {
  const response = await proxyResponse(binding, url, method);
  assert.equal(response.status, 200);
  return response.body;
}

async function proxyStatus(
  binding: LocalCoreBrowserEgressLaunchBindingV1,
  url: string,
  proxyAuthorization: string | null = authorization(binding),
): Promise<number> {
  return (await proxyResponse(binding, url, "GET", proxyAuthorization)).status;
}

async function proxyResponse(
  binding: LocalCoreBrowserEgressLaunchBindingV1,
  url: string,
  method = "GET",
  proxyAuthorization: string | null = authorization(binding),
): Promise<{ status: number; body: string; location?: string | undefined }> {
  const proxy = new URL(binding.proxyServer);
  return await new Promise((resolve, reject) => {
    const request = http.request({
      host: proxy.hostname,
      port: Number(proxy.port),
      method,
      path: url,
      headers: {
        ...(proxyAuthorization === null
          ? {}
          : { "proxy-authorization": proxyAuthorization }),
      },
    });
    request.once("error", reject);
    request.once("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          ...(typeof response.headers.location === "string"
            ? { location: response.headers.location }
            : {}),
        }),
      );
    });
    request.end();
  });
}

async function openProxyStream(
  binding: LocalCoreBrowserEgressLaunchBindingV1,
  url: string,
): Promise<http.IncomingMessage> {
  const proxy = new URL(binding.proxyServer);
  return await new Promise((resolve, reject) => {
    const request = http.request({
      host: proxy.hostname,
      port: Number(proxy.port),
      method: "GET",
      path: url,
      headers: { "proxy-authorization": authorization(binding) },
    });
    request.once("error", reject);
    request.once("response", (response) => {
      response.once("data", () => resolve(response));
    });
    request.end();
  });
}

async function connectStatus(
  binding: LocalCoreBrowserEgressLaunchBindingV1,
  destination: string,
): Promise<number> {
  const response = await rawProxyExchange(
    binding,
    [
      `CONNECT ${destination} HTTP/1.1`,
      `Host: ${destination}`,
      `Proxy-Authorization: ${authorization(binding)}`,
      "",
      "",
    ].join("\r\n"),
  );
  return Number(/^HTTP\/1\.1 (\d{3})/u.exec(response)?.[1] ?? 0);
}

async function openTunnel(
  binding: LocalCoreBrowserEgressLaunchBindingV1,
  destination: string,
): Promise<Socket> {
  const proxy = new URL(binding.proxyServer);
  const socket = net.connect({
    host: proxy.hostname,
    port: Number(proxy.port),
  });
  socket.write(
    [
      `CONNECT ${destination} HTTP/1.1`,
      `Host: ${destination}`,
      `Proxy-Authorization: ${authorization(binding)}`,
      "",
      "",
    ].join("\r\n"),
  );
  const response = await readChunk(socket);
  assert.match(response, /^HTTP\/1\.1 200/u);
  return socket;
}

async function rawProxyExchange(
  binding: LocalCoreBrowserEgressLaunchBindingV1,
  request: string,
): Promise<string> {
  const proxy = new URL(binding.proxyServer);
  const socket = net.connect({
    host: proxy.hostname,
    port: Number(proxy.port),
  });
  socket.write(request);
  try {
    return await readChunk(socket);
  } finally {
    socket.destroy();
  }
}

async function readChunk(socket: Socket): Promise<string> {
  return await new Promise((resolve, reject) => {
    socket.once("data", (chunk) => resolve(chunk.toString("utf8")));
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("socket closed before data")));
  });
}

async function waitForClose(socket: Socket): Promise<void> {
  if (socket.destroyed) return;
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
}
