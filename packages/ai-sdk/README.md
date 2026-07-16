# `@kestrel-agents/ai-sdk`

Typed presentation adapter between Kestrel runner events and Vercel AI SDK 6
UI messages.

The package turns one Kestrel run stream into a durable assistant message with
human-facing text, typed activity parts, terminal metadata, and visible contract
failures. The same accumulator drives the live UI stream and the message you
persist, preventing them from developing different interpretations of a run.

## When to Use It

Use this package in a server-side Vercel AI SDK application when you want to
render Kestrel:

- runtime and committed agent progress
- live provider reasoning when the provider exposes it
- tool activity
- citations and artifacts
- approval or elicitation interactions
- completed, waiting, failed, cancelled, or contract-failure state
- terminal `assistantText`

It is a presentation adapter, not a runtime, transport, React component library,
or browser client. Start and control the run through
[`@kestrel-agents/sdk`](../sdk/README.md).

## Install

```bash
pnpm add @kestrel-agents/ai-sdk@0.6.0-beta.0 \
  @kestrel-agents/sdk@0.6.0-beta.0 \
  ai@^6
```

The runtime, protocol, SDK, and presentation adapter must use a compatible
release line. Check [0.6 Beta release status](../../apps/docs/content/start/release-status.mdx)
before pinning a production dependency.

## Stream a Kestrel Run

Inside a Vercel AI SDK `createUIMessageStream` execute callback, pass the
writer and the Kestrel SDK stream to the adapter:

```ts
import type { UIMessageStreamWriter } from "ai";
import type {
  RunnerRunStreamEvent,
  RunnerRunTerminalEvent,
  RunnerStream,
} from "@kestrel-agents/sdk";
import {
  type KestrelUIMessage,
  writeKestrelFailureToUIMessage,
  writeKestrelRunnerStreamToUIMessage,
} from "@kestrel-agents/ai-sdk";

async function writeRun(
  writer: UIMessageStreamWriter<KestrelUIMessage>,
  runStream: RunnerStream<RunnerRunStreamEvent, RunnerRunTerminalEvent>,
  turnId: string,
) {
  try {
    return await writeKestrelRunnerStreamToUIMessage({
      writer,
      events: runStream,
      terminalEvent: runStream.result,
      assistantMessageId: crypto.randomUUID(),
      textPartId: crypto.randomUUID(),
      turnId,
    });
  } catch (error) {
    return writeKestrelFailureToUIMessage({
      writer,
      error,
      assistantMessageId: crypto.randomUUID(),
      textPartId: crypto.randomUUID(),
      turnId,
    });
  }
}
```

The returned `KestrelPresentationSnapshot` contains:

- `message`: the complete assistant `UIMessage` to persist
- `message.metadata.kestrelTurnId`: the host product's durable turn identity,
  when supplied
- `assistantText`: canonical human-facing terminal text or `null`
- `terminalStatus`: `working`, `completed`, `waiting`, `failed`, `cancelled`,
  or `contract_failure`
- `errorMessage`: visible normalized failure detail when present
- `failureVisible`: whether the terminal failure must remain visible in the UI
- `interaction`: the durable pending interaction when the run is waiting

Use one pair of message/text part IDs for one assistant message. If the caller
reconnects to the same durable run, preserve the Kestrel event cursor and your
application's message identity rules.

`assistantText` is producer-owned. Completed runs require a non-empty response;
user-facing waits require `assistantText` to equal the interaction prompt. A
`data-kestrel-status` part describes that run segment, while the host product's
durable turn ledger remains authoritative for the current multi-segment turn
state.

## Typed Message Parts

`KestrelPresentationDataParts` adds these AI SDK data parts:

| Part | Meaning | Persisted |
| --- | --- | --- |
| `data-kestrel-progress` | Runtime, environment, or worker progress | Yes |
| `data-kestrel-agent-progress` | Committed agent progress | Yes |
| `data-kestrel-provider-reasoning` | Provider-exposed live reasoning | No; emitted as transient |
| `data-kestrel-tool` | Tool start, completion, or failure | Yes |
| `data-kestrel-citation` | Citation metadata | Yes |
| `data-kestrel-artifact` | Produced artifact metadata | Yes |
| `data-kestrel-interaction` | Pending approval, input, MCP sampling, or elicitation | Yes |
| `data-kestrel-status` | Terminal or contract-failure state | Yes |

Provider reasoning is deliberately live-only. Committed agent progress is a
durable product event and remains in the persisted message.

## Use the Accumulator Directly

Use `createKestrelPresentationAccumulator()` when your server framework owns
its own stream transport but still needs the canonical presentation contract:

```ts
import { createKestrelPresentationAccumulator } from "@kestrel-agents/ai-sdk";

const presentation = createKestrelPresentationAccumulator({
  assistantMessageId: "assistant-123",
  turnId: "turn-123",
});

for await (const event of runStream) {
  const newParts = presentation.append(event);
  // Send newParts through your transport.
}

const snapshot = presentation.finish(await runStream.result);
// Persist snapshot.message.
```

The accumulator deduplicates identified parts and validates terminal waiting
interactions. Invalid or contradictory presentation data becomes a visible
`KestrelPresentationContractError` state instead of disappearing from the UI.

## Terminal Interactions

`readKestrelTerminalInteraction()` extracts a durable pending interaction from
a waiting terminal event. It verifies that the canonical `assistantText`
matches the interaction prompt so the user is not shown two contradictory
requests.

## Exports

- `writeKestrelRunnerStreamToUIMessage`
- `writeKestrelFailureToUIMessage`
- `createKestrelPresentationAccumulator`
- `readKestrelTerminalInteraction`
- `KestrelPresentationContractError`
- typed message, metadata, part, snapshot, status, tool, citation, artifact,
  progress, reasoning, and interaction contracts

## Requirements

- Node.js 20 or newer
- Vercel AI SDK `>=6 <7`
- compatible `@kestrel-agents/sdk` and protocol contracts
- server-side execution; do not expose runner credentials to the browser

## Development

```bash
pnpm run ai-sdk:test
pnpm run ai-sdk:build
pnpm run ai-sdk:release-check
```

## Related Docs

- [SDK](../sdk/README.md)
- [Protocol](../protocol/README.md)
- [Kestrel One integration](../../apps/web/lib/agent/kestrel-runtime-core.ts)
- [Protocol and results guide](../../apps/docs/content/build/protocol-and-results.mdx)
- [Root README](../../README.md)
