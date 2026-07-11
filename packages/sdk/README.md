# @kestrel-agents/sdk

TypeScript SDK for server-side applications that talk to a Kestrel-compatible runner service.

This is the main application-facing package for teams extending or embedding the Kestrel Suite beyond the flagship Desktop app. It covers:

- creating an agent client bound to a runner service
- running and streaming turns for a specific session
- resuming blocked runs
- reading and updating session memory
- subscribing to scoped background events
- handling structured SDK and protocol errors

The SDK is designed for Node.js services. Browser and edge-runtime usage are not supported in this release.

Low-level command and event access remains available on the advanced `@kestrel-agents/sdk/runner` subpath.

The SDK consumes the canonical wire contracts from `@kestrel-agents/protocol`.
Applications should normally use the SDK instead of depending on that package
directly.

## What This Package Is Not

- It is not the Kestrel runtime itself.
- It does not run agents in-process.
- It expects a reachable Kestrel runner-service boundary.

Use this package when you want application code to call into an existing Kestrel deployment or build suite-adjacent integrations. If you need raw command and event control instead of the higher-level agent client, use `@kestrel-agents/sdk/runner`.

## Install

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

## Requirements

- Node.js 20 or newer
- a reachable runner service URL
- a runner service token when the target requires authentication

## Create an Agent

```ts
import { createAgent } from "@kestrel-agents/sdk";

const agent = createAgent({
  id: "support-agent",
  profileId: "support",
  baseUrl: process.env.KESTREL_RUNNER_SERVICE_URL!,
  authToken: process.env.KESTREL_RUNNER_SERVICE_TOKEN!,
});
```

The `id` and `profileId` identify the target agent and profile on the runner side. `baseUrl` and `authToken` bind this client to the runner-service boundary.

## Actor Context

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

Context is request-scoped metadata that travels with each call. Use it to preserve actor and tenant identity across runs, resumes, memory updates, and subscriptions.

## Run and Stream

```ts
const terminal = await agent.run(
  {
    sessionId: "session-123",
    message: "Summarize the latest changes",
  },
  context,
);
```

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

If the caller cancels the stream, the SDK cancels that exact run and `stream.result` resolves with `run.cancelled`.

## Resume a Blocked Run

```ts
await agent.resume(
  {
    sessionId: "session-123",
    message: "Continue with the fix.",
  },
  context,
);
```

## Session Memory

```ts
const session = agent.session("session-123");

const memory = await session.memory.get(context);

await session.memory.update(
  {
    findings: "The deployment finished successfully.",
    linkedArtifacts: ["docs/deploy.md"],
  },
  context,
);
```

## Subscribe to Background Events

```ts
const events = agent.subscribe(
  {
    sessionId: "session-123",
    eventTypes: ["task.updated"],
  },
  context,
);

for await (const event of events) {
  console.log(event.type, event.sessionId);
}
```

Subscriptions are explicit and filter-scoped. The root SDK does not expose a global event firehose.

## Advanced Runner Access

Use the advanced subpath when you need direct runner command and event control:

```ts
import { KestrelClient } from "@kestrel-agents/sdk/runner";
```

Check runner compatibility before enabling runtime-dependent product controls:

```ts
import {
  KestrelClient,
  RUNNER_COMMAND_CONTRACT_VERSION,
  RUNNER_EVENT_CONTRACT_VERSION,
} from "@kestrel-agents/sdk/runner";

const client = new KestrelClient({
  baseUrl: process.env.KESTREL_RUNNER_SERVICE_URL!,
  authToken: process.env.KESTREL_RUNNER_SERVICE_TOKEN,
});
const health = await client.getHealth();

if (
  health.contracts.command !== RUNNER_COMMAND_CONTRACT_VERSION ||
  health.contracts.events !== RUNNER_EVENT_CONTRACT_VERSION
) {
  throw new Error("Runner contract mismatch");
}
```

`getHealth()` rejects unversioned or malformed responses. The health payload
also exposes the runner service version and machine-readable capabilities.

## Errors

The SDK throws structured errors with machine-readable fields:

- `KestrelConfigurationError`
- `KestrelHttpError`
- `KestrelProtocolError`
- `KestrelServiceError`

## OpenAI-Compatible HTTP

Use the OpenAI-compatible HTTP layer instead of this SDK when an application already depends on OpenAI-style chat or responses clients and only needs compatibility semantics.

## Related Docs

- [Root README](https://github.com/LumiCorp/kestrel/blob/main/README.md)
- [Next.js helpers](https://github.com/LumiCorp/kestrel/blob/main/packages/next/README.md)
- [Observability helpers](https://github.com/LumiCorp/kestrel/blob/main/packages/observability/README.md)
- [CLI runner protocol](https://github.com/LumiCorp/kestrel/blob/main/docs/cli/kchat-protocol.md)
