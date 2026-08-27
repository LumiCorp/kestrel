# Reject every superseded stored-key receiving save outcome

## Failed behavior

The stored-key save detects supersession only on its ready-domain commit path. If the older provider call instead fails or returns an unready domain after a newer same-key check advances the sequence, health persistence silently skips the stale result and the save surfaces the old provider or domain error instead of the stable superseded-save conflict.

## Affected work

This repairs [Reject superseded stored-key receiving saves](25-reject-superseded-receiving-saves.md) in change `a68deac4e..8b1341792`, specifically the provider-failure and domain-not-ready exits in `apps/web/lib/email/receiving-config.ts`.

## Repair requirements

Every terminal outcome of a stored-key save must establish whether its claimed sequence is still current before returning. A newer same-key operation makes the save reject with `RESEND_RECEIVING_SAVE_SUPERSEDED`, including provider-failure and domain-not-ready outcomes. Credential rotation must retain precedence as `RESEND_RECEIVING_CREDENTIAL_CHANGED`; ordinary health-only stale completions must remain silent no-ops; candidate-key saves remain outside stored-key ordering.

## Done when

- Deferred PostgreSQL regressions cover superseded stored-key saves whose provider call fails and whose returned domain is not ready.
- Both paths reject with the stable superseded code, persist no stale health or domain evidence, and produce no successful audit.
- Non-superseded provider and domain errors retain their existing classifications.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
