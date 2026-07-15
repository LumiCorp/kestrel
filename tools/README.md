# Tools Slice

This directory contains Kestrel's shared tool definitions, capability metadata, and handlers. Runtime code should compose tools through the catalog and gateway helpers instead of hard-coding tool behavior into higher layers.

## Active Tool Families

- `free.*` for low-cost reference tools such as time, weather, geocoding, exchange rates, and HN headlines
- `internet.*` for Tavily-backed search, news, images, scrape, get-url, headlines, and deep-report flows
- `filesystem.*` for workspace-scoped file operations
- `devshell.*` for managed dev shell lifecycle and command execution
- `code.*` for code execution services
- `research.*` for evidence extraction
- `runtime.*` for runtime-only helpers such as `effect_result_lookup`, `FinalizeAnswer`, and delegation tools

## Shared Contract

Each shared tool module exports:

- `definition`
- `createHandler(context)`

`definition` includes:

- `name`
- `description`
- `inputSchema`
- `capability`
- `presentation`

The exact contract types live in [tools/contracts.ts](https://github.com/LumiCorp/kestrel/blob/main/tools/contracts.ts).

## Catalog and Gateway Composition

- `createToolCatalog(...)` builds the in-memory catalog from tool modules.
- `defaultToolCatalog` exposes the default shared catalog.
- `createDefaultToolGateway(...)` builds an allowlisted runtime gateway.
- `DEFAULT_BALANCED_TOOL_ALLOWLIST` exposes the starter allowlist intended for balanced general-purpose runs.

Kestrel One Apps govern these same canonical runtime names. Built-in App
capabilities must point at the shared catalog name (for example,
`free.weather.current`) instead of defining a second app-only tool name or
handler.

Example:

```ts
const toolGateway = createDefaultToolGateway({
  allowlist: DEFAULT_BALANCED_TOOL_ALLOWLIST,
  context: {
    store,
    onFinalize: (payload) => payload,
  },
});
```

## Capability and Normalization Expectations

- Tool metadata should describe freshness, latency, cost, execution class, and capability classes.
- Boundary-facing handlers should parse or validate unknown input before use.
- Runtime-facing failures should use normalized error shapes.
- Internet tools expose normalized provider-backed envelopes rather than leaking provider-specific raw payloads into higher layers.
- Provider credentials enter shared handlers only through the scoped `providerConfigurations` resolver; diagnostic serialization exposes readiness, never secret values.
- Weather uses one normalized provider adapter contract for Open-Meteo and Visual Crossing. Local Visual Crossing calls use the scoped credential resolver, while Kestrel One calls use the App broker so hosted credentials remain server-side. Its explicit sequence is one Open-Meteo attempt capped at 8 seconds followed, only for approved retryable failures, by one Visual Crossing attempt capped at the remaining portion of an 18-second provider budget (and never more than 10 seconds).
- Filesystem tools are wrapped with the default filesystem policy before handler registration.

## Active Defaults and Intentional Non-Defaults

- The balanced starter allowlist includes free tools, internet tools, evidence extraction, `effect_result_lookup`, and `FinalizeAnswer`.
- Filesystem, dev shell, code execution, and delegation tools exist in the catalog but are not part of the balanced default allowlist.
- Legacy tool families that are not part of the current runtime surface should not be reintroduced into defaults without an explicit product and policy reason.

## Read Next

- Tool catalog: [tools/catalog.ts](https://github.com/LumiCorp/kestrel/blob/main/tools/catalog.ts)
- Runtime IO docs: [apps/docs/content/runtime/io-and-tools.mdx](https://github.com/LumiCorp/kestrel/blob/main/apps/docs/content/runtime/io-and-tools.mdx)
- Security posture: [SECURITY.md](https://github.com/LumiCorp/kestrel/blob/main/SECURITY.md)
