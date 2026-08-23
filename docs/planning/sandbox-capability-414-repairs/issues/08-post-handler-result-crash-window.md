# Close the post-handler exact-result crash window

## Failed behavior

Docker terminalizes and cleans a completed capability lease before returning the sandbox result. The exact enclosing `AgentToolResult` is persisted later by `EffectRunner`. A crash between those boundaries leaves a cleaned lease with no effect result, and recovery excludes cleaned leases, so the exact completed output cannot be restored.

## Affected work

GitHub issue #414, commit `19fb21964`, Docker teardown lifecycle, `CodeExecutionService`, `EffectRunner`, runtime orphan recovery, and both lease stores.

## Repair requirements

The exact final effect result must become durable before a completed lease becomes non-recoverable, or recovery must include the exact cleaned/missing-result state with sufficient durable evidence to restore it. Provider-only evidence must never be substituted for the enclosing result, and recovery must never rerun Docker or the provider.

## Done when

- A crash after handler completion but before the ordinary effect save recovers the exact DONE result.
- Recovery performs zero credential, provider, broker, and Docker calls.
- Provider-only or incomplete sandbox output still fails closed.
- In-memory and Postgres crash-injection tests cover the exact boundary.

## Depends on

01 and 07.
