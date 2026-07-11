---
id: kestrel-one-stream-translation-package-evaluation
domain: analysis
status: active
owner: kestrel-one
last_verified_at: 2026-06-30
depends_on:
  - ../../apps/web/lib/agent/kestrel-ui-stream.ts
  - ../../apps/web/lib/agent/kestrel-stream-events.ts
  - ../../apps/web/lib/agent/kestrel-reconnect-stream.ts
  - ../../packages/next/src/routes.ts
  - ../../packages/sdk/src/contracts.ts
  - ../../apps/web/lib/client/runnerEvents.ts
---

# Kestrel-One Stream Translation Package Evaluation

Status: Decided
Last verified: 2026-05-07

## Decision

Keep the Kestrel-One runner-to-UI stream translator app-local for this PR series. Do not move it into `@kestrel-agents/next` yet.

The current translator is valuable, but the stable shared boundary is not the whole implementation. The reusable part is smaller than the current module: parse runner events, classify progressive versus terminal updates, suppress consecutive duplicate progress, and expose terminal status. The current writer also knows Kestrel-One-specific UI chunk names, final text fallbacks, reasoning accordion behavior, message metadata, and product labels.

## Evidence

- Kestrel-One stream writer: [apps/web/lib/agent/kestrel-ui-stream.ts](../../apps/web/lib/agent/kestrel-ui-stream.ts)
- Kestrel-One display translator and labels: [apps/web/lib/agent/kestrel-stream-events.ts](../../apps/web/lib/agent/kestrel-stream-events.ts)
- Kestrel-One reconnect adapter: [apps/web/lib/agent/kestrel-reconnect-stream.ts](../../apps/web/lib/agent/kestrel-reconnect-stream.ts)
- Next package route helpers: [packages/next/src/routes.ts](../../packages/next/src/routes.ts)
- SDK runner event contract: [packages/sdk/src/contracts.ts](../../packages/sdk/src/contracts.ts)
- Existing web app runner event presentation is not AI SDK UI-stream based: [apps/web/lib/client/runnerEvents.ts](../../apps/web/lib/client/runnerEvents.ts)

## Why Not Move It Now

Moving the whole Kestrel-One translator into `@kestrel-agents/next` would make the package own app-specific presentation decisions:

- AI SDK UI chunk names such as `reasoning-start`, `reasoning-delta`, `message-metadata`, and `finish`.
- Kestrel-One metadata key `kestrelTerminalStatus`.
- Product labels such as `Searching organization knowledge.` and `Knowledge search failed.`
- Kestrel-One terminal fallback text for empty, failed, cancelled, and runner-error states.
- Reasoning accordion behavior that belongs to the Kestrel-One UI surface.

Those are not yet package contracts. Promoting them now would either freeze Kestrel-One UI decisions as SDK behavior or require package options that are not justified by a second consumer.

## Package Extraction Candidate

If another Next consumer needs the same behavior, extract only a neutral helper from the event translator:

```ts
type RunnerUiUpdate =
  | {
      kind: "progress";
      severity: "info" | "error";
      text: string;
      errorMessage: string | null;
    }
  | {
      kind: "terminal";
      severity: "info" | "error" | "cancelled";
      terminalStatus: "completed" | "failed" | "cancelled" | "runner_error" | "empty";
      text: string;
      errorMessage: string | null;
    };
```

The package helper should parse known runner events, ignore unknown events, validate malformed supported payloads before display translation, and expose deterministic terminal status. App code should still own labels, AI SDK chunk writing, metadata keys, and persistence behavior.

## Acceptance Result

- App-local translator remains canonical for Kestrel-One.
- No package API is added in this slice.
- No runtime event contract, SDK `subscribe()` behavior, UI component, persistence, routing, ranking, retry, or retrieval behavior changes.
- Future extraction has a narrow candidate interface and a clear second-consumer trigger.
