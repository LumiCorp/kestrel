# Bound Resend webhook bodies before verification

## Useful outcome

The public Resend ingress boundary rejects an oversized unauthenticated request before it can force Kestrel One to buffer arbitrary memory, while valid signed email metadata continues through untouched-body verification.

## Failed behavior

After an active locator is resolved, the route checks only attacker-controlled Svix header names and calls `request.text()` without a byte limit. Signature verification and bounded Zod validation occur only after the full body has been allocated, so anyone who learns the registered endpoint can send an arbitrarily large fake-signed body.

## Affected work

This repairs [Accept signed Resend deliveries durably](03-accept-signed-resend-deliveries.md) in change `1dca25008..65a832172`, specifically raw request handling and telemetry in `apps/web/lib/email-receipts/ingress.ts`.

## Repair requirements

- Reuse Kestrel's established 2 MiB request-body ceiling as the exact Resend webhook boundary. Keep the limit explicit, named, and covered as a public contract.
- Reject a declared `Content-Length` above the ceiling before reading the body, but do not trust that header as enforcement.
- Read the request stream once while counting actual bytes. Cancel and reject as soon as the ceiling is exceeded, including absent, malformed, understated, or chunked `Content-Length` cases.
- Preserve the exact collected UTF-8 payload for the installed Resend/Svix verifier. Do not parse JSON, select event data, or create a receipt before signature verification succeeds.
- Return a stable content-free `413` outcome and bounded allowlisted telemetry. Do not log the locator, headers, signature, body, provider IDs, address metadata, or content.
- Unknown and disabled locators must continue to stop before any body read.

## Done when

- A declared-oversized request and an understated or chunked oversized stream return `413`, allocate only bounded request memory, and create no receipt.
- A payload exactly at the ceiling is read once and reaches signature validation; a normal valid signed event still creates its durable receipt.
- Invalid UTF-8, malformed JSON, invalid signature, unsupported event, unknown locator, and disabled locator retain stable content-free outcomes.
- Focused stream, byte-boundary, signature, no-body-read, receipt-absence, telemetry, and redaction tests pass.
- `pnpm validate` and `pnpm validate:postgres` pass.

## Depends on

None.
