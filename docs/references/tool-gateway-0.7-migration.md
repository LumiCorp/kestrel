---
id: tool-gateway-0-7-migration
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-03
depends_on:
  - ../../src/io/ToolGateway.ts
  - ../../src/kestrel/contracts/tool-contract.ts
---

# Tool Gateway 0.7 Registration Migration

Kestrel 0.7 no longer accepts a raw map of tool names to handlers in
`AllowlistedToolGateway`. Every executable tool must be registered as a
complete embedded module with one canonical `ToolDescriptorV1`.

Before:

```ts
new AllowlistedToolGateway({
  lookup: async (input) => lookup(input),
});
```

After:

```ts
new AllowlistedToolGateway([
  createEmbeddedToolModuleV1({
    ownerId: "example.integration",
    toolId: "example.lookup",
    description: "Look up one example record by ID.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    runtimeOutputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "static",
      latencyClass: "low",
      costClass: "free",
      executionClass: "read_only",
      capabilityClasses: ["example.lookup"],
    },
    presentation: {
      displayName: "Example lookup",
      aliases: ["lookup"],
      keywords: ["example"],
      provider: "example",
      toolFamily: "lookup",
    },
    handlerId: "example.integration:lookup:v1",
    resultNormalizerId: "example.integration:json:v1",
    handler: async (input) => lookup(input),
  }),
]);
```

Input and runtime-output schemas use the supported strict draft-07 profile.
Model-facing object schemas must declare `additionalProperties` explicitly.
Registrations using `$ref`, unknown fields or formats, unsupported schema
metadata, missing handler or normalizer identities, or colliding tool IDs fail
before model exposure.

The descriptor revision covers all immutable decision-relevant fields. Do not
put credentials, connection objects, lifecycle timestamps, availability, or a
registry generation in a descriptor. Runtime scope is represented separately
by a secret-free scope fingerprint and activation reference.

Web App and provider capability rows remain policy overlays. Their non-null
`runtimeName` must resolve to an exact descriptor reference; the overlay does
not own a second schema or handler identity.
