# Canonicalize Browser artifact presentation

## Failed behavior

Commit `cfc59f05a` authorizes Browser artifact ID, kind, and optional URL, but persists host-returned presentation fields and the full URL. Signed URL query parameters and untrusted title or metadata can therefore enter generic completion events despite Browser redaction.

## Affected flow

`src/browser/contracts.ts` owns artifact authorization and safe presentation. `src/engine/RuntimeIO.ts` owns generic run-event projection. `tools/browser/modules.ts` must pass only the authorized canonical artifact record into result normalization.

## Repair requirements

- Derive every persisted and displayed artifact field from trusted authorization output, or validate it exactly against that output.
- Remove URL query and fragment data from durable event evidence; do not persist signed tokens or untrusted host-returned titles/metadata.
- Keep the usable authorized presentation URL only on the surface that requires it, without copying it into logs, traces, audit evidence, or generic run events.
- Preserve artifact ID, safe kind/media type, bounded byte size, and stable non-secret labels where authorized.

## Done when

- Signed-URL query sentinels and capture/download title/metadata sentinels are absent from completed, failed, replay, trace, and audit evidence.
- An authorized artifact remains presentable through its trusted URL surface, while durable generic evidence contains only bounded canonical references.
- Focused Browser projection, event, artifact, and replay suites pass.

## Depends on

None.
