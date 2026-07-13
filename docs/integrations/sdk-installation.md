---
id: sdk-installation
domain: integrations
status: active
owner: kestrel-runtime
last_verified_at: 2026-06-30
depends_on:
  - ../index.md
  - ../../packages/sdk/package.json
  - ../../packages/sdk/src/index.ts
---

# Installing and Using the Agent SDK

This guide explains how to install and use the TypeScript SDK for a Kestrel agent runtime.

## Install

Install the package from npm:

```bash
pnpm add @kestrel-agents/sdk
```

```bash
npm install @kestrel-agents/sdk
```

```bash
yarn add @kestrel-agents/sdk
```

```bash
bun add @kestrel-agents/sdk
```

The package is intended for server-side Node.js environments such as Next.js route handlers, Server Actions, backend services, or worker processes.

## Configure

The SDK needs:

- an explicit execution target: a remote runner service or Local Core
- actor metadata for the authenticated user or operator making the request

Remote targets use a base URL and may use a bearer token for service-to-service authentication. Local targets use the Core socket path and its client token. For example, a remote deployment can provide:

```bash
export KESTREL_RUNNER_SERVICE_URL=http://127.0.0.1:4010
export KESTREL_RUNNER_SERVICE_TOKEN=dev-secret
```

## Create an Agent

```ts
import { createAgent } from "@kestrel-agents/sdk";

const agent = createAgent({
  id: "support-agent",
  profileId: "support",
  target: {
    kind: "remote",
    baseUrl: process.env.KESTREL_RUNNER_SERVICE_URL!,
    authToken: process.env.KESTREL_RUNNER_SERVICE_TOKEN!,
  },
});
```

## Define Actor Context

```ts
const context = {
  actor: {
    actorId: "user-123",
    actorType: "end_user",
    displayName: "Taylor Example",
    tenantId: "acme",
  },
  tenantId: "acme",
};
```

## Run a Single Request

```ts
const response = await agent.run(
  {
    sessionId: "session-123",
    message: "Summarize the latest changes",
  },
  context,
);
```

## Stream a Request

```ts
const stream = agent.stream(
  {
    sessionId: "session-123",
    message: "Explain the deployment status",
  },
  context,
);

for await (const event of stream) {
  console.log(event.type, event.payload);
}

const terminal = await stream.result;
```

`agent.stream()` is request-scoped. It emits only events for the originating run request. If the caller cancels the stream, the SDK cancels that specific run and `stream.result` resolves with `run.cancelled`.

## Subscribe to Scoped Background Events

Use `subscribe()` for events that should be observed independently of a single request stream.

```ts
const events = agent.subscribe(
  {
    sessionId: "session-123",

## Read Next

- [packages/sdk/README.md](https://github.com/LumiCorp/kestrel/blob/main/packages/sdk/README.md)
- [Integrating a Next.js Application with a Runner Service](https://github.com/LumiCorp/kestrel/blob/main/docs/integrations/nextjs-runner-service.md)
- [SDK package docs page](https://github.com/LumiCorp/kestrel/blob/main/apps/docs/content/packages/sdk.mdx)
    eventTypes: ["task.updated"],
  },
  context,
);

for await (const event of events) {
  console.log(event.type, event.sessionId);
}
```

Subscriptions must be scoped by `sessionId`, `threadId`, or `runId`. The SDK does not expose an unfiltered global event stream.

## When to Use the SDK

Use the root SDK when an application needs:

- agent-first runs and streaming
- explicit session memory continuity
- scoped background event subscriptions
- structured server-side control over the agent runtime

Use the advanced `@kestrel-agents/sdk/runner` subpath when an application needs direct access to the low-level runner command and event model.

Use the OpenAI-compatible HTTP API instead when an application only needs chat or responses semantics and already uses OpenAI-style client libraries.
