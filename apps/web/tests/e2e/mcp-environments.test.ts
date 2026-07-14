import { expect, test } from "@playwright/test";

const now = "2026-07-13T12:00:00.000Z";
const server = {
  id: "mcp-server-1",
  organizationId: "org-browser",
  environmentId: "environment-browser",
  providerKey: "mcp.browser-github",
  credentialId: null,
  createdByUserId: "user-browser",
  name: "Browser GitHub MCP",
  slug: "browser-github",
  sourceType: "remote",
  transport: "streamable_http",
  remoteUrl: "https://mcp.example.com/mcp",
  ociImageReference: null,
  ociDigest: null,
  authMode: "none",
  launchArguments: [],
  egressAllowlist: ["https://mcp.example.com"],
  cpuMillicores: 500,
  memoryMib: 512,
  pidsLimit: 128,
  status: "ready",
  lastHealthAt: now,
  failureCode: null,
  failureMessage: null,
  createdAt: now,
  updatedAt: now,
} as const;

test("Environment admins can operate MCP servers and inspect replay-safe health", async ({
  page,
}) => {
  let installedBody: Record<string, unknown> | undefined;
  let snapshotDecision: Record<string, unknown> | undefined;

  await page.route(
    /\/api\/admin\/environments\/[^/]+\/mcp(?:\/.*)?$/,
    async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname.endsWith("/mcp/credentials") && request.method() === "GET") {
        await route.fulfill({ json: { credentials: [] } });
        return;
      }
      if (pathname.endsWith("/mcp/servers") && request.method() === "GET") {
        await route.fulfill({ json: { servers: [server] } });
        return;
      }
      if (pathname.endsWith("/mcp/servers") && request.method() === "POST") {
        installedBody = request.postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          json: {
            server: {
              ...server,
              id: "mcp-server-oci",
              providerKey: "mcp.browser-oci",
              name: "Browser OCI MCP",
              slug: "browser-oci",
              sourceType: "oci",
              transport: "stdio",
              remoteUrl: null,
              ociImageReference: installedBody.imageReference,
              ociDigest: installedBody.digest,
              egressAllowlist: installedBody.egressAllowlist,
              status: "draft",
            },
          },
        });
        return;
      }
      if (pathname.endsWith("/mcp/health")) {
        await route.fulfill({
          json: {
            summary: {
              servers: 1,
              readyServers: 1,
              degradedServers: 0,
              activeDiscoveryJobs: 0,
              pendingInteractions: 1,
              failedInvocations: 1,
            },
            discoveryJobs: [],
            invocations: [
              {
                id: "invocation-1",
                serverId: server.id,
                capabilityId: "capability-1",
                method: "tools/call",
                status: "failed",
                requestDigest: `sha256:${"a".repeat(64)}`,
                responseDigest: null,
                errorCode: "MCP_UPSTREAM_FAILED",
                createdAt: now,
                completedAt: now,
              },
            ],
            interactions: [
              {
                id: "interaction-1",
                invocationId: "invocation-1",
                threadId: "thread-browser",
                kind: "sampling",
                status: "requested",
                createdAt: now,
                resolvedAt: null,
              },
            ],
          },
        });
        return;
      }
      if (pathname.endsWith(`/mcp/servers/${server.id}`)) {
        await route.fulfill({
          json: {
            server,
            snapshots: [
              {
                id: "snapshot-1",
                serverId: server.id,
                protocolVersion: "2025-11-25",
                capabilityDigest: `sha256:${"b".repeat(64)}`,
                serverInfo: {},
                status: "pending_review",
                reviewedByUserId: null,
                reviewedAt: null,
                discoveredAt: now,
                createdAt: now,
                capabilities: [],
              },
            ],
          },
        });
        return;
      }
      if (
        pathname.includes("/snapshots/snapshot-1") &&
        request.method() === "PATCH"
      ) {
        snapshotDecision = request.postDataJSON() as Record<string, unknown>;
        await route.fulfill({ json: { snapshot: { id: "snapshot-1" } } });
        return;
      }
      await route.fulfill({
        status: 404,
        json: { error: "Unhandled MCP test route" },
      });
    }
  );

  await page.goto("/settings/environments");
  await expect(
    page.getByRole("heading", { name: "Environments" })
  ).toBeVisible();
  await expect(page.getByText("Browser GitHub MCP")).toBeVisible();

  await page.getByText("Health and recent activity").click();
  await expect(page.getByText("Interactions pending")).toBeVisible();
  await expect(page.getByText("MCP_UPSTREAM_FAILED")).toBeVisible();
  await expect(
    page.getByText(/Request bodies, responses, and credentials are omitted/u)
  ).toBeVisible();

  await page.getByText("Install MCP server", { exact: true }).click();
  await page.getByRole("button", { name: "OCI stdio" }).click();
  await page.getByLabel("Name", { exact: true }).last().fill("Browser OCI MCP");
  await page.getByLabel("Slug", { exact: true }).fill("browser-oci");
  await page
    .getByLabel("Digest-pinned OCI image")
    .fill(`ghcr.io/acme/mcp@sha256:${"c".repeat(64)}`);
  await page
    .getByLabel("Allowed HTTPS origins (one per line)")
    .fill("https://api.example.com");
  await page.getByRole("button", { name: "Install server" }).click();
  await expect(page.getByText("Browser OCI MCP")).toBeVisible();
  expect(installedBody).toMatchObject({
    sourceType: "oci",
    transport: "stdio",
    digest: `sha256:${"c".repeat(64)}`,
    egressAllowlist: ["https://api.example.com"],
  });

  await page
    .getByText("Browser GitHub MCP", { exact: true })
    .locator("..")
    .getByRole("button", { name: "Review" })
    .click();
  await page.getByRole("button", { name: "Approve snapshot" }).click();
  expect(snapshotDecision).toEqual({ decision: "approve" });
});

test("Threads pause for sampling and elicitation and submit explicit decisions", async ({
  page,
}) => {
  const resolutions: Array<Record<string, unknown>> = [];
  await page.route(
    /\/api\/threads\/[^/]+\/mcp\/interactions(?:\/[^/]+)?$/,
    async (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        await route.fulfill({
          json: {
            interactions: [
              {
                id: "sampling-browser",
                kind: "sampling",
                requestEnvelope: {
                  messages: [
                    { role: "user", content: "Summarize approved context" },
                  ],
                },
              },
              {
                id: "elicitation-browser",
                kind: "elicitation",
                requestEnvelope: {
                  message: "Select a deployment region",
                  requestedSchema: {
                    type: "object",
                    properties: { region: { type: "string" } },
                  },
                },
              },
              {
                id: "url-elicitation-browser",
                kind: "elicitation",
                requestEnvelope: {
                  mode: "url",
                  message: "Authorize the deployment provider",
                  elicitationId: "provider-auth",
                  url: "https://accounts.example.test/authorize",
                },
              },
            ],
          },
        });
        return;
      }
      resolutions.push({
        interactionId: new URL(request.url()).pathname.split("/").at(-1),
        ...(request.postDataJSON() as Record<string, unknown>),
      });
      await route.fulfill({ json: { interaction: { status: "approved" } } });
    }
  );

  await page.goto("/threads/new");
  const samplingCard = page.locator("[data-slot='card']").filter({
    hasText: "MCP server requests model sampling",
  });
  await expect(samplingCard).toBeVisible();
  await samplingCard.getByRole("button", { name: "Allow sample" }).click();

  const elicitationCard = page.locator("[data-slot='card']").filter({
    hasText: "MCP server requests information",
  });
  await elicitationCard
    .getByLabel("Elicitation response as JSON")
    .fill('{"region":"iad"}');
  await elicitationCard.getByRole("button", { name: "Submit" }).click();

  const urlElicitationCard = page.locator("[data-slot='card']").filter({
    has: page.getByRole("link", { name: "Open secure authorization page" }),
  });
  await expect(
    urlElicitationCard.getByRole("link", {
      name: "Open secure authorization page",
    })
  ).toHaveAttribute("href", "https://accounts.example.test/authorize");
  await urlElicitationCard
    .getByRole("button", { name: "I completed it" })
    .click();

  await expect.poll(() => resolutions.length).toBe(3);
  expect(resolutions).toEqual([
    {
      interactionId: "sampling-browser",
      decision: "approve",
    },
    {
      interactionId: "elicitation-browser",
      decision: "approve",
      content: { region: "iad" },
    },
    {
      interactionId: "url-elicitation-browser",
      decision: "approve",
    },
  ]);
});
