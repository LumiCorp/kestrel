import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createServer,
  request as httpRequest,
  type Server,
} from "node:http";
import { connect } from "node:net";
import {
  PREVIEW_EDGE_AUTHORIZATION_HEADER,
} from "@lumi/kestrel-environment-auth";
import { contractTest } from "../../../tests/helpers/contract-test.js";
import { PreviewEdge } from "../src/edge.js";
import {
  PreviewEdgeRouteError,
  type PreviewEdgeRoute,
} from "../src/route-resolver.js";

const suffix = "preview.kestrelagents.dev";
const hostname =
  "p-0123456789abcdef0123456789abcdef.preview.kestrelagents.dev";
const route: PreviewEdgeRoute = {
  hostname,
  targetUrl: "https://kestrel-env-1.fly.dev",
  authorization: "Bearer server-owned-route-ticket",
  expiresAt: Date.now() + 300_000,
};

contractTest(
  "services.process",
  "Preview Edge streams HTTP and owns its routing headers without reserving application paths",
  async () => {
    const observed: Array<{
      method: string | undefined;
      url: string | undefined;
      host: string | undefined;
      authorization: string | undefined;
      cookie: string | undefined;
      routeAuthorization: string | undefined;
      forwardedHost: string | undefined;
      hopHeader: string | undefined;
      body: string;
    }> = [];
    const upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      observed.push({
        method: request.method,
        url: request.url,
        host: request.headers.host,
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        routeAuthorization: request.headers[
          PREVIEW_EDGE_AUTHORIZATION_HEADER
        ] as string | undefined,
        forwardedHost: request.headers["x-forwarded-host"] as string | undefined,
        hopHeader: request.headers["x-preview-hop"] as string | undefined,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(201, {
        "content-type": "text/plain",
        "set-cookie": "application=value; HttpOnly",
        connection: "keep-alive, x-upstream-hop",
        "x-upstream-hop": "must-not-cross-edge",
        "x-preview-proof": "streamed",
      });
      response.write("part-one:");
      response.end(request.url);
    });
    const upstreamUrl = await listen(upstream);
    const logs: unknown[] = [];
    let resolutions = 0;
    const edge = new PreviewEdge({
      hostSuffix: suffix,
      resolver: {
        resolve: async () => {
          resolutions += 1;
          return { route, cacheOutcome: "miss" };
        },
      },
      requestUpstream: (input, onResponse) => {
        const target = new URL(upstreamUrl);
        return httpRequest(
          {
            hostname: target.hostname,
            port: target.port,
            method: input.method,
            path: input.path,
            headers: input.headers,
          },
          onResponse
        );
      },
      log: (event) => logs.push(event),
    });
    const publicServer = createServer((request, response) => {
      void edge.handleHttp(request, response);
    });
    const publicUrl = await listen(publicServer);
    try {
      for (const path of ["/upload?part=2", "/health"]) {
        const response = await requestEdge(new URL(path, publicUrl), {
          method: "POST",
          headers: {
            host: hostname,
            authorization: "Bearer application-token",
            cookie: "application=session",
            "content-type": "text/plain",
            "x-forwarded-host": "attacker.example",
            connection: "keep-alive, x-preview-hop",
            "x-preview-hop": "must-not-cross-edge",
            [PREVIEW_EDGE_AUTHORIZATION_HEADER]: "Bearer client-supplied",
          },
          body: "streamed-request",
        });
        assert.equal(response.statusCode, 201);
        assert.equal(response.headers["x-preview-proof"], "streamed");
        assert.equal(response.headers["x-upstream-hop"], undefined);
        assert.deepEqual(response.headers["set-cookie"], [
          "application=value; HttpOnly",
        ]);
        assert.equal(response.body, `part-one:${path}`);
      }
      assert.equal(resolutions, 2);
      assert.deepEqual(
        observed.map((request) => ({
          ...request,
          routeAuthorization: request.routeAuthorization,
        })),
        [
          {
            method: "POST",
            url: "/upload?part=2",
            host: hostname,
            authorization: "Bearer application-token",
            cookie: "application=session",
            routeAuthorization: "Bearer server-owned-route-ticket",
            forwardedHost: undefined,
            hopHeader: undefined,
            body: "streamed-request",
          },
          {
            method: "POST",
            url: "/health",
            host: hostname,
            authorization: "Bearer application-token",
            cookie: "application=session",
            routeAuthorization: "Bearer server-owned-route-ticket",
            forwardedHost: undefined,
            hopHeader: undefined,
            body: "streamed-request",
          },
        ]
      );
      const serializedLogs = JSON.stringify(logs);
      assert.doesNotMatch(serializedLogs, /server-owned-route-ticket/u);
      assert.doesNotMatch(serializedLogs, /application-token/u);
      assert.doesNotMatch(serializedLogs, /streamed-request/u);
      assert.doesNotMatch(serializedLogs, /kestrel-env-1\.fly\.dev/u);
      assert.doesNotMatch(serializedLogs, new RegExp(hostname, "u"));
    } finally {
      await Promise.all([close(publicServer), close(upstream)]);
    }
  }
);

contractTest(
  "services.process",
  "Preview Edge returns stable failures without consulting routes for invalid hosts",
  async () => {
    let resolutions = 0;
    const edge = new PreviewEdge({
      hostSuffix: suffix,
      resolver: {
        resolve: async () => {
          resolutions += 1;
          throw new PreviewEdgeRouteError("PREVIEW_ROUTE_UNAVAILABLE", 503);
        },
      },
      log: () => {},
      upstreamTimeoutMs: 50,
    });
    const server = createServer((request, response) => {
      void edge.handleHttp(request, response);
    });
    const serverUrl = await listen(server);
    try {
      const invalid = await requestEdge(new URL(serverUrl), {
        headers: { host: `extra.${hostname}` },
      });
      assert.equal(invalid.statusCode, 404);
      assert.deepEqual(JSON.parse(invalid.body), {
        error: { code: "PREVIEW_NOT_FOUND" },
      });
      assert.equal(resolutions, 0);

      const unavailable = await requestEdge(new URL(serverUrl), {
        headers: { host: hostname },
      });
      assert.equal(unavailable.statusCode, 503);
      assert.deepEqual(JSON.parse(unavailable.body), {
        error: { code: "PREVIEW_ROUTE_UNAVAILABLE" },
      });
      assert.equal(resolutions, 1);
    } finally {
      await close(server);
    }
  }
);

contractTest(
  "services.process",
  "Preview Edge reports an unavailable Environment Router as a bounded bad gateway",
  async () => {
    const unavailable = createServer();
    const unavailableUrl = await listen(unavailable);
    await close(unavailable);
    const logs: Array<{ status: number; errorCode?: string | undefined }> = [];
    const edge = new PreviewEdge({
      hostSuffix: suffix,
      resolver: {
        resolve: async () => ({ route, cacheOutcome: "miss" }),
      },
      requestUpstream: (input, onResponse) => {
        const target = new URL(unavailableUrl);
        return httpRequest(
          {
            hostname: target.hostname,
            port: target.port,
            method: input.method,
            path: input.path,
            headers: input.headers,
          },
          onResponse
        );
      },
      log: (event) => logs.push(event),
    });
    const server = createServer((request, response) => {
      void edge.handleHttp(request, response);
    });
    const serverUrl = await listen(server);
    try {
      const response = await requestEdge(new URL(serverUrl), {
        headers: { host: hostname },
      });
      assert.equal(response.statusCode, 502);
      assert.deepEqual(JSON.parse(response.body), {
        error: { code: "PREVIEW_UPSTREAM_UNAVAILABLE" },
      });
      assert.equal(logs.at(-1)?.status, 502);
      assert.equal(logs.at(-1)?.errorCode, "PREVIEW_UPSTREAM_UNAVAILABLE");
    } finally {
      await close(server);
    }
  }
);

contractTest(
  "services.process",
  "Preview Edge streams WebSocket upgrades with server-owned route authorization",
  async () => {
    let observedRouteAuthorization: string | undefined;
    let observedForwardedHost: string | undefined;
    const upstream = createServer();
    upstream.on("upgrade", (request, socket) => {
      observedRouteAuthorization = request.headers[
        PREVIEW_EDGE_AUTHORIZATION_HEADER
      ] as string | undefined;
      observedForwardedHost = request.headers["x-forwarded-host"] as
        | string
        | undefined;
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"
      );
      socket.pipe(socket);
    });
    const upstreamUrl = await listen(upstream);
    const edge = new PreviewEdge({
      hostSuffix: suffix,
      resolver: {
        resolve: async () => ({ route, cacheOutcome: "miss" }),
      },
      connectUpstream: async () => {
        const target = new URL(upstreamUrl);
        const socket = connect(Number(target.port), target.hostname);
        await once(socket, "connect");
        return socket;
      },
      log: () => {},
    });
    const publicServer = createServer();
    publicServer.on("upgrade", (request, socket, head) => {
      void edge.handleUpgrade(request, socket, head);
    });
    const publicUrl = await listen(publicServer);
    const target = new URL(publicUrl);
    const client = connect(Number(target.port), target.hostname);
    await once(client, "connect");
    try {
      client.write(
        [
          "GET /@vite/client HTTP/1.1",
          `Host: ${hostname}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Key: dGVzdA==",
          "Sec-WebSocket-Version: 13",
          "X-Forwarded-Host: attacker.example",
          `${PREVIEW_EDGE_AUTHORIZATION_HEADER}: Bearer client-supplied`,
          "",
          "",
        ].join("\r\n")
      );
      const [response] = (await once(client, "data")) as [Buffer];
      assert.match(
        response.toString("utf8"),
        /^HTTP\/1\.1 101 Switching Protocols/u
      );
      assert.equal(
        observedRouteAuthorization,
        "Bearer server-owned-route-ticket"
      );
      assert.equal(observedForwardedHost, undefined);
    } finally {
      client.destroy();
      await Promise.all([close(publicServer), close(upstream)]);
    }
  }
);

contractTest(
  "services.process",
  "Preview Edge waits for fragmented WebSocket response headers and bounds silent upstreams",
  async () => {
    const fragmentedUpstream = createServer();
    fragmentedUpstream.on("upgrade", (_request, socket) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: ");
      setTimeout(() => {
        socket.write("Upgrade\r\nUpgrade: websocket\r\n\r\n");
        socket.pipe(socket);
      }, 10);
    });
    const fragmentedUrl = await listen(fragmentedUpstream);
    const logs: Array<{ status: number; errorCode?: string | undefined }> = [];
    const edge = new PreviewEdge({
      hostSuffix: suffix,
      resolver: { resolve: async () => ({ route, cacheOutcome: "miss" }) },
      upstreamTimeoutMs: 100,
      connectUpstream: async () => {
        const target = new URL(fragmentedUrl);
        const socket = connect(Number(target.port), target.hostname);
        await once(socket, "connect");
        return socket;
      },
      log: (event) => logs.push(event),
    });
    const publicServer = createServer();
    publicServer.on("upgrade", (request, socket, head) => {
      void edge.handleUpgrade(request, socket, head);
    });
    const publicUrl = await listen(publicServer);
    const target = new URL(publicUrl);
    const client = connect(Number(target.port), target.hostname);
    await once(client, "connect");
    try {
      client.write(
        [
          "GET /hmr HTTP/1.1",
          `Host: ${hostname}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Key: dGVzdA==",
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n")
      );
      const response = await readSocketUntil(client, "\r\n\r\n");
      assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/u);
      client.destroy();
    } finally {
      client.destroy();
      fragmentedUpstream.closeAllConnections();
      await Promise.all([close(publicServer), close(fragmentedUpstream)]);
    }

    const silentUpstream = createServer();
    let silentSocket: ReturnType<typeof connect> | undefined;
    silentUpstream.on("upgrade", (_request, socket) => {
      silentSocket = socket as ReturnType<typeof connect>;
    });
    const silentUrl = await listen(silentUpstream);
    const silentLogs: Array<{ status: number; errorCode?: string | undefined }> = [];
    const silentEdge = new PreviewEdge({
      hostSuffix: suffix,
      resolver: { resolve: async () => ({ route, cacheOutcome: "miss" }) },
      upstreamTimeoutMs: 25,
      connectUpstream: async () => {
        const target = new URL(silentUrl);
        const socket = connect(Number(target.port), target.hostname);
        await once(socket, "connect");
        return socket;
      },
      log: (event) => silentLogs.push(event),
    });
    const silentServer = createServer();
    silentServer.on("upgrade", (request, socket, head) => {
      void silentEdge.handleUpgrade(request, socket, head);
    });
    const silentPublicUrl = await listen(silentServer);
    const silentTarget = new URL(silentPublicUrl);
    const silentClient = connect(Number(silentTarget.port), silentTarget.hostname);
    await once(silentClient, "connect");
    try {
      silentClient.write(
        [
          "GET /hmr HTTP/1.1",
          `Host: ${hostname}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Key: dGVzdA==",
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n")
      );
      const response = await readSocketUntil(silentClient, "\r\n\r\n");
      assert.match(response, /^HTTP\/1\.1 502 Bad Gateway/u);
      assert.match(response, /PREVIEW_UPSTREAM_UNAVAILABLE/u);
      assert.equal(silentLogs.filter((entry) => entry.errorCode).length, 1);
      assert.equal(silentLogs.at(-1)?.status, 502);
    } finally {
      silentClient.destroy();
      silentSocket?.destroy();
      silentUpstream.closeAllConnections();
      await Promise.all([close(silentServer), close(silentUpstream)]);
    }
  }
);

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind a TCP port.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  server.close();
  await once(server, "close");
}

function requestEdge(
  url: URL,
  input: {
    method?: string;
    headers: Record<string, string>;
    body?: string;
  }
) {
  return new Promise<{
    statusCode: number;
    headers: import("node:http").IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        method: input.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        headers: input.headers,
      },
      async (response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of response) chunks.push(Buffer.from(chunk));
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      }
    );
    request.once("error", reject);
    request.end(input.body);
  });
}

function readSocketUntil(socket: ReturnType<typeof connect>, marker: string) {
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for socket marker; received ${JSON.stringify(value)}`));
    }, 500);
    const onData = (chunk: Buffer) => {
      value += chunk.toString("utf8");
      if (!value.includes(marker)) return;
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      resolve(value);
    };
    const onError = (error: Error) => {
      clearTimeout(timeout);
      socket.off("data", onData);
      reject(error);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}
