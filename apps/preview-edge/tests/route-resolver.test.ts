import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePreviewHostname,
  PreviewEdgeRouteError,
  PreviewEdgeRouteResolver,
} from "../src/route-resolver.js";

const suffix = "preview.kestrelagents.dev";
const hostname =
  "p-0123456789abcdef0123456789abcdef.preview.kestrelagents.dev";
const secondHostname =
  "p-fedcba9876543210fedcba9876543210.preview.kestrelagents.dev";
const now = Date.parse("2026-07-23T12:00:00.000Z");

function routeBody(
  input: {
    hostname?: string;
    targetUrl?: string;
    authorization?: string;
    expiresAt?: string;
  } = {}
) {
  return {
    version: "preview-edge-resolved-route-v1",
    hostname: input.hostname ?? hostname,
    targetUrl: input.targetUrl ?? "https://kestrel-env-1.fly.dev",
    authorization: input.authorization ?? "Bearer signed-route-ticket",
    expiresAt: input.expiresAt ?? "2026-07-23T12:05:00.000Z",
  };
}

test(
  "Preview Edge accepts only one canonical generated preview hostname",
  () => {
    assert.equal(parsePreviewHostname(hostname, suffix), hostname);
    for (const value of [
      undefined,
      suffix,
      `other.${suffix}`,
      `p-0123456789abcdef.${suffix}`,
      `p-0123456789abcdef0123456789abcdef.extra.${suffix}`,
      hostname.toUpperCase(),
      `${hostname}:443`,
      `${hostname}.`,
      "p-0123456789abcdef0123456789abcdef.preview.example.com",
    ]) {
      assert.throws(
        () => parsePreviewHostname(value, suffix),
        (error: unknown) =>
          error instanceof PreviewEdgeRouteError &&
          error.code === "PREVIEW_NOT_FOUND"
      );
    }
  }
);

test(
  "Preview Edge authenticates route resolution and accepts only an exact Fly target",
  async () => {
    let requestedUrl = "";
    let requestedAuthorization = "";
    let requestedRedirect: RequestRedirect | undefined;
    const resolver = new PreviewEdgeRouteResolver({
      controlPlaneUrl: "https://kestrelagents.dev",
      serviceToken: "edge-service-token",
      now: () => now,
      fetch: async (input, init) => {
        requestedUrl = String(input);
        requestedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
        requestedRedirect = init?.redirect;
        return Response.json(routeBody());
      },
    });
    const result = await resolver.resolve(hostname);
    assert.equal(result.cacheOutcome, "miss");
    assert.equal(result.route.targetUrl, "https://kestrel-env-1.fly.dev");
    assert.equal(result.route.expiresAt, now + 300_000);
    assert.equal(requestedAuthorization, "Bearer edge-service-token");
    assert.equal(requestedRedirect, "error");
    assert.equal(
      requestedUrl,
      `https://kestrelagents.dev/api/runtime/previews/resolve?hostname=${hostname}`
    );

    for (const targetUrl of [
      "http://kestrel-env-1.fly.dev",
      "https://attacker.example",
      "https://kestrel-env-1.fly.dev.evil.example",
      "https://kestrel-env-1.fly.dev:8443",
      "https://kestrel-env-1.fly.dev/path",
      "https://user:password@kestrel-env-1.fly.dev",
    ]) {
      const rejectingResolver = new PreviewEdgeRouteResolver({
        controlPlaneUrl: "https://kestrelagents.dev",
        serviceToken: "edge-service-token",
        now: () => now,
        fetch: async () => Response.json(routeBody({ targetUrl })),
      });
      await assert.rejects(
        rejectingResolver.resolve(hostname),
        (error: unknown) =>
          error instanceof PreviewEdgeRouteError &&
          error.code === "PREVIEW_ROUTE_UNAVAILABLE"
      );
    }
  }
);

test(
  "Preview Edge coalesces cache misses, refreshes at signed expiry, and never negative-caches",
  async () => {
    let currentTime = now;
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolver = new PreviewEdgeRouteResolver({
      controlPlaneUrl: "https://kestrelagents.dev",
      serviceToken: "edge-service-token",
      cacheCapacity: 1,
      now: () => currentTime,
      fetch: async (input) => {
        calls += 1;
        if (calls === 1) await gate;
        const requestedHostname = new URL(String(input)).searchParams.get(
          "hostname"
        );
        return Response.json(
          routeBody({
            hostname: requestedHostname ?? undefined,
            expiresAt: new Date(currentTime + 300_000).toISOString(),
          })
        );
      },
    });
    const first = resolver.resolve(hostname);
    const second = resolver.resolve(hostname);
    release?.();
    assert.equal((await first).cacheOutcome, "miss");
    assert.equal((await second).cacheOutcome, "coalesced");
    assert.equal((await resolver.resolve(hostname)).cacheOutcome, "hit");
    assert.equal(calls, 1);

    currentTime += 300_000;
    assert.equal((await resolver.resolve(hostname)).cacheOutcome, "miss");
    assert.equal(calls, 2);
    assert.equal((await resolver.resolve(secondHostname)).cacheOutcome, "miss");
    assert.equal(calls, 3);
    assert.equal((await resolver.resolve(hostname)).cacheOutcome, "miss");
    assert.equal(calls, 4);

    let missingCalls = 0;
    const missing = new PreviewEdgeRouteResolver({
      controlPlaneUrl: "https://kestrelagents.dev",
      serviceToken: "edge-service-token",
      fetch: async () => {
        missingCalls += 1;
        return Response.json(
          { error: { code: "PREVIEW_EDGE_ROUTE_NOT_FOUND" } },
          { status: 404 }
        );
      },
    });
    await assert.rejects(missing.resolve(hostname));
    await assert.rejects(missing.resolve(hostname));
    assert.equal(missingCalls, 2);
  }
);

test(
  "Preview Edge maps resolver failures and oversized or expired responses to a bounded unavailable error",
  async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => Response.json({ error: { code: "failed" } }, { status: 503 }),
      async () => Response.json(routeBody({ expiresAt: new Date(now).toISOString() })),
      async () =>
        new Response("x".repeat(16_385), {
          headers: { "content-length": "16385" },
        }),
      async () => {
        throw new Error("edge-service-token https://private.invalid");
      },
    ];
    for (const fetchCase of cases) {
      const resolver = new PreviewEdgeRouteResolver({
        controlPlaneUrl: "https://kestrelagents.dev",
        serviceToken: "edge-service-token",
        now: () => now,
        fetch: fetchCase,
      });
      await assert.rejects(
        resolver.resolve(hostname),
        (error: unknown) =>
          error instanceof PreviewEdgeRouteError &&
          error.code === "PREVIEW_ROUTE_UNAVAILABLE" &&
          !error.message.includes("edge-service-token") &&
          !error.message.includes("private.invalid")
      );
    }
  }
);

test(
  "Preview Edge rejects resolver tickets that exceed the signed five-minute horizon",
  async () => {
    const accepted = new PreviewEdgeRouteResolver({
      controlPlaneUrl: "https://kestrelagents.dev",
      serviceToken: "edge-service-token",
      now: () => now,
      fetch: async () =>
        Response.json(
          routeBody({ expiresAt: "2026-07-23T12:05:30.000Z" })
        ),
    });
    assert.equal((await accepted.resolve(hostname)).route.expiresAt, now + 330_000);

    const rejected = new PreviewEdgeRouteResolver({
      controlPlaneUrl: "https://kestrelagents.dev",
      serviceToken: "edge-service-token",
      now: () => now,
      fetch: async () =>
        Response.json(
          routeBody({ expiresAt: "2026-07-23T12:05:31.000Z" })
        ),
    });
    await assert.rejects(
      rejected.resolve(hostname),
      (error: unknown) =>
        error instanceof PreviewEdgeRouteError &&
        error.code === "PREVIEW_ROUTE_UNAVAILABLE"
    );
  }
);
