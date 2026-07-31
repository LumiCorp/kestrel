import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  PREVIEW_EDGE_ROUTE_TICKET_AUDIENCE,
  verifyPreviewEdgeRouteTicket,
} from "@lumi/kestrel-environment-auth";
import {
  PREVIEW_EDGE_RESOLVED_ROUTE_VERSION,
  PREVIEW_EDGE_RESOLVED_ROUTE_V2_VERSION,
  PreviewEdgeRouteError,
  resolvePreviewEdgeRoute,
} from "./preview-edge-route";

const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const now = new Date("2026-07-23T12:00:00.000Z");
const hostname =
  "p-0123456789abcdef0123456789abcdef.preview.kestrelagents.dev";

function dependencies(input?: {
  lease?: {
    id: string;
    organizationId: string;
    environmentId: string;
    workspaceId: string;
    hostname: string;
    expiresAt: Date;
    targetProvider?: "fly" | "desktop";
  } | null;
  routerUrl?: string | null;
}): import("./preview-edge-route").PreviewEdgeRouteDependencies {
  return {
    expectedServiceToken: "preview-edge-service-token",
    privateKey,
    findActiveLease: async (request: { hostname: string; now: Date }) => {
      assert.equal(request.hostname, hostname);
      assert.equal(request.now, now);
      return input?.lease === undefined
        ? {
            id: "preview-1",
            organizationId: "organization-1",
            environmentId: "environment-1",
            workspaceId: "workspace-1",
            hostname,
            expiresAt: new Date(now.getTime() + 600_000),
          }
        : input.lease;
    },
    findEnvironment: async (environmentId: string) => {
      assert.equal(environmentId, "environment-1");
      return {
        flyAppName: "kestrel-env-1",
        routerUrl:
          input?.routerUrl === undefined
            ? "https://kestrel-env-1.fly.dev"
            : input.routerUrl,
      };
    },
    nonce: () => "preview-edge-route-nonce",
    authorizeDesktopViewer: async () => true,
  };
}

test(
  "an exact active lease resolves to one short-lived signed Environment route",
  async () => {
    const route = await resolvePreviewEdgeRoute(
      {
        authorization: "Bearer preview-edge-service-token",
        hostname: hostname.toUpperCase(),
        now,
      },
      dependencies()
    );

    assert.equal(route.version, PREVIEW_EDGE_RESOLVED_ROUTE_VERSION);
    assert.equal(route.hostname, hostname);
    assert.equal(route.targetUrl, "https://kestrel-env-1.fly.dev");
    assert.equal(route.expiresAt, "2026-07-23T12:05:00.000Z");
    const token = route.authorization.match(/^Bearer ([^\s]+)$/u)?.[1];
    assert.ok(token);
    const issuedAt = Math.floor(now.getTime() / 1000);
    const ticket = verifyPreviewEdgeRouteTicket({
      token,
      publicKey,
      now: issuedAt,
    });
    assert.deepEqual(ticket, {
      version: 1,
      audience: PREVIEW_EDGE_ROUTE_TICKET_AUDIENCE,
      organizationId: "organization-1",
      environmentId: "environment-1",
      workspaceId: "workspace-1",
      flyAppName: "kestrel-env-1",
      previewId: "preview-1",
      hostname,
      issuedAt,
      expiresAt: issuedAt + 300,
      nonce: "preview-edge-route-nonce",
    });
  }
);

test(
  "a Project-authorized Desktop lease resolves to an opaque tunnel target",
  async () => {
    const previewId = "11111111-1111-4111-8111-111111111111";
    const route = await resolvePreviewEdgeRoute(
      {
        authorization: "Bearer preview-edge-service-token",
        hostname,
        accessToken: "member-access",
        now,
      },
      dependencies({
        lease: {
          id: previewId,
          organizationId: "organization-1",
          environmentId: "environment-1",
          workspaceId: "workspace-1",
          hostname,
          targetProvider: "desktop",
          expiresAt: new Date(now.getTime() + 600_000),
        },
      }),
    );
    assert.deepEqual(route, {
      version: PREVIEW_EDGE_RESOLVED_ROUTE_V2_VERSION,
      hostname,
      target: { provider: "desktop", previewId },
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
  },
);

test(
  "missing or inactive preview hosts reveal no route metadata",
  async () => {
    await assert.rejects(
      resolvePreviewEdgeRoute(
        {
          authorization: "Bearer preview-edge-service-token",
          hostname,
          now,
        },
        dependencies({ lease: null })
      ),
      (error: unknown) =>
        error instanceof PreviewEdgeRouteError &&
        error.code === "PREVIEW_EDGE_ROUTE_NOT_FOUND" &&
        error.status === 404
    );
  }
);

test(
  "a Preview Edge route ticket never outlives its durable preview lease",
  async () => {
    const leaseExpiresAt = new Date(now.getTime() + 120_000);
    const route = await resolvePreviewEdgeRoute(
      {
        authorization: "Bearer preview-edge-service-token",
        hostname,
        now,
      },
      dependencies({
        lease: {
          id: "preview-1",
          organizationId: "organization-1",
          environmentId: "environment-1",
          workspaceId: "workspace-1",
          hostname,
          expiresAt: leaseExpiresAt,
        },
      })
    );

    assert.equal(route.expiresAt, leaseExpiresAt.toISOString());
  }
);

test(
  "route resolution requires the dedicated Preview Edge service credential",
  async () => {
    for (const authorization of [
      null,
      "Bearer wrong-preview-edge-token",
      "Basic preview-edge-service-token",
    ]) {
      await assert.rejects(
        resolvePreviewEdgeRoute(
          { authorization, hostname, now },
          dependencies()
        ),
        (error: unknown) =>
          error instanceof PreviewEdgeRouteError &&
          error.code === "PREVIEW_EDGE_UNAUTHORIZED" &&
          error.status === 401
      );
    }
  }
);

test(
  "the resolver refuses a stored target outside the exact Environment Fly App",
  async () => {
    await assert.rejects(
      resolvePreviewEdgeRoute(
        {
          authorization: "Bearer preview-edge-service-token",
          hostname,
          now,
        },
        dependencies({ routerUrl: "https://attacker.example" })
      ),
      (error: unknown) =>
        error instanceof PreviewEdgeRouteError &&
        error.code === "PREVIEW_EDGE_ROUTE_UNAVAILABLE" &&
        error.status === 503
    );
  }
);
