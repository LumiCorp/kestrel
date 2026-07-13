# `@kestrel-agents/protocol`

Canonical wire-level contracts shared by Kestrel runner services and public
clients. Product applications should normally consume these contracts through
`@kestrel-agents/sdk`.

## Execution Protocol v2

The package owns the complete command and event registries, discriminated wire
envelopes, payload parsers, streaming-command classification, and terminal
result normalization for `execution-protocol-v2`. Both Local Core and hosted
runner services must parse commands and serialize events through these exports;
clients should reject a health response that does not advertise the same
aggregate execution contract.

Terminal run results carry `assistantText` independently from `finalizedPayload`.
The protocol trims non-empty assistant text at the wire boundary and preserves
structured payloads, including an explicit `null`, without inference.
`job.completed` and `job.failed` carry that same result contract inside their
job output, including failures that occur before a model response is available.

Streaming responses are correlated to both the originating command ID and its
allowed event set. Job streams include job lifecycle events plus the runtime
progress, reasoning, log, console, and tool activity produced by that job.

Application-owned system and developer instructions use the explicit
`turn.systemInstructions` field. Runtimes render those instructions in the
model system message; submitted conversation history remains limited to user,
assistant, and tagged runtime waiting-prompt entries.
