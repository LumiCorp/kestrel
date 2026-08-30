import assert from "node:assert/strict";
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

async function listen(server: net.Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

async function close(server: net.Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
