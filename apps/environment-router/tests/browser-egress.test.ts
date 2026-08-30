import assert from "node:assert/strict";
import { once } from "node:events";
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

test("hosted Browser gateway closes only the exact session generation and is idempotent", async () => {
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
    assert.equal(await registry.closeExact({
      sessionId: first.sessionId,
      generation: first.generation,
    }), true);
    assert.equal(await registry.closeExact({
      sessionId: first.sessionId,
      generation: first.generation,
    }), false);

    const replacement = await registry.install({
      ...session(authority),
      generation: 2,
    });
    assert.equal(await registry.closeExact({
      sessionId: first.sessionId,
      generation: first.generation,
    }), false);
    const tunnel = await openTunnel(
      replacement,
      "www.example.com:443",
      true,
      true,
    );
    assert.match(tunnel.response, /^HTTP\/1\.1 200 Connection Established/u);
    const tunnelClosed = tunnel.socket.destroyed
      ? Promise.resolve()
      : once(tunnel.socket, "close");
    assert.equal(await registry.closeExact({
      sessionId: replacement.sessionId,
      generation: replacement.generation,
    }), true);
    await tunnelClosed;
    assert.match(
      await connect(replacement, "www.example.com:443", true),
      /^HTTP\/1\.1 407/u,
    );
  } finally {
    await registry.closeAll();
    await close(upstream);
  }
});

test("hosted Browser gateway exact close retries throwing destructors without reviving credentials", async () => {
  const upstreamSockets = new Set<Socket>();
  const upstream = net.createServer((socket) => {
    upstreamSockets.add(socket);
    socket.once("close", () => upstreamSockets.delete(socket));
  });
  await listen(upstream);
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const destroyAttempts = [0, 0];
  let dialCount = 0;
  const registry = new HostedBrowserEgressRegistry({
    gatewayMachineId: "gateway-machine-1",
    appName: "kestrel-env-test",
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    dial: () => {
      const index = dialCount++;
      const socket = net.connect({ host: "127.0.0.1", port: upstreamPort });
      const destroy = socket.destroy.bind(socket);
      socket.destroy = ((error?: Error) => {
        destroyAttempts[index] = (destroyAttempts[index] ?? 0) + 1;
        if (destroyAttempts[index] <= 2) {
          throw new Error(`injected destroy failure ${index}`);
        }
        return destroy(error);
      }) as Socket["destroy"];
      return socket;
    },
  });
  try {
    const binding = await registry.install(session(authority));
    const first = await openTunnel(binding, "www.example.com:443");
    const second = await openTunnel(binding, "www.example.com:443");
    const firstClientClosed = once(first.socket, "close");
    const secondClientClosed = once(second.socket, "close");

    assert.equal(await registry.closeExact({
      sessionId: binding.sessionId,
      generation: binding.generation,
    }), true);
    await Promise.all([firstClientClosed, secondClientClosed]);
    assert.deepEqual(destroyAttempts, [2, 2]);
    assert.match(
      await connect(binding, "www.example.com:443", true),
      /^HTTP\/1\.1 407/u,
    );
    await assert.rejects(
      registry.install(session(authority)),
      /BROWSER_SESSION_LOST/u,
    );

    const replacement = await registry.install({
      ...session(authority),
      generation: 2,
    });
    const replacementTunnel = await openTunnel(
      replacement,
      "www.example.com:443",
      true,
      false,
    );

    assert.equal(await registry.closeExact({
      sessionId: binding.sessionId,
      generation: binding.generation,
    }), true);
    assert.deepEqual(destroyAttempts, [3, 3]);
    assert.equal(replacementTunnel.socket.destroyed, false);
    assert.equal(await registry.closeExact({
      sessionId: binding.sessionId,
      generation: binding.generation,
    }), false);
    replacementTunnel.socket.destroy();
  } finally {
    for (const socket of upstreamSockets) socket.destroy();
    await registry.closeAll();
    await close(upstream);
  }
});

test("hosted Browser gateway shutdown excludes an install already waiting on its listener", async () => {
  const registry = new HostedBrowserEgressRegistry({
    gatewayMachineId: "gateway-machine-1",
    appName: "kestrel-env-test",
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  const first = await registry.install(session(authority));
  const installing = registry.install({
    ...session(authority),
    threadId: "thread-2",
    sessionId: "browser-session-2",
  });
  const shutdown = registry.closeAll();

  await assert.rejects(installing, /BROWSER_SESSION_LOST/u);
  await shutdown;
  assert.throws(
    () => registry.requireSession({
      sessionId: first.sessionId,
      generation: first.generation,
    }),
    /BROWSER_SESSION_LOST/u,
  );
  await assert.rejects(
    registry.install({
      ...session(authority),
      threadId: "thread-3",
      sessionId: "browser-session-3",
    }),
    /BROWSER_SESSION_LOST/u,
  );
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

for (const action of ["close", "expiry", "client", "reinstall"] as const) {
  test(`hosted Browser gateway ${action} cancels delayed-DNS HTTP before upstream allocation`, async () => {
    const upstream = http.createServer((_request, response) => response.end("fresh"));
    await listen(upstream);
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const dnsStarted = deferred<void>();
    const dnsRelease = deferred<readonly [{ address: string; family: 4 }]>();
    let delayDns = true;
    let upstreamAllocations = 0;
    const registry = new HostedBrowserEgressRegistry({
      gatewayMachineId: "gateway-machine-1",
      appName: "kestrel-env-test",
      resolve: async () => {
        if (!delayDns) return [{ address: "93.184.216.34", family: 4 }];
        dnsStarted.resolve();
        return await dnsRelease.promise;
      },
      requestUpstream: (options) => {
        upstreamAllocations += 1;
        return http.request({
          ...options,
          host: "127.0.0.1",
          family: 4,
          port: upstreamPort,
        });
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
    const sessionBinding = {
      ...session(qaAuthority),
      mode: "qa" as const,
      ...(action === "expiry"
        ? { hardExpiresAt: new Date(Date.now() + 30).toISOString() }
        : {}),
    };
    try {
      const binding = await registry.install(sessionBinding);
      const pending = startProxyHttpRequest(
        binding,
        "http://qa.example.com:8080/delayed",
        "must-not-leave-gateway",
      );
      await dnsStarted.promise;

      let replacement: typeof binding | undefined;
      if (action === "client") {
        pending.request.destroy();
        await pending.settled;
      } else if (action === "expiry") {
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
      } else {
        await registry.closeExact({
          sessionId: binding.sessionId,
          generation: binding.generation,
        });
        if (action === "reinstall") {
          delayDns = false;
          replacement = await registry.install(sessionBinding);
        }
      }

      dnsRelease.resolve([{ address: "93.184.216.34", family: 4 }]);
      await pending.settled;
      assert.equal(upstreamAllocations, 0);

      if (replacement) {
        const fresh = await proxyHttpRequest(
          replacement,
          "http://qa.example.com:8080/fresh",
          "fresh-request",
        );
        assert.equal(fresh.statusCode, 200);
        assert.equal(fresh.body, "fresh");
        assert.equal(upstreamAllocations, 1);
      }
    } finally {
      dnsRelease.resolve([{ address: "93.184.216.34", family: 4 }]);
      await registry.closeAll();
      await close(upstream);
    }
  });

  test(`hosted Browser gateway ${action} cancels delayed-DNS CONNECT before upstream allocation`, async () => {
    const upstream = net.createServer((socket) => socket.write("upstream-ready"));
    await listen(upstream);
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const dnsStarted = deferred<void>();
    const dnsRelease = deferred<readonly [{ address: string; family: 4 }]>();
    let delayDns = true;
    let upstreamAllocations = 0;
    const registry = new HostedBrowserEgressRegistry({
      gatewayMachineId: "gateway-machine-1",
      appName: "kestrel-env-test",
      resolve: async () => {
        if (!delayDns) return [{ address: "93.184.216.34", family: 4 }];
        dnsStarted.resolve();
        return await dnsRelease.promise;
      },
      dial: () => {
        upstreamAllocations += 1;
        return net.connect({ host: "127.0.0.1", port: upstreamPort });
      },
    });
    const sessionBinding = {
      ...session(authority),
      ...(action === "expiry"
        ? { hardExpiresAt: new Date(Date.now() + 30).toISOString() }
        : {}),
    };
    try {
      const binding = await registry.install(sessionBinding);
      const pending = startPendingTunnel(binding, "www.example.com:443");
      await dnsStarted.promise;

      let replacement: typeof binding | undefined;
      if (action === "client") {
        pending.socket.destroy();
        await pending.settled;
      } else if (action === "expiry") {
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
      } else {
        await registry.closeExact({
          sessionId: binding.sessionId,
          generation: binding.generation,
        });
        if (action === "reinstall") {
          delayDns = false;
          replacement = await registry.install(sessionBinding);
        }
      }

      dnsRelease.resolve([{ address: "93.184.216.34", family: 4 }]);
      await pending.settled;
      assert.equal(upstreamAllocations, 0);

      if (replacement) {
        assert.match(
          await connect(replacement, "www.example.com:443", true, true),
          /^HTTP\/1\.1 200 Connection Established/u,
        );
        assert.equal(upstreamAllocations, 1);
      }
    } finally {
      dnsRelease.resolve([{ address: "93.184.216.34", family: 4 }]);
      await registry.closeAll();
      await close(upstream);
    }
  });
}

test("hosted Browser gateway authenticates exact QA WebSockets without leaking proxy credentials", async () => {
  const receivedHeaders = deferred<string>();
  const upstreamClosed = deferred<void>();
  const upstream = net.createServer((socket) => {
    socket.once("close", () => upstreamClosed.resolve());
    let handshake = "";
    const readHandshake = (chunk: Buffer) => {
      handshake += chunk.toString("utf8");
      const boundary = handshake.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      socket.off("data", readHandshake);
      receivedHeaders.resolve(handshake.slice(0, boundary + 4));
      socket.write([
        "HTTP/1.1 101 Switching Protocols",
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Accept: destination-owned",
        "",
        "",
      ].join("\r\n"));
      const trailing = Buffer.from(handshake.slice(boundary + 4), "utf8");
      if (trailing.byteLength > 0) socket.write(trailing);
      socket.on("data", (data) => socket.write(data));
    };
    socket.on("data", readHandshake);
  });
  await listen(upstream);
  const upstreamPort = (upstream.address() as AddressInfo).port;
  let allocations = 0;
  const registry = new HostedBrowserEgressRegistry({
    gatewayMachineId: "gateway-machine-1",
    appName: "kestrel-env-test",
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    requestUpstream: (options) => {
      allocations += 1;
      return http.request({
        ...options,
        host: "127.0.0.1",
        family: 4,
        port: upstreamPort,
      });
    },
  });
  try {
    const binding = await registry.install({
      ...session(qaAuthority()),
      mode: "qa",
    });
    const unauthenticated = await openWebSocket(
      binding,
      "http://qa.example.com:8080/socket",
      false,
    );
    assert.match(unauthenticated.response, /^HTTP\/1\.1 407/u);
    unauthenticated.socket.destroy();

    const wrongCredential = await openWebSocket(
      { ...binding, password: "wrong-session-secret" },
      "http://qa.example.com:8080/socket",
    );
    assert.match(wrongCredential.response, /^HTTP\/1\.1 407/u);
    wrongCredential.socket.destroy();

    const wrongTarget = await openWebSocket(
      binding,
      "http://other.example.com:8080/socket",
    );
    assert.match(wrongTarget.response, /^HTTP\/1\.1 403/u);
    wrongTarget.socket.destroy();
    assert.equal(allocations, 0);

    const allowed = await openWebSocket(
      binding,
      "http://qa.example.com:8080/socket?case=1",
    );
    assert.match(allowed.response, /^HTTP\/1\.1 101 Switching Protocols/u);
    const headers = await receivedHeaders.promise;
    assert.match(headers, /^GET \/socket\?case=1 HTTP\/1\.1\r\n/u);
    assert.doesNotMatch(headers, /proxy-authorization/iu);
    assert.match(headers, /\r\nconnection: Upgrade\r\n/iu);
    assert.match(headers, /\r\nupgrade: websocket\r\n/iu);
    const echoed = readSocketUntil(allowed.socket, "bidirectional-proof");
    allowed.socket.write("bidirectional-proof");
    assert.match(
      await echoed,
      /bidirectional-proof/u,
    );
    const clientClosed = once(allowed.socket, "close");
    allowed.socket.destroy();
    await clientClosed;
    await upstreamClosed.promise;
    assert.equal(allocations, 1);
    const afterClientLoss = await registry.adopt({
      sessionId: binding.sessionId,
      generation: binding.generation,
      authority: {
        ...qaAuthority(),
        qaTarget: null,
        effectiveAllowlistRevision: "revision-2",
      },
    });
    assert.equal(afterClientLoss.closedUnauthorizedConnections, 0);
  } finally {
    await registry.closeAll();
    await close(upstream);
  }
});

test("hosted Browser gateway revocation cancels a reserved QA WebSocket before DNS can allocate upstream", async () => {
  const dnsStarted = deferred<void>();
  const dnsRelease = deferred<readonly [{ address: string; family: 4 }]>();
  let allocations = 0;
  const registry = new HostedBrowserEgressRegistry({
    gatewayMachineId: "gateway-machine-1",
    appName: "kestrel-env-test",
    resolve: async () => {
      dnsStarted.resolve();
      return await dnsRelease.promise;
    },
    requestUpstream: (options) => {
      allocations += 1;
      return http.request(options);
    },
  });
  try {
    const binding = await registry.install({
      ...session(qaAuthority()),
      mode: "qa",
    });
    const pending = startPendingWebSocket(
      binding,
      "http://qa.example.com:8080/socket",
    );
    await dnsStarted.promise;
    const revoked = await registry.adopt({
      sessionId: binding.sessionId,
      generation: binding.generation,
      authority: {
        ...qaAuthority(),
        qaTarget: null,
        effectiveAllowlistRevision: "revision-2",
      },
    });
    assert.equal(revoked.closedUnauthorizedConnections, 1);
    await pending.settled;
    dnsRelease.resolve([{ address: "93.184.216.34", family: 4 }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(allocations, 0);
  } finally {
    dnsRelease.resolve([{ address: "93.184.216.34", family: 4 }]);
    await registry.closeAll();
  }
});

test("hosted Browser gateway rejects QA WebSocket private-address rebinding before allocation", async () => {
  let allocations = 0;
  const registry = new HostedBrowserEgressRegistry({
    gatewayMachineId: "gateway-machine-1",
    appName: "kestrel-env-test",
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    requestUpstream: (options) => {
      allocations += 1;
      return http.request(options);
    },
  });
  try {
    const binding = await registry.install({
      ...session(qaAuthority()),
      mode: "qa",
    });
    const denied = await openWebSocket(
      binding,
      "http://qa.example.com:8080/socket",
    );
    assert.match(denied.response, /^HTTP\/1\.1 403/u);
    denied.socket.destroy();
    assert.equal(allocations, 0);
  } finally {
    await registry.closeAll();
  }
});

test("hosted Browser gateway keeps established WebSockets past request deadlines and closes them on adoption and hard expiry", async () => {
  const sockets = new Set<Socket>();
  const upstream = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk.toString("utf8");
      if (!request.includes("\r\n\r\n")) return;
      request = "";
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    });
  });
  await listen(upstream);
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const registry = new HostedBrowserEgressRegistry({
    gatewayMachineId: "gateway-machine-1",
    appName: "kestrel-env-test",
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    requestUpstream: (options) => http.request({
      ...options,
      host: "127.0.0.1",
      family: 4,
      port: upstreamPort,
    }),
    timeouts: { dnsMs: 25, connectMs: 25, headersMs: 25, bodyIdleMs: 25 },
  });
  try {
    const hardExpiresAt = new Date(Date.now() + 350).toISOString();
    const binding = await registry.install({
      ...session(qaAuthority()),
      mode: "qa",
      hardExpiresAt,
    });
    const first = await openWebSocket(
      binding,
      "http://qa.example.com:8080/socket",
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    assert.equal(first.socket.destroyed, false);
    const firstClosed = waitForSocketClose(first.socket);
    const revoked = await registry.adopt({
      sessionId: binding.sessionId,
      generation: binding.generation,
      authority: {
        ...qaAuthority(),
        qaTarget: null,
        effectiveAllowlistRevision: "revision-2",
      },
    });
    assert.equal(revoked.closedUnauthorizedConnections, 1);
    await firstClosed;

    const granted = await registry.adopt({
      sessionId: binding.sessionId,
      generation: binding.generation,
      authority: {
        ...qaAuthority(),
        effectiveAllowlistRevision: "revision-3",
      },
    });
    const second = await openWebSocket(
      granted.binding,
      "http://qa.example.com:8080/socket",
    );
    await waitForSocketClose(second.socket);
    assert.ok(Date.now() >= Date.parse(hardExpiresAt));
  } finally {
    for (const socket of sockets) socket.destroy();
    await registry.closeAll();
    await close(upstream);
  }
});

test("hosted Browser gateway bounds DNS, WebSocket, and CONNECT establishment and releases reservations", async () => {
  const dnsRegistry = new HostedBrowserEgressRegistry({
    gatewayMachineId: "gateway-machine-1",
    appName: "kestrel-env-test",
    resolve: async () => await new Promise<never>(() => {}),
    timeouts: { dnsMs: 30, connectMs: 30, headersMs: 30, bodyIdleMs: 30 },
  });
  try {
    const binding = await dnsRegistry.install({
      ...session(qaAuthority()),
      mode: "qa",
    });
    const pending = startPendingWebSocket(
      binding,
      "http://qa.example.com:8080/socket",
    );
    await pending.settled;
    const adopted = await dnsRegistry.adopt({
      sessionId: binding.sessionId,
      generation: binding.generation,
      authority: {
        ...qaAuthority(),
        qaTarget: null,
        effectiveAllowlistRevision: "revision-2",
      },
    });
    assert.equal(adopted.closedUnauthorizedConnections, 0);
  } finally {
    await dnsRegistry.closeAll();
  }

  const webSocketSockets = new Set<Socket>();
  const webSocketBlackhole = net.createServer((socket) => {
    webSocketSockets.add(socket);
    socket.once("close", () => webSocketSockets.delete(socket));
    socket.on("data", () => {});
  });
  await listen(webSocketBlackhole);
  const webSocketPort = (webSocketBlackhole.address() as AddressInfo).port;
  const webSocketRegistry = new HostedBrowserEgressRegistry({
    gatewayMachineId: "gateway-machine-1",
    appName: "kestrel-env-test",
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    requestUpstream: (options) => http.request({
      ...options,
      host: "127.0.0.1",
      family: 4,
      port: webSocketPort,
    }),
    timeouts: { dnsMs: 30, connectMs: 30, headersMs: 30, bodyIdleMs: 30 },
  });
  try {
    const binding = await webSocketRegistry.install({
      ...session(qaAuthority()),
      mode: "qa",
    });
    await startPendingWebSocket(
      binding,
      "http://qa.example.com:8080/socket",
    ).settled;
    const adopted = await webSocketRegistry.adopt({
      sessionId: binding.sessionId,
      generation: binding.generation,
      authority: {
        ...qaAuthority(),
        qaTarget: null,
        effectiveAllowlistRevision: "revision-2",
      },
    });
    assert.equal(adopted.closedUnauthorizedConnections, 0);
  } finally {
    for (const socket of webSocketSockets) socket.destroy();
    await webSocketRegistry.closeAll();
    await close(webSocketBlackhole);
  }

  const connectRegistry = new HostedBrowserEgressRegistry({
    gatewayMachineId: "gateway-machine-1",
    appName: "kestrel-env-test",
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    dial: () => new Socket(),
    timeouts: { dnsMs: 30, connectMs: 30, headersMs: 30, bodyIdleMs: 30 },
  });
  try {
    const binding = await connectRegistry.install(session(authority));
    await startPendingTunnel(binding, "www.example.com:443").settled;
    const adopted = await connectRegistry.adopt({
      sessionId: binding.sessionId,
      generation: binding.generation,
      authority: {
        ...authority,
        publicDomains: [],
        effectiveAllowlistRevision: "revision-2",
      },
    });
    assert.equal(adopted.closedUnauthorizedConnections, 0);
  } finally {
    await connectRegistry.closeAll();
  }
});

for (const stall of ["headers", "body"] as const) {
  test(`hosted Browser gateway bounds stalled HTTP ${stall} and releases its reservation`, async () => {
    const sockets = new Set<Socket>();
    const upstream = stall === "headers"
      ? net.createServer((socket) => {
          sockets.add(socket);
          socket.once("close", () => sockets.delete(socket));
          socket.on("data", () => {});
        })
      : http.createServer((_request, response) => {
          response.writeHead(200, { "content-length": 100 });
          response.write("partial");
        });
    upstream.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await listen(upstream);
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const registry = new HostedBrowserEgressRegistry({
      gatewayMachineId: "gateway-machine-1",
      appName: "kestrel-env-test",
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      requestUpstream: (options) => http.request({
        ...options,
        host: "127.0.0.1",
        family: 4,
        port: upstreamPort,
      }),
      timeouts: { dnsMs: 30, connectMs: 30, headersMs: 30, bodyIdleMs: 30 },
    });
    try {
      const binding = await registry.install({
        ...session(qaAuthority()),
        mode: "qa",
      });
      await assert.rejects(
        proxyHttpRequest(binding, "http://qa.example.com:8080/stall", "body"),
        /aborted|ECONNRESET|socket hang up/u,
      );
      const adopted = await registry.adopt({
        sessionId: binding.sessionId,
        generation: binding.generation,
        authority: {
          ...qaAuthority(),
          qaTarget: null,
          effectiveAllowlistRevision: "revision-2",
        },
      });
      assert.equal(adopted.closedUnauthorizedConnections, 0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await registry.closeAll();
      await close(upstream);
    }
  });
}

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

function qaAuthority(): HostedBrowserGatewayAuthorityV1 {
  return {
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
}

async function openWebSocket(
  binding: Awaited<ReturnType<HostedBrowserEgressRegistry["install"]>>,
  target: string,
  authenticate = true,
): Promise<{ socket: Socket; response: string }> {
  const pending = startPendingWebSocket(binding, target, authenticate);
  let response = "";
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("WebSocket proxy response timed out")),
      2_000,
    );
    pending.socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (response.includes("\r\n\r\n")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    pending.socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  return { socket: pending.socket, response };
}

function startPendingWebSocket(
  binding: Awaited<ReturnType<HostedBrowserEgressRegistry["install"]>>,
  target: string,
  authenticate = true,
): { socket: Socket; settled: Promise<void> } {
  const proxy = new URL(binding.proxyServer);
  const socket = net.connect({ host: "127.0.0.1", port: Number(proxy.port) });
  const authorization = Buffer.from(
    `${binding.username}:${binding.password}`,
    "utf8",
  ).toString("base64");
  const settled = new Promise<void>((resolve) => {
    socket.once("close", resolve);
    socket.once("end", resolve);
    socket.once("error", resolve);
    socket.on("data", () => {});
  });
  socket.write([
    `GET ${target} HTTP/1.1`,
    `Host: ${new URL(target).host}`,
    "Connection: keep-alive, Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Key: dGVzdC1rZXk=",
    "Sec-WebSocket-Version: 13",
    ...(authenticate ? [`Proxy-Authorization: Basic ${authorization}`] : []),
    "",
    "",
  ].join("\r\n"));
  return { socket, settled };
}

async function readSocketUntil(socket: Socket, expected: string): Promise<string> {
  let received = "";
  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("socket data timed out")),
      2_000,
    );
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      if (received.includes(expected)) {
        clearTimeout(timeout);
        resolve(received);
      }
    });
    socket.once("error", reject);
  });
}

async function waitForSocketClose(socket: Socket): Promise<void> {
  if (socket.destroyed) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("socket did not close")),
      2_000,
    );
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") {
        clearTimeout(timeout);
        reject(error);
      }
    });
  });
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

function startPendingTunnel(
  binding: Awaited<ReturnType<HostedBrowserEgressRegistry["install"]>>,
  destination: string,
): { socket: Socket; settled: Promise<void> } {
  const proxy = new URL(binding.proxyServer);
  const socket = net.connect({ host: "127.0.0.1", port: Number(proxy.port) });
  const authorization = Buffer.from(
    `${binding.username}:${binding.password}`,
    "utf8",
  ).toString("base64");
  const settled = new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
    socket.once("end", () => resolve());
    socket.once("error", () => resolve());
    socket.on("data", () => {});
  });
  socket.write([
    `CONNECT ${destination} HTTP/1.1`,
    `Host: ${destination}`,
    `Proxy-Authorization: Basic ${authorization}`,
    "",
    "",
  ].join("\r\n"));
  return { socket, settled };
}

function startProxyHttpRequest(
  binding: Awaited<ReturnType<HostedBrowserEgressRegistry["install"]>>,
  target: string,
  body: string,
): { request: http.ClientRequest; settled: Promise<void> } {
  const proxy = new URL(binding.proxyServer);
  const authorization = Buffer.from(
    `${binding.username}:${binding.password}`,
    "utf8",
  ).toString("base64");
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
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
  request.once("error", settle);
  request.once("response", (response) => {
    response.resume();
    response.once("end", settle);
    response.once("error", settle);
  });
  request.end(body);
  return { request, settled };
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
