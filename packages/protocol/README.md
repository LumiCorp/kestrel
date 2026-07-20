# `@kestrel-agents/protocol`

Canonical wire contracts shared by Kestrel runner services and public clients.

The protocol package owns versioned commands, events, health responses,
streaming correlation, terminal-result parsing, tool metadata, and project
actions. Local Core and hosted runners serialize through these contracts;
clients parse them rather than trusting unvalidated JSON.

Most application code should use [`@kestrel-agents/sdk`](../sdk/README.md).
Depend on the protocol directly when implementing a compatible runner,
transport, gateway, or contract-aware diagnostic tool.

## Install

```bash
pnpm add @kestrel-agents/protocol@0.6.0
```

Use the same release line as the runtime and SDK. Check
[0.6 release status](../../apps/docs/content/start/release-status.mdx)
before pinning a production dependency.

## Contract Families

| Contract | Responsibility |
| --- | --- |
| Execution | Complete command/event registry and aggregate protocol version |
| Commands | Parsed discriminated envelopes for run, job, operator, project, session, and workspace actions |
| Events | Parsed lifecycle, progress, reasoning, tool, log, console, interaction, and terminal events |
| Health | Runner identity, service version, exact contract versions, and advertised capabilities |
| Tooling | Model-visible and presentation-aware tool descriptors |
| Project actions | Validated project and task mutation requests |

## Check Runner Compatibility

```ts
import {
  EXECUTION_PROTOCOL_VERSION,
  RUNNER_COMMAND_CONTRACT_VERSION,
  RUNNER_EVENT_CONTRACT_VERSION,
  parseRunnerHealthV1,
} from "@kestrel-agents/protocol";

const response = await fetch(`${runnerUrl}/health`, {
  headers: { authorization: `Bearer ${runnerToken}` },
});

const health = parseRunnerHealthV1(await response.json());

if (
  health.contracts.execution !== EXECUTION_PROTOCOL_VERSION ||
  health.contracts.command !== RUNNER_COMMAND_CONTRACT_VERSION ||
  health.contracts.events !== RUNNER_EVENT_CONTRACT_VERSION
) {
  throw new Error("Kestrel runner contract mismatch");
}
```

`parseRunnerHealthV1()` rejects an unversioned, malformed, or incompatible
response. The advertised `capabilities` array lets clients hide or disable
controls the runner cannot honor.

## Parse Unknown Wire Data

```ts
import {
  parseRunnerCommandV2,
  parseRunnerEventV2,
} from "@kestrel-agents/protocol";

const command = parseRunnerCommandV2(untrustedCommandJson);
const event = parseRunnerEventV2(untrustedEventJson);
```

Never cast untrusted HTTP, stream, queue, or persisted JSON directly to a
protocol type. Parse it at the boundary before routing or mutation.

## Execution Protocol v3

The 0.6 line uses the aggregate `execution-protocol-v3` contract. It includes:

- complete command and event registries
- discriminated wire envelopes and payload parsers
- streaming-command classification
- command and event correlation
- explicit runner capabilities
- normalized run and job terminal results
- application-owned system/developer instructions
- distinct provider reasoning and committed agent-progress channels

### Terminal results

Terminal run results carry `assistantText` independently from
`finalizedPayload`. The protocol trims non-empty assistant text at the wire
boundary and preserves structured payloads, including explicit `null`, without
inference.

Durable jobs carry the same result contract inside job output. A caller must
not scrape user-facing text from a structured payload or infer success from the
last streamed event.

### Streaming

Streams are correlated to the originating command ID and the event set allowed
for that command. Job streams may include job lifecycle, runtime diagnostics,
provider reasoning, committed agent progress, logs, console output, and tool
activity.

Provider reasoning and agent progress are separate channels. Provider reasoning
may be live-only; committed agent progress is durable.

### Application instructions

Application-owned system and developer instructions use the explicit
`turn.systemInstructions` field. Conversation history remains user, assistant,
and tagged runtime waiting-prompt entries.

## Errors

Invalid wire data throws `RunnerProtocolContractError` with a machine-readable
code. Treat these failures as boundary or compatibility errors and keep them
visible; do not silently coerce the payload into an older shape.

## Development

```bash
pnpm run protocol:test
pnpm run protocol:build
pnpm run protocol:release-check
```

## Related Docs

- [Protocol and results guide](../../apps/docs/content/build/protocol-and-results.mdx)
- [Event reference](../../apps/docs/content/reference/events.mdx)
- [Terminal results](../../apps/docs/content/reference/terminal-results.mdx)
- [Compatibility](../../apps/docs/content/reference/compatibility.mdx)
- [SDK](../sdk/README.md)
- [Architecture](../../ARCHITECTURE.md)
