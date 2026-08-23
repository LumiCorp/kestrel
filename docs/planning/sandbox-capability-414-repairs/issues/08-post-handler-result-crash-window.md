# Close the post-handler exact-result crash window

## Failed behavior

Docker terminalizes and cleans a completed capability lease before returning the sandbox result. The exact enclosing `AgentToolResult` is persisted later by `EffectRunner`. A crash between those boundaries leaves a cleaned lease with no effect result, and recovery excludes cleaned leases, so the exact completed output cannot be restored.

## Affected work

GitHub issue #414, commit `19fb21964`, Docker teardown lifecycle, `CodeExecutionService`, `EffectRunner`, runtime orphan recovery, and both lease stores.

## Repair requirements

The exact final effect result must become durable before Docker cleanup makes the completed lease and sandbox output non-recoverable. Persisting immediately after the tool gateway resolves is insufficient because Docker teardown has already completed. Provider-only evidence must never be substituted for the enclosing result, and recovery must never rerun Docker or the provider.

## Done when

- A crash immediately after Docker/gateway completion but before the ordinary handler-level save still recovers the exact DONE result.
- Recovery performs zero credential, provider, broker, and Docker calls.
- Provider-only or incomplete sandbox output still fails closed.
- In-memory and Postgres crash-injection tests cover the exact boundary and prove the result became durable before cleanup.

## Depends on

01 and 07.
