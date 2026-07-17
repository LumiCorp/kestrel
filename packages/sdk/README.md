# @kestrel-agents/sdk

TypeScript SDK for server-side applications that talk to Kestrel Local Core or
a remote Kestrel-compatible runner service.

This is the main application-facing package for teams embedding Kestrel in a
server-side product. It covers:

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

Use this package when application code needs to call an existing Kestrel
deployment. If you need raw command and event control instead of the
higher-level agent client, use `@kestrel-agents/sdk/runner`.

## Install

```bash
pnpm add @kestrel-agents/sdk@0.6.0-beta.0
npm install @kestrel-agents/sdk@0.6.0-beta.0
yarn add @kestrel-agents/sdk@0.6.0-beta.0
bun add @kestrel-agents/sdk@0.6.0-beta.0
```

Use an exact compatible release line across the runtime and public packages.
Check [0.6 Beta release status](../../apps/docs/content/start/release-status.mdx)
before pinning a production dependency.

## Requirements

- Node.js 20 or newer
- an explicit local Unix-socket target or remote runner-service URL
- the target's bearer token when authentication is required

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

The `id` and `profileId` identify the target agent and profile on the runner side. The required `target` explicitly binds the agent to either a remote runner service or Local Core; the SDK never infers that authority from process environment.

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

## Run a Durable Job

```ts
import { KestrelClient } from "@kestrel-agents/sdk/runner";

const client = new KestrelClient({
  target: {
    kind: "remote",
    baseUrl: process.env.KESTREL_RUNNER_SERVICE_URL!,
    authToken: process.env.KESTREL_RUNNER_SERVICE_TOKEN!,
  },
});

const job = client.streamJob(
  {
    profileId: "support",
    input: {
      version: "job_input_v1",
      turn: {
        sessionId: "session-123",
        message: "Deploy the approved release",
      },
    },
  },
  context,
);

for await (const event of job) {
  console.log(event.type, event.payload);
}

const terminal = await job.result;
console.log(terminal.payload.output.result.assistantText);
console.log(terminal.payload.output.result.finalizedPayload);
```

Every job terminal contains the same explicit `assistantText` and
`finalizedPayload` result contract as an interactive run. The SDK does not infer
assistant text from structured payloads.

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
  EXECUTION_PROTOCOL_VERSION,
  KestrelClient,
  RUNNER_COMMAND_CONTRACT_VERSION,
  RUNNER_EVENT_CONTRACT_VERSION,
} from "@kestrel-agents/sdk/runner";

const client = new KestrelClient({
  target: {
    kind: "remote",
    baseUrl: process.env.KESTREL_RUNNER_SERVICE_URL!,
    authToken: process.env.KESTREL_RUNNER_SERVICE_TOKEN,
  },
});
const health = await client.getHealth();

if (
  health.contracts.execution !== EXECUTION_PROTOCOL_VERSION ||
  health.contracts.command !== RUNNER_COMMAND_CONTRACT_VERSION ||
  health.contracts.events !== RUNNER_EVENT_CONTRACT_VERSION
) {
  throw new Error("Runner contract mismatch");
}
```

`getHealth()` rejects unversioned or malformed responses. The health payload
also exposes the runner service version and machine-readable capabilities.

Trusted Node.js applications on the same machine can connect to Local Core
without starting or embedding a runtime:

```ts
const client = new KestrelClient({
  target: {
    kind: "local",
    socketPath: process.env.KESTREL_LOCAL_CORE_API_SOCKET!,
    authToken: process.env.KESTREL_LOCAL_CORE_API_TOKEN!,
  },
});
```

The socket and token are credentials owned by Local Core. Keep them in a
trusted server or desktop main process; never expose them to browser code.
Callers that need runs to outlive a disconnected client can set
`durability: "continue_on_disconnect"` in request context, retain the last
event id, and reconnect with `sinceEventId`. An unknown or expired cursor is an
explicit protocol error and must not silently replay unrelated history.

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
- [AI SDK adapter](https://github.com/LumiCorp/kestrel/blob/main/packages/ai-sdk/README.md)
- [Observability helpers](https://github.com/LumiCorp/kestrel/blob/main/packages/observability/README.md)
