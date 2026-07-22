import assert from "node:assert/strict";
import { connect } from "node:tls";
import { once } from "node:events";

// Run with a current hosted execution ticket for a Project whose Environment has
// an attached ngrok connection. The ticket must include the normal terminal,
// preview-port, App invocation, and gateway refresh route capabilities.
const gatewayUrl = secureUrl(required("KESTREL_PREVIEW_CANARY_GATEWAY_URL"));
const controlPlaneUrl = secureUrl(
  required("KESTREL_PREVIEW_CANARY_CONTROL_PLANE_URL")
);
const ticket = required("KESTREL_PREVIEW_CANARY_TICKET");
const projectDirectory = required("KESTREL_PREVIEW_CANARY_PROJECT_DIR");
const port = optionalPort(process.env.KESTREL_PREVIEW_CANARY_PORT) ?? 4173;
const command =
  process.env.KESTREL_PREVIEW_CANARY_COMMAND?.trim() ||
  `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`;
const authorization = { authorization: `Bearer ${ticket}` };
let terminalId: string | null = null;
let previewId: string | null = null;

try {
  const terminal = await expectOk(
    gatewayRequest("/v1/terminal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: projectDirectory }),
    }),
    "create the hosted Workspace terminal"
  );
  terminalId = ((await terminal.json()) as { id: string }).id;
  await expectOk(
    gatewayRequest(`/v1/terminal/sessions/${terminalId}/input`, {
      method: "POST",
      body: `${command}\n`,
    }),
    "start Vite in the hosted Workspace"
  );

  const published = await publishWhenReady();
  previewId = published.id;
  const previewUrl = secureUrl(published.url);
  const [document, viteClient] = await Promise.all([
    waitForPublicResponse(previewUrl),
    waitForPublicResponse(new URL("/@vite/client", previewUrl)),
  ]);
  assert.match(
    viteClient.body,
    /createHotContext|vite\/client/u,
    "the public preview must serve Vite's live client"
  );
  await assertWebSocketUpgrade(previewUrl);

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      previewId,
      previewUrl: previewUrl.toString(),
      documentStatus: document.status,
      viteClient: true,
      websocketUpgrade: true,
      publicAccess: published.publicAccess,
    })}\n`
  );
} finally {
  if (previewId) {
    await controlPlaneRequest(
      `/api/runtime/apps/ngrok/close/confirmed/previews/${encodeURIComponent(previewId)}`,
      { method: "DELETE" }
    ).then((response) => {
      if (!response.ok) {
        throw new Error(`Preview cleanup failed with HTTP ${response.status}.`);
      }
    });
  }
  if (terminalId) {
    await gatewayRequest(`/v1/terminal/sessions/${terminalId}`, {
      method: "DELETE",
    }).catch(() => undefined);
  }
}

async function publishWhenReady() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await controlPlaneRequest(
      "/api/runtime/apps/ngrok/publish/auto/previews",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port, name: "Vite hosted preview canary", ttlMinutes: 10 }),
      }
    );
    if (response.ok) {
      return (await response.json() as {
        preview: {
          id: string;
          url: string;
          publicAccess: string;
        };
      }).preview;
    }
    const body = await response.text();
    if (
      response.status !== 409 ||
      !body.includes("WORKSPACE_PREVIEW_PORT_NOT_LISTENING")
    ) {
      throw new Error(`Preview publish failed with HTTP ${response.status}: ${body}`);
    }
    await delay(1_000);
  }
  throw new Error(`Vite did not begin listening on port ${port} within 60 seconds.`);
}

async function waitForPublicResponse(url: URL) {
  const deadline = Date.now() + 30_000;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: "no-store", redirect: "follow" });
      lastStatus = response.status;
      if (response.ok) {
        return { status: response.status, body: await response.text() };
      }
    } catch {}
    await delay(1_000);
  }
  throw new Error(`Public preview did not become ready (${url}; last HTTP ${lastStatus}).`);
}

async function assertWebSocketUpgrade(previewUrl: URL) {
  const socket = connect({
    host: previewUrl.hostname,
    port: 443,
    servername: previewUrl.hostname,
  });
  await once(socket, "secureConnect");
  socket.write(
    [
      "GET / HTTP/1.1",
      `Host: ${previewUrl.hostname}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Protocol: vite-hmr",
      "",
      "",
    ].join("\r\n")
  );
  const timeout = setTimeout(() => socket.destroy(new Error("WebSocket timeout")), 15_000);
  try {
    const [chunk] = (await once(socket, "data")) as [Buffer];
    assert.match(chunk.toString("utf8"), /^HTTP\/1\.1 101 /u);
  } finally {
    clearTimeout(timeout);
    socket.destroy();
  }
}

function gatewayRequest(pathname: string, init: RequestInit = {}) {
  return fetch(new URL(pathname, gatewayUrl), {
    ...init,
    headers: { ...authorization, ...Object.fromEntries(new Headers(init.headers)) },
  });
}

function controlPlaneRequest(pathname: string, init: RequestInit = {}) {
  return fetch(new URL(pathname, controlPlaneUrl), {
    ...init,
    headers: { ...authorization, ...Object.fromEntries(new Headers(init.headers)) },
  });
}

async function expectOk(request: Promise<Response>, operation: string) {
  const response = await request;
  if (!response.ok) {
    throw new Error(`${operation} failed with HTTP ${response.status}: ${await response.text()}`);
  }
  return response;
}

function secureUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${url} must use HTTPS.`);
  return url;
}

function optionalPort(value: string | undefined) {
  if (!value?.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1024 || parsed > 65_535) {
    throw new Error("KESTREL_PREVIEW_CANARY_PORT must be an unreserved TCP port.");
  }
  return parsed;
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
