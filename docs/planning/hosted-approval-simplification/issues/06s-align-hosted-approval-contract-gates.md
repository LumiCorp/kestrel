# Align hosted approval contract gates

## Failed behavior

Five hermetic source-contract assertions still encode the pre-Issue-06
implementation. They require hosted preset version 2, the old composition
fingerprint, the old remember-validation expression, and the absence of image
digest evidence. The implemented Issue 06 contract intentionally uses preset
version 4, current-policy validation before evidence insertion, and immutable
digest proof, so `pnpm validate` fails despite the new behavior passing its
focused tests.

## Affected work

[Make hosted tool availability and approval one truthful decision](06-unify-hosted-tool-decision.md)
and its compatibility repairs through
[Redact cleanup quarantine audit](06p-redact-cleanup-quarantine-audit.md),
range `1760c3769..d1319b52b`. The stale assertions are in
`apps/web/lib/apps/hosted-app-transaction-boundary.test.ts`,
`tests/unit/kestrel-one-policy.test.ts`, and
`tests/unit/production-delivery-boundary.test.ts`.

## Repair requirements

Make the source-contract gates assert the settled V4 rollout and current
implementation invariants. Keep their security intent: current authority must
be validated before remembered evidence is inserted; preset and fingerprint
versions must be immutable and exact; image publication must smoke before push,
emit immutable digest evidence, and never deploy or notify.

## Done when

- All five stale assertions pass against the settled Issue 06 contract.
- Focused Web hosted-transaction, Kestrel policy, and production-delivery tests
  pass without weakening their security or no-deployment guarantees.
- The full `pnpm validate` gate passes or reports only proven unrelated
  baseline failures.

## Depends on

[Make hosted tool availability and approval one truthful decision](06-unify-hosted-tool-decision.md).
