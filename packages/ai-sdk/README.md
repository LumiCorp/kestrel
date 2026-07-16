# @kestrel-agents/ai-sdk

The public, typed presentation adapter between Kestrel runner events and Vercel AI SDK UI messages.

It accumulates live progress, tool activity, citations, artifacts, interactions, terminal assistant text, and visible contract failures into the same durable message parts that are written to an AI SDK stream.

Pass the product's durable turn identity when it has one:

```ts
const snapshot = await writeKestrelRunnerStreamToUIMessage({
  writer,
  events,
  terminalEvent,
  assistantMessageId,
  textPartId,
  turnId,
});

snapshot.message.metadata?.kestrelTurnId;
```

`assistantText` is producer-owned. Completed runs require a non-empty response;
user-facing waits require `assistantText` to equal the interaction prompt. A
`data-kestrel-status` part describes that run segment, while a host product's
durable turn ledger remains authoritative for the current multi-segment turn
state.
