# Reject malformed successful receiving responses in One

## Failed behavior

The One receiving controller casts successful response bodies without runtime validation. A malformed 2xx save can show success, clear the write-only key and selected domain, empty domain choices, and replace the connection with `undefined`; malformed fields can also reach rendering.

## Affected work

This repairs [Prevent an older One receiving check from repainting newer health](17-prevent-stale-one-receiving-refreshes.md) in change `026050c75..ffef42701`, specifically `apps/web/components/settings/receiving-client-controller.ts`.

## Repair requirements

Only a structurally valid redacted connection or domain envelope may update presentation state. Invalid 2xx bodies are operation failures that preserve the form, current connection, current domains, and do not emit success. Validation must remain client-safe and must not accept secret-bearing or unknown response shapes.

## Done when

- Malformed save success cannot clear the key, domain selection, choices, or emit success.
- Malformed load, reconciliation, and domain responses preserve the prior valid presentation and show a safe failure.
- Focused executable controller tests cover missing, wrong-type, unknown-field, and invalid-enum payloads.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
