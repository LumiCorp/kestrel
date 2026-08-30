import assert from "node:assert/strict";
import http from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import test from "node:test";

import {
  HostedBrowserEgressRegistry,
  type HostedBrowserGatewayAuthorityV1,
} from "../src/browser-egress.js";

const authority: HostedBrowserGatewayAuthorityV1 = {
  version: "browser_effective_domain_authority_v1",
  environmentId: "env-1",
  projectId: "project-1",
  userId: "user-1",
  enabledModes: ["operator"],
  publicDomains: [{
    version: "browser_public_domain_authority_v1",
    scheme: "https",
    canonicalDomain: "example.com",
    includeSubdomains: true,
    port: 443,
  }],
  qaTarget: null,
  effectiveAllowlistRevision: "revision-1",
};

test("hosted Browser gateway proxy authenticates and enforces exact authority", async () => {
  const upstream = net.createServer((socket) => socket.write("upstream-ready"));
  await listen(upstream);
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const registry = new HostedBrowserEgressRegistry({
    gatewayMachineId: "gateway-machine-1",
    appName: "kestrel-env-test",
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    dial: () => net.connect({ host: "127.0.0.1", port: upstreamPort }),
  });
  try {
    const binding = await registry.install(session(authority));
    const unauthenticated = await connect(binding, "www.example.com:443");
    assert.match(unauthenticated, /^HTTP\/1\.1 407/u);

    const denied = await connect(binding, "attacker.invalid:443", true);
    assert.match(denied, /^HTTP\/1\.1 403/u);

    const allowed = await connect(binding, "www.example.com:443", true, true);
    assert.match(allowed, /^HTTP\/1\.1 200 Connection Established/u);
    assert.match(allowed, /upstream-ready/u);
  } finally {
    await registry.closeAll();
    await close(upstream);
  }
});

test("hosted Browser gateway shares one fixed listener while credentials isolate sessions", async () => {
  const upstream = net.createServer((socket) => socket.write("upstream-ready"));
  await listen(upstream);
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const registry = new HostedBrowserEgressRegistry({
    gatewayMachineId: "gateway-machine-1",
    appName: "kestrel-env-test",
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    dial: () => net.connect({ host: "127.0.0.1", port: upstreamPort }),
  });
  try {
    const first = await registry.install(session(authority));
    const second = await registry.install({
      ...session(authority),
      threadId: "thread-2",
      sessionId: "browser-session-2",
    });
    assert.equal(first.proxyServer, second.proxyServer);
    assert.equal(new URL(first.proxyServer).port, "43109");
    assert.notEqual(first.username, second.username);
    assert.notEqual(first.password, second.password);
    assert.match(
      await connect(first, "www.example.com:443", true, true),
      /^HTTP\/1\.1 200 Connection Established/u,
    );
    assert.match(
      await connect(second, "www.example.com:443", true, true),
      /^HTTP\/1\.1 200 Connection Established/u,
    );
  } finally {
    await registry.closeAll();
    await close(upstream);
  }
});

test("hosted Browser gateway revision closes connections revoked by the new allowlist", async () => {
  const upstreamSockets = new Set<Socket>();
  const upstream = net.createServer((socket) => upstreamSockets.add(socket));
  await listen(upstream);
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const registry = new HostedBrowserEgressRegistry({
    gatewayMachineId: "gateway-machine-1",
    appName: "kestrel-env-test",
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    dial: () => net.connect({ host: "127.0.0.1", port: upstreamPort }),
  });
  try {
    const binding = await registry.install(session(authority));
    const tunnel = await openTunnel(binding, "www.example.com:443");
    assert.match(tunnel.response, /^HTTP\/1\.1 200 Connection Established/u);
    const adopted = await registry.adopt({
      sessionId: "browser-session-1",
      generation: 1,
      authority: {
        ...authority,
        publicDomains: [],
        effectiveAllowlistRevision: "revision-2",
      },
    });
    assert.equal(adopted.closedUnauthorizedConnections, 1);
    assert.equal(adopted.binding.username, binding.username);
    assert.equal(adopted.binding.password, binding.password);
    assert.equal(adopted.binding.effectiveAllowlistRevision, "revision-2");
    if (!tunnel.socket.destroyed) {
      await new Promise<void>((resolve) =>
        tunnel.socket.once("close", () => resolve()),
      );
    }
  } finally {
    for (const socket of upstreamSockets) socket.destroy();
    await registry.closeAll();
    await close(upstream);
  }
});

test("hosted Browser gateway revocation cancels a DNS-approved HTTP request before delayed socket allocation", async () => {
  const revokedUpstreamSockets = new Set<Socket>();
  let revokedUpstreamBytes = 0;
  const revokedUpstream = net.createServer((socket) => {
    revokedUpstreamSockets.add(socket);
    socket.once("close", () => revokedUpstreamSockets.delete(socket));
    socket.on("data", (chunk) => {
      revokedUpstreamBytes += Buffer.byteLength(chunk);
    });
  });
  const allowedUpstreamSockets = new Set<Socket>();
  let allowedBody = "";
  const allowedUpstream = http.createServer((request, response) => {
    request.on("data", (chunk) => {
      allowedBody += chunk.toString("utf8");
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("allowed");
    });
  });
  allowedUpstream.on("connection", (socket) => {
    allowedUpstreamSockets.add(socket);
    socket.once("close", () => allowedUpstreamSockets.delete(socket));
  });
  await listen(revokedUpstream);
  await listen(allowedUpstream);
  const revokedUpstreamPort = (revokedUpstream.address() as AddressInfo).port;
  const allowedUpstreamPort = (allowedUpstream.address() as AddressInfo).port;
  const socketAllocationStarted = deferred<void>();
  const releaseFirstSocket = deferred<void>();
  let requestCount = 0;
  const registry = new HostedBrowserEgressRegistry({
    gatewayMachineId: "gateway-machine-1",
    appName: "kestrel-env-test",
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    requestUpstream: (options) => {
      requestCount += 1;
      const agent = new http.Agent();
      if (requestCount === 1) {
        agent.createConnection = (_options, callback) => {
          socketAllocationStarted.resolve();
          void releaseFirstSocket.promise.then(() => {
            callback(null, net.connect({
              host: "127.0.0.1",
              port: revokedUpstreamPort,
            }));
          });
          return undefined as unknown as Socket;
        };
      } else {
        agent.createConnection = () =>
          net.connect({ host: "127.0.0.1", port: allowedUpstreamPort });
      }
      return http.request({ ...options, agent });
    },
  });
  const qaAuthority: HostedBrowserGatewayAuthorityV1 = {
    ...authority,
    enabledModes: ["qa"],
    publicDomains: [],
    qaTarget: {
      version: "browser_qa_target_v1",
      scheme: "http",
      hostname: "qa.example.com",
      port: 8080,
    },
  };
  try {
    const binding = await registry.install({ ...session(qaAuthority), mode: "qa" });
    const revokedRequest = proxyHttpRequest(
      binding,
      "http://qa.example.com:8080/revoked",
      "must-not-leave-gateway",
    );
    await socketAllocationStarted.promise;

    const revoked = await registry.adopt({
      sessionId: "browser-session-1",
      generation: 1,
      authority: {
        ...qaAuthority,
        qaTarget: null,
        effectiveAllowlistRevision: "revision-2",
      },
    });
    assert.equal(revoked.closedUnauthorizedConnections, 1);
    await assert.rejects(revokedRequest, /socket hang up|ECONNRESET/u);

    releaseFirstSocket.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(revokedUpstreamBytes, 0);

    const granted = await registry.adopt({
      sessionId: "browser-session-1",
      generation: 1,
      authority: {
        ...qaAuthority,
        effectiveAllowlistRevision: "revision-3",
      },
    });
    assert.equal(granted.closedUnauthorizedConnections, 0);
    const allowed = await proxyHttpRequest(
      granted.binding,
      "http://qa.example.com:8080/allowed",
      "new-revision-request",
    );
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.body, "allowed");
    assert.equal(allowedBody, "new-revision-request");
    assert.equal(revokedUpstreamBytes, 0);
    const afterSuccess = await registry.adopt({
      sessionId: "browser-session-1",
      generation: 1,
      authority: {
        ...qaAuthority,
        qaTarget: null,
        effectiveAllowlistRevision: "revision-4",
      },
    });
    assert.equal(afterSuccess.closedUnauthorizedConnections, 0);
  } finally {
    releaseFirstSocket.resolve();
    for (const socket of revokedUpstreamSockets) socket.destroy();
    for (const socket of allowedUpstreamSockets) socket.destroy();
    await registry.closeAll();
    await close(revokedUpstream);
    await close(allowedUpstream);
  }
});

test("hosted Browser gateway revocation cancels a DNS-approved CONNECT tunnel before socket completion", async () => {
  let upstreamBytes = 0;
  const upstreamSockets = new Set<Socket>();
  const upstream = net.createServer((socket) => {
    upstreamSockets.add(socket);
    socket.once("close", () => upstreamSockets.delete(socket));
    socket.on("data", (chunk) => {
      upstreamBytes += Buffer.byteLength(chunk);
    });
    socket.write("upstream-ready");
  });
  await listen(upstream);
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const firstDialCreated = deferred<void>();
  let dialCount = 0;
  const registry = new HostedBrowserEgressRegistry({
    gatewayMachineId: "gateway-machine-1",
    appName: "kestrel-env-test",
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    dial: () => {
      dialCount += 1;
      if (dialCount === 1) firstDialCreated.resolve();
      return net.connect({ host: "127.0.0.1", port: upstreamPort });
    },
  });
  try {
    const binding = await registry.install(session(authority));
    const revokedTunnel = connectUntilClosed(binding, "www.example.com:443");
    await firstDialCreated.promise;
    const revoked = await registry.adopt({
      sessionId: "browser-session-1",
      generation: 1,
      authority: {
        ...authority,
        publicDomains: [],
        effectiveAllowlistRevision: "revision-2",
      },
    });
    assert.equal(revoked.closedUnauthorizedConnections, 1);
    await revokedTunnel;
    assert.equal(upstreamBytes, 0);

    const granted = await registry.adopt({
      sessionId: "browser-session-1",
      generation: 1,
      authority: {
        ...authority,
        effectiveAllowlistRevision: "revision-3",
      },
    });
    assert.equal(granted.closedUnauthorizedConnections, 0);
    const allowed = await connect(
      granted.binding,
      "www.example.com:443",
      true,
      true,
    );
    assert.match(allowed, /^HTTP\/1\.1 200 Connection Established/u);
  } finally {
    for (const socket of upstreamSockets) socket.destroy();
    await registry.closeAll();
    await close(upstream);
  }
});

test("hosted Browser gateway rejects DNS changes into reserved space", async () => {
  let dialed = false;
  const registry = new HostedBrowserEgressRegistry({
    gatewayMachineId: "gateway-machine-1",
    appName: "kestrel-env-test",
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    dial: () => {
      dialed = true;
      return new Socket();
    },
  });
  try {
    const binding = await registry.install(session(authority));
    const response = await connect(binding, "www.example.com:443", true);
    assert.match(response, /^HTTP\/1\.1 403/u);
    assert.equal(dialed, false);
  } finally {
    await registry.closeAll();
  }
});

function session(nextAuthority: HostedBrowserGatewayAuthorityV1) {
  return {
    threadId: "thread-1",
    sessionId: "browser-session-1",
    generation: 1,
    mode: "operator" as const,
    authority: nextAuthority,
    hardExpiresAt: "2099-01-01T00:00:00.000Z",
  };
}

async function connect(
  binding: Awaited<ReturnType<HostedBrowserEgressRegistry["install"]>>,
  destination: string,
  authenticate = false,
  waitForUpstream = false,
) {
  const tunnel = await openTunnel(binding, destination, authenticate, waitForUpstream);
  tunnel.socket.destroy();
  return tunnel.response;
}

async function openTunnel(
  binding: Awaited<ReturnType<HostedBrowserEgressRegistry["install"]>>,
  destination: string,
  authenticate = true,
  waitForUpstream = false,
): Promise<{ socket: Socket; response: string }> {
  const proxy = new URL(binding.proxyServer);
  const socket = net.connect({ host: "127.0.0.1", port: Number(proxy.port) });
  const authorization = Buffer.from(
    `${binding.username}:${binding.password}`,
    "utf8",
  ).toString("base64");
  socket.write([
    `CONNECT ${destination} HTTP/1.1`,
    `Host: ${destination}`,
    ...(authenticate ? [`Proxy-Authorization: Basic ${authorization}`] : []),
    "",
    "",
  ].join("\r\n"));
  let response = "";
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("proxy response timed out")), 2_000);
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      const terminal = response.startsWith("HTTP/1.1 200")
        ? !waitForUpstream || response.includes("upstream-ready")
        : response.includes("\r\n\r\n");
      if (terminal) {
        clearTimeout(timeout);
        resolve();
      }
    });
    socket.once("error", reject);
  });
  return { socket, response };
}

async function connectUntilClosed(
  binding: Awaited<ReturnType<HostedBrowserEgressRegistry["install"]>>,
  destination: string,
): Promise<void> {
  const proxy = new URL(binding.proxyServer);
  const socket = net.connect({ host: "127.0.0.1", port: Number(proxy.port) });
  const authorization = Buffer.from(
    `${binding.username}:${binding.password}`,
    "utf8",
  ).toString("base64");
  socket.write([
    `CONNECT ${destination} HTTP/1.1`,
    `Host: ${destination}`,
    `Proxy-Authorization: Basic ${authorization}`,
    "",
    "",
  ].join("\r\n"));
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("proxy socket did not close")),
      2_000,
    );
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
    });
  });
}

async function proxyHttpRequest(
  binding: Awaited<ReturnType<HostedBrowserEgressRegistry["install"]>>,
  target: string,
  body: string,
): Promise<{ statusCode: number; body: string }> {
  const proxy = new URL(binding.proxyServer);
  const authorization = Buffer.from(
    `${binding.username}:${binding.password}`,
    "utf8",
  ).toString("base64");
  return await new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: Number(proxy.port),
      method: "POST",
      path: target,
      headers: {
        "content-length": Buffer.byteLength(body),
        "proxy-authorization": `Basic ${authorization}`,
      },
    });
    request.once("error", reject);
    request.once("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      response.once("error", reject);
    });
    request.end(body);
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function listen(server: net.Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

async function close(server: net.Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
