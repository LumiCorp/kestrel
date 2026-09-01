# Register the Browser App and stable tool contract

## Useful outcome

Kestrel Desktop and Kestrel One recognize one first-party `built_in.browser` App and consume one checked-in Browser App contract. Host adapters can replace the engine, but they cannot change model-visible tools, approval behavior, results, failures, or artifact presentation.

The App ships installed but disabled. Browser tools do not enter an effective runtime profile until the active host advertises a conforming `BrowserServicePort`. This issue does not launch a browser, persist personal grants, or add a viewer. It establishes the shared boundary required by the [Kestrel Browser App Product Brief](../../kestrel-browser-app-product-brief.md).

## What changes

- Add the shared Browser App contract under `src/browser/` and its tool modules under `tools/browser/`. Register the modules through `tools/catalog.ts` and `tools/runtime/builtInToolInputContracts.ts`.
- Pin these model-visible tool IDs: `browser.open`, `browser.request_grant`, `browser.snapshot`, `browser.inspect`, `browser.navigate`, `browser.interact`, `browser.tabs`, `browser.capture`, `browser.upload`, `browser.download`, `browser.request_takeover`, and `browser.close`.
- Do not add `browser.return_control`. Returning control is an authenticated viewer action. The model cannot reclaim control from a person.
- Pin the full input and output JSON Schema, approval disposition, effect/idempotency class, continuation fields, artifact kinds, and permitted failure codes for every tool in a checked-in contract fixture. Desktop and hosted registration must import this contract; host adapters cannot add fields, aliases, or result variants.
- Use the settled operation shapes: open accepts `qa` or `operator` mode and a typed target; request grant accepts an active `sessionId` and destination; snapshot accepts optional tab, scope, and cursor; inspect supports console errors, page errors, accessibility findings, or a metadata-only network summary; navigate uses URL, back, forward, or reload; interact uses a closed action union; tabs uses list, switch, or close; capture creates a screenshot; upload names one attachment and snapshot target; download names one pending download; takeover includes a reason; close names the session.
- Pin the open target matrix in the shared schema: Desktop QA selects a managed Project run and one URL recorded for that run; hosted QA selects a Kestrel Edge `previewId`; operator mode selects a public URL. Each host rejects a target kind it does not own. A raw localhost host/port or preview hostname is never authority.
- Keep `browser.interact` limited to click, fill, type, press, select, check, uncheck, and scroll. It must accept snapshot-scoped references, never selectors. A stale snapshot or document revision returns `BROWSER_TARGET_STALE` without guessing or fallback ranking.
- Define `BrowserMode` as `qa | operator`. Define lifecycle states for opening, ready, human control, closing, closed, expired, lost, and failed. Define one parsed `BrowserSessionV1` containing only session ID, Thread ID, mode, lifecycle state, engine revision, generation, effective allowlist revision, timestamps, expiry, and terminal reason.
- Treat a repeated open as compatible when Thread and mode match and, in QA mode, the trusted target identity also matches. An operator destination is navigation input, not session identity. An allowlist revision change is adopted in place. Every other open conflict requires explicit close.
- Add one `BrowserServicePort` to `SharedToolContext`. The handler passes the durable `PreparedToolCallV1`, including trusted `effectiveInput`, policy disposition, approval authority, and exact-effect identity. A host adapter must not reread raw model input or calculate weaker authority.
- Keep session storage host-owned. Issue 01 owns only `BrowserSessionV1`, parsing, tool handlers, and the fake-port conformance suite. Issues 03 and 05 own real storage and lifecycle.
- Use this approval contract: authorized open, snapshot, inspect, navigate, interact, tabs, capture, request takeover, and close are automatic. An unauthorized open returns a blocked result and does not ask. Request grant returns automatically when already effective, blocks without asking when policy forbids the destination, and asks once for a new eligible personal grant. Upload and download always require approval. Takeover uses the viewer control flow, not a generic action approval.
- Encode that approval contract in descriptors and trusted policy preparation. Do not classify clicks, forms, destinations, or risk from keywords, selectors, URL paths, page content, or prior visits.
- Tell the model that passwords, passkeys, one-time codes, SSO, and MFA must use takeover and must never be supplied to `browser.interact`. Do not add field-type or page-content heuristics to guess whether text is a credential.
- Reuse `PreparedToolCallV1`, exact effects, result normalization, runtime events, generic approval interactions, and `AgentToolArtifactPresentation`. Do not add durable `BrowserAction`, `BrowserEvidence`, browser-specific approval, or browser-specific replay systems.
- Make snapshot and inspection results carry snapshot/document revision, session generation, normalized origin, capture time, untrusted-content boundary, and deterministic continuation. Pin a pending-download descriptor with download ID, sanitized filename, measured bytes, untrusted declared media type, normalized source origin, SHA-256, creation time, and expiry; navigate or interact can return it when a download finishes.
- Pin one stable failure code and semantics for session conflict, expired session, lost session, blocked destination, denied grant, human control, stale target, unknown action outcome, oversized artifact, unavailable host service, and engine failure.
- Give support a metadata-only projection that preserves those distinctions without URL queries, page bodies, screenshots, form values, credentials, or takeover input.
- Classify which engine operations are effectful in the contract fixture. A timeout after acknowledged dispatch of an effectful operation returns `BROWSER_ACTION_OUTCOME_UNKNOWN`; read-only snapshot or inspection failure must not be mislabeled as an unknown external effect.
- Add one checked-in release manifest at `src/browser/runtimeReleaseManifest.ts`. It must contain exact engine and Chrome revisions plus source URL and SHA-256 per runtime target. It must not use `latest`. Exact versions can change without changing the Browser App contract.

## Requirements and delivery context

Shared App identity is owned by `packages/protocol/src/apps.ts`. Desktop App definition and profile projection are owned by `src/desktopShell/configuration.ts`, `src/desktopShell/executionProfile.ts`, `apps/desktop/src/settingsStore.ts`, and `apps/desktop/src/rendererSettings.ts`.

Hosted App metadata starts in `apps/web/lib/tools/registry.ts`; `apps/web/lib/apps/catalog.ts` derives from it, and `apps/web/lib/apps/service.ts` persists it. `apps/web/lib/tools/service.ts` owns platform-managed readiness. `apps/web/lib/agent/kestrel-tool-profile.ts` must map the enabled Browser capability into the hosted runtime profile.

The registry and preparation seams are `tools/contracts.ts`, `tools/catalog.ts`, `tools/runtime/UnifiedToolRegistry.ts`, `tools/runtime/builtInToolInputContracts.ts`, and `src/kestrel/contracts/tool-invocation.ts`. Extend these seams instead of exposing raw agent-browser MCP or CLI.

Add contract tests for every descriptor and schema, schema rejection, approval disposition, exact-effect classification, fake-port routing, output budgets, continuation, artifact projection, stale targets, session parsing, failure codes, host readiness, and absence of raw engine controls. Run focused suites and `pnpm validate`.

## Done when

- Desktop and Kestrel One discover the same installed-but-disabled Browser App, and neither exposes it without a conforming host service.
- One checked-in fixture pins all model-visible Browser App inputs, outputs, approval behavior, effects, artifacts, continuations, and failures.
- A fake host proves existing preparation, exact-effect, approval, result, event, and artifact machinery owns the operation lifecycle.
- Reopen compatibility, conflict, expiry, loss, stale target, human control, unknown outcome, and engine failure have one tested meaning.
- No model-visible or client contract exposes raw engine commands, selectors, CDP, JavaScript evaluation, sockets, credentials, profiles, or filesystem paths.
- The release manifest pins exact runtime assets without making their versions part of the model contract.
- Focused coverage and `pnpm validate` pass.

## Depends on

None.
