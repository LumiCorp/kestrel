# Ground Browser result authority in execution context

## Failed behavior

Commit `4e33f46b9` compares Browser results with `preparedAuthority` stored in mutable adapter metadata. Changing the prepared run and adapter run/Thread together remains internally consistent and passes. The validator also omits duplicated operation identities: `browser.open` mode, `browser.upload` attachment identity, and artifact ownership/URL authority.

## Affected flow

`src/effects/EffectRunner.ts` owns durable effect/run/session identity. `tools/browser/modules.ts` owns the registered Browser adapter. `src/browser/contracts.ts` owns semantic result validation and safe projection before persistence and presentation.

## Repair requirements

- Ground Browser run, Thread, session, call, and tool identity in trusted execution/effect context rather than self-asserted adapter metadata.
- Bind every duplicated result identity to the exact prepared call, including open mode, upload attachment ID, operation-specific targets, and nested session fields.
- Bind artifact IDs and presentation URLs to the prepared Thread/run authority through a trusted artifact authorization surface; do not accept descriptive or self-asserted ownership.
- Reject conflicts before exact-result persistence, audit, artifact presentation, or model rendering with one bounded secret-safe failure.
- Preserve deterministic replay of a previously accepted exact result.

## Done when

- Coordinated spoofing of prepared and adapter run/Thread fields cannot authorize foreign output.
- Foreign artifact URLs/IDs, a different upload attachment, or a different open mode are rejected before persistence or presentation.
- Legitimate Browser open, upload, capture/download artifacts, and replay remain accepted under trusted authority.
- Focused authority, artifact, upload, schema, and replay suites pass.

## Depends on

None.
