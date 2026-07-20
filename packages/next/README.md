# @kestrel-agents/next

Next.js route helpers for Kestrel-backed agent endpoints.

This package sits on top of `@kestrel-agents/sdk` for server-side Next.js
applications. It removes repetitive route-handler glue around:

- request parsing
- auth/context propagation
- streaming SSE responses
- request correlation
- webhook/background entrypoints

It is intended for server-side Next.js applications that want to expose Kestrel runs through route handlers without rebuilding the transport, streaming, and correlation plumbing each time.

## What This Package Is Not

- It is not a standalone SDK.
- It does not replace the runner service.
- It is not meant for client-side browser use.

Use this package when your application already has a Kestrel agent client and you need clean `app/api` handlers around it.

## Install

```bash
pnpm add @kestrel-agents/next@0.6.0 \
  @kestrel-agents/sdk@0.6.0
```

Check [0.6 release status](../../apps/docs/content/start/release-status.mdx)
before pinning a production dependency.

## Exports

- `createJsonRunRouteHandler`
- `createStreamRunRouteHandler`
- `createWebhookRunRouteHandler`
- `readRequestCorrelation`

## JSON Route Handler

```ts
import { createJsonRunRouteHandler } from "@kestrel-agents/next";

export const POST = createJsonRunRouteHandler({
  agent,
  async resolveContext(request, correlation) {
    return {
      actor: {
        actorId: "user-123",
        actorType: "end_user",
      },
      tenantId: "acme",
    };
  },
});
```

Use this when your route should return a standard JSON response for a completed run.

## Streaming Route Handler

```ts
import { createStreamRunRouteHandler } from "@kestrel-agents/next";

export const POST = createStreamRunRouteHandler({
  agent,
  resolveContext,
});
```

Use this when the caller should receive streamed server-sent events for the active run.

## Webhook Handler

```ts
import { createWebhookRunRouteHandler } from "@kestrel-agents/next";

export const POST = createWebhookRunRouteHandler({
  agent,
  resolveContext,
  mapPayload(payload) {
    return {
      sessionId: payload.sessionId,
      message: payload.prompt,
    };
  },
});
```

Use this when an external system sends a payload that needs to be mapped into a Kestrel run request.

## Related Docs

- [SDK README](https://github.com/LumiCorp/kestrel/blob/main/packages/sdk/README.md)
- [Next.js integration guide](../../apps/docs/content/build/integrating-with-nextjs.mdx)
- [Root README](https://github.com/LumiCorp/kestrel/blob/main/README.md)
