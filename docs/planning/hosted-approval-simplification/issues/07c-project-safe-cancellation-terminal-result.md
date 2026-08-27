# Project a safe cancellation terminal result

## Failed behavior

The cancellation conversion republishes arbitrary runtime result, output, and
error-detail fields while changing the terminal type. Mixed or legacy
producers can therefore place prompts, tool payloads, credentials, or provider
details into a `run.cancelled` event or external cancellation error.

## Affected work

[Preserve completed model telemetry when a run is canceled](07-preserve-cancellation-telemetry.md),
change `9945c848c..eca1b7369`, `cli/runner/RunnerHost.ts`, and
`apps/web/lib/agent/kestrel-external-runtime-core.ts`.

## Repair requirements

Build cancellation output from an explicit safe projection. Preserve only the
owned output contract, approved numeric telemetry, and bounded cancellation
evidence. Do not expose arbitrary result extensions, finalized payloads,
operator affordances, error details, prompts, tool payloads, or secrets.

## Done when

- Cancellation terminals contain only the explicit safe result projection.
- External cancellation errors allowlist their structured support evidence.
- Adversarial tests prove injected result, output, and error-detail secrets do
  not cross either boundary.

## Depends on

None.
