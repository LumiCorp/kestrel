# Persist exact admission and response proof

## Useful outcome

Operators and replay can explain why a model call was admitted, rejected before spend, rejected by the provider, or rejected by local verification without reconstructing mutable current configuration.

## What changes

Extend the existing model-call provenance ledger rather than adding a parallel ledger. Persist the effective-contract fingerprint, registration and qualification revisions, exact route and endpoint codec, routing-policy fingerprint, request-requirements hash, schema hash, tool-surface hash, provider-payload hash, terminal state, validation outcome, common failure code, and provider request ID when available.

Record pre-spend rejection separately from provider rejection, interrupted transport, and verifier rejection. Preserve admitted, rejected, verifier-rejected, and interrupted metrics by provider, model, role, endpoint codec, and capability without storing prompt content, schemas, tool arguments, credentials, opaque reasoning state, or unrestricted provider responses.

Extend `model_call_provenance` through an additive migration and compatibility reader. Keep old records readable with explicit unknown or legacy evidence. Replay and inspection must use the captured call binding rather than looking up the current registration or qualification.

Keep schema and tool canonicalization deterministic and reuse hashes already computed by runtime admission and tool-surface construction. Store references and bounded diagnostics, not duplicate large payloads.

## Requirements and delivery context

The canonical requirements are in the [Product Brief](../../model-provider-contract-hardening-product-brief.md).

The owning seams are `ModelCallProvenanceRecord` in `src/kestrel/contracts/orchestration.ts`, `src/engine/RuntimeIO.ts`, `src/store/PostgresSessionStore.ts`, `db/migrations/020_turns_model_provenance.sql` and the next additive migration, and `src/replay/RunReplayService.ts`. Existing economics events and prompt/response dump policies remain separate.

Do not persist credentials, authorization headers, raw opaque continuation, or provider payloads beyond the existing bounded retention policy.

## Done when

- Store and replay tests reconstruct the exact captured admission and terminal evidence without reading mutable current model metadata.
- Pre-spend rejection, provider rejection, interrupted transport, verifier rejection, and successful proof remain distinguishable by stable code and state.
- Legacy provenance rows remain readable and never claim registration or qualification evidence they did not capture.
- Redaction tests prove credentials, prompt content, schema bodies, tool arguments, unrestricted provider payloads, and opaque reasoning state are absent.
- Metrics expose admitted, pre-spend rejected, verifier rejected, and interrupted calls, including late `MODEL_REQUIRED_TOOL_CALL_MISSING` occurrences during migration.
- Focused migration, PostgreSQL store, replay, inspection, metrics, and redaction tests pass.
- `pnpm validate:postgres` and `pnpm validate` pass.

## Depends on

- [Admit effective model contracts before provider spend](09-admit-effective-model-contracts.md)
