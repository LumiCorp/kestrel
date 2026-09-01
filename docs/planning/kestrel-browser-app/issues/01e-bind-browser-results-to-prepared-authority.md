# Bind Browser results to prepared authority

## Failed behavior

Repair commit `2e0ee9771` validates Browser result shape, operation identity, timestamps, and origin syntax but does not bind returned session or Thread identity to the prepared invocation. A mixed-version or compromised Browser port can accept a call for one session and return a structurally valid result or artifact from another session or Thread. The gateway then persists and renders that cross-authority result as the exact result of the caller's prepared action.

## Affected flow

This defect blocks [Enforce secret-safe Browser results](01c-enforce-secret-safe-browser-results.md) in repair commit `2e0ee9771`.

`tools/browser/modules.ts` owns normalization with access to the durable prepared call. `src/browser/contracts.ts` owns semantic parsing and safe projection. Exact result persistence, audit evidence, artifact presentation, and model output all consume the normalized result.

The repair boundary includes prepared Browser identity extraction, semantic result validation, artifact and session ownership checks, mixed-version host rejection, and sentinel tests.

## Repair requirements

- Bind every Browser result to the operation, session, Thread, and run authority in the durable prepared call wherever that identity is present in the contract.
- Reject a result whose top-level or nested session identity conflicts with the prepared call before persistence, audit projection, artifact presentation, or model rendering.
- Reject conflicting duplicated identity fields rather than choosing one.
- Normalize the rejection to one pinned, bounded, metadata-only Browser failure without including foreign page content, artifact data, URLs, form values, credentials, or takeover input.
- Preserve legitimate session-creation output for `browser.open` and deterministic replay of an accepted exact result.

## Done when

- Tests prove a valid-shape result from another session, Thread, run, or operation cannot cross the Browser result boundary.
- Cross-authority results never enter durable result evidence, audit evidence, artifacts, traces, or model-visible output; secret sentinels remain absent.
- `browser.open` binds its newly created session to the prepared Thread/run, while later tools bind to the prepared session.
- An accepted result replays exactly without revalidating against mutable host state or redispatching.
- Focused Browser schema, normalizer, audit, artifact, and replay suites pass.

## Depends on

None.
