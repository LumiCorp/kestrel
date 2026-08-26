# Carry strict V2 decisions through hosted clients

## Failed behavior

The runtime accepts only `decline` and `approve_once` for V2, but Web and
Mobile still submit an `approved` boolean and the runtime bridge forwards only
text. Clicking either hosted approval action therefore resumes without a V2
decision and presents the same approval wait again.

## Affected work

[Align the V2 approval prompt with its strict decisions](01e-align-v2-prompt-decisions.md),
commit `addc425e1`, especially hosted request contracts, interaction routes,
durable turn processing, runtime bridging, and client approval actions.

## Repair requirements

Carry the exact versioned V2 decision from the rendered interaction through the
authenticated API, durable decision transaction, queue/worker boundary, and
runtime event. Keep boolean mapping only on the explicit legacy compatibility
path.

## Done when

- Hosted Web and Mobile Decline reaches runtime as `decline`.
- Hosted Web and Mobile Approve Once reaches runtime as `approve_once`.
- A browser-to-runtime integration test proves each advertised decision.
- Old-version boolean submissions remain on their explicit compatibility path.

## Depends on

None.
