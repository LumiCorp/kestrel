---
id: nextjs-runner-service
domain: integrations
status: active
owner: kestrel-runtime
last_verified_at: 2026-06-30
depends_on:
  - ../index.md
  - ../../cli/runner/RunnerService.ts
  - ../../cli/runner/OpenAiCompatibility.ts
  - ../../packages/sdk/src/agent.ts
  - ../../cli/protocol/contracts.ts
---

# Integrating a Next.js Application with a Runner Service

This document describes how to connect a Next.js application to a runner service that executes agent or workflow requests.

The integration supports two access patterns:

- an OpenAI-compatible HTTP layer for applications that already use OpenAI-style chat or responses APIs
- a custom SDK and protocol for applications that need richer operational features such as session inspection, control actions, task graphs, or custom event handling

The guidance below assumes a standard server-rendered Next.js deployment where route handlers or Server Actions can make outbound HTTP requests.

## Goals

A Next.js integration should:

- keep service credentials on the server
- authenticate end users in the application, not in the runner
- forward actor and tenant metadata to the runner for audit and policy enforcement
- support both request-response and streaming use cases
- let the browser communicate only with the Next.js application

## Recommended Topology

Use this deployment shape:

```text
Browser -> Next.js application -> runner service -> database / tools / model runtime
```

Key rules:

- The browser should not call the runner service directly.
- The Next.js application should be the trust boundary for user authentication.
- The Next.js application should attach service authentication and actor metadata on every runner request.

## Environment Variables

The Next.js server should have access to:

- `KESTREL_RUNNER_SERVICE_URL`
- `KESTREL_RUNNER_SERVICE_TOKEN`

For local development, start the service with:

```bash
kestrel web
```

The launcher prints copy/paste-ready `export` lines for both variables after the service is listening.

The token must remain server-only. Do not expose it through client bundles or browser-readable environment variables.

## Shared Request Contract

Every request from the Next.js application to the runner service should include:

- `Authorization: Bearer <service-token>`

The application should also provide actor metadata for the end user or operator responsible for the request.

Recommended actor fields:

- `actorId`: stable application user ID
- `actorType`: one of `end_user`, `operator`, or `service`
- `displayName`: optional human-readable name
- `tenantId`: optional tenant or workspace identifier

The application should generate these values from its own identity system. Do not rely on service-side fallback defaults in production integrations.

## Integration Option 1: OpenAI-Compatible HTTP Layer

Use this path when the Next.js application already uses OpenAI-style chat or responses APIs, or when the application only needs standard chat semantics.

### Available Endpoints

The runner service exposes:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`

These routes accept OpenAI-style request bodies and return OpenAI-style JSON or streaming SSE responses.

### How It Works

The compatibility layer translates the incoming request into a runner `run.start` command.

The caller does not need to know the internal runner protocol. The Next.js application can proxy the compatibility request and return the upstream response to the browser with minimal translation.

### Required Headers

In addition to bearer auth, the Next.js application should set:

- `x-kestrel-actor-id`
- `x-kestrel-actor-type`
- `x-kestrel-actor-name`
- `x-kestrel-tenant-id`

These headers allow the runner service to associate the request with an authenticated application user.

### Response Headers

The compatibility layer may return runner-specific metadata headers:

- `x-kestrel-session-id`
- `x-kestrel-run-id`

## Read Next

- [Installing and Using the Agent SDK](https://github.com/LumiCorp/kestrel/blob/main/docs/integrations/sdk-installation.md)
- [OpenAI-compatible HTTP](https://github.com/LumiCorp/kestrel/blob/main/apps/docs/content/build/openai-compatible-http.mdx)
- [Integrating with Next.js](https://github.com/LumiCorp/kestrel/blob/main/apps/docs/content/build/integrating-with-nextjs.mdx)
- `x-kestrel-thread-id`
- `x-kestrel-model-id`

If the browser or application needs session continuity, preserve these headers when proxying responses.

### Recommended Next.js Route Shape

Suggested application routes:

- `/api/ai/chat`
- `/api/ai/responses`

The browser calls these application routes. The application route then forwards the request to the runner service.

### Example Route Handler

```ts
import "server-only";

export async function POST(request: Request) {
  const body = await request.text();
  const user = await requireAuthenticatedUser(request);

  const upstream = await fetch(
    `${process.env.KESTREL_RUNNER_SERVICE_URL}/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.KESTREL_RUNNER_SERVICE_TOKEN}`,
        "x-kestrel-actor-id": user.id,
        "x-kestrel-actor-type": "end_user",
        "x-kestrel-actor-name": user.name,
        "x-kestrel-tenant-id": user.tenantId,
      },
      body,
    },
  );

  return new Response(upstream.body, {
    status: upstream.status,
    headers: upstream.headers,
  });
}
```

### When to Use This Mode

Use the compatibility layer when:

- the application is primarily a chat UI
- the application already depends on OpenAI-compatible client libraries
- the application needs text or tool-call streaming, but not runner-specific operational APIs

Do not use this mode as the only integration layer if the application also needs session inspection, operator actions, task graphs, or other control-plane features.

## Integration Option 2: Custom SDK and Runner Protocol

Use this path when the application needs full access to runner capabilities.

This mode is appropriate for:

- application-native streaming UIs
- session inspection
- operator inbox and control actions
- task graph reads and writes
- project review or snapshot APIs
- evaluation execution
- scoped event subscriptions beyond standard chat semantics

### Available Endpoints

The runner service exposes:

- `GET /health`
- `POST /commands`
- `POST /commands/stream`
- `POST /events/stream`

These routes accept and return typed command and event envelopes.

### Request Envelope

Commands are sent as JSON objects with this general shape:

```json
{
  "id": "uuid",
  "type": "run.start",
  "metadata": {
    "actor": {
      "actorId": "user-123",
      "actorType": "end_user",
      "displayName": "Taylor Example",
      "tenantId": "acme"
    },
    "tenantId": "acme",
    "profile": {
      "id": "reference",
      "label": "Reference",
      "agent": "reference-react",
      "sessionPrefix": "reference"
    }
  },
  "payload": {}
}
```

### Event Envelope

Events are returned as JSON objects with this general shape:

```json
{
  "id": "uuid",
  "type": "run.started",
  "ts": "2026-03-19T00:00:00.000Z",
  "runId": "optional",
  "sessionId": "optional",
  "threadId": "optional",
  "commandId": "optional",
  "payload": {}
}
```

### Command Families

The custom protocol supports commands including:

- `run.start`
- `run.cancel`
- `session.describe`
- `operator.inbox`
- `operator.thread`
- `operator.control`
- `task.graph.get`
- `task.graph.update`
- `project.snapshot.get`
- `project.snapshot.update`
- `project.action`
- `project.review.get`
- `project.review.action`
- `runner.ping`
- `mcp.status`
- `mcp.refresh`

### SDK Usage

Install the SDK packages with:

```bash
pnpm add @kestrel-agents/sdk @kestrel-agents/next
```

```bash
npm install @kestrel-agents/sdk @kestrel-agents/next
```

If a custom SDK is available, prefer a server-only wrapper around that SDK instead of constructing protocol envelopes by hand in each route.

Recommended server-only client factory:

```ts
import "server-only";
import { createAgent } from "@kestrel-agents/sdk";

export function createRunnerAgent() {
  return createAgent({
    id: "support-agent",
    profileId: "support",
    target: {
      kind: "remote",
      baseUrl: process.env.KESTREL_RUNNER_SERVICE_URL!,
      authToken: process.env.KESTREL_RUNNER_SERVICE_TOKEN!,
    },
  });
}
```

The public SDK exposes two realtime primitives:

- `agent.stream()` for a single run request
- `subscribe()` for scoped background events such as task or operator updates

`agent.stream()` is request-scoped and will not emit unrelated background events. `subscribe()` requires an explicit filter such as `sessionId`, `threadId`, or `runId`.

### Example Stream Route

```ts
import "server-only";
import { createStreamRunRouteHandler } from "@kestrel-agents/next";

const agent = createRunnerAgent();

export const POST = createStreamRunRouteHandler({
  agent,
  async resolveContext(request) {
    const user = await requireAuthenticatedUser(request);
    return {
      actor: {
        actorId: user.id,
        actorType: "end_user",
        displayName: user.name,
        tenantId: user.tenantId,
      },
      tenantId: user.tenantId,
    };
  },
});
```

### Recommended Next.js Route Shape

Suggested application routes:

- `/api/runner/stream`
- `/api/runner/control`
- `/api/runner/session/[id]`
- `/api/runner/task-graph`
- `/api/runner/operator/*`

This keeps browser-facing routes stable while allowing the server-side integration to evolve independently.

## Choosing Between the Two Modes

Use the OpenAI-compatible layer when:

- the application is mostly a chat interface
- compatibility with existing OpenAI SDKs is important
- the application only needs standard completion or responses behavior

Use the custom SDK and protocol when:

- the application needs non-chat commands
- the application needs full event fidelity
- the application must access session, operator, graph, or project APIs

Many applications will use both:

- OpenAI-compatible endpoints for end-user chat
- custom runner endpoints for operational and orchestration features

## Authentication and Authorization Responsibilities

The Next.js application should own:

- end-user authentication
- tenant resolution
- role checks for operator-only APIs
- profile selection
- request validation for browser inputs

The runner service should be treated as an internal backend dependency, not as a browser-facing identity provider.

## Error Handling

For both integration modes:

- treat transport failures separately from runner failures
- preserve HTTP status codes from the runner service when proxying
- forward structured error payloads to application logs
- cancel in-flight runner streams if the browser disconnects

For the custom protocol:

- treat `runner.error` as a terminal failure
- treat `run.failed` as an application-level execution failure
- preserve event ordering in streamed responses

## Minimal Production Baseline

For a practical first integration, implement:

- one OpenAI-compatible chat route
- one custom streaming route
- one custom control route
- one session inspection route

That baseline supports:

- standard chat UX
- richer application-native workflow UX
- centralized authentication and authorization
- gradual adoption of advanced runner capabilities
