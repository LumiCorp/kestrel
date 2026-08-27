# Complete deletion after a webhook create is verified absent

## Useful outcome

Organization deletion completes when a durable attempted-create checkpoint is reconciled against Resend and proves that no matching webhook exists, while multiple or contradictory matches still fail closed.

## Failed behavior

Staging records `webhookCreateAttemptedAt` before provider I/O. A crash after that checkpoint but before the POST leaves no external webhook. Decommission always calls the staging reconciliation contract, which rejects zero matches as an invalid response, so every deletion retry fails forever even though absence is the desired cleanup state.

## Affected work

This repairs [Decommission Resend receiving before Organization deletion](44-decommission-resend-before-organization-deletion.md) in `38c2712e9..d95a29238`, specifically lifecycle reconciliation of an ambiguous create.

## Repair requirements

- Add a deletion-specific provider lifecycle reconciliation that distinguishes zero exact intent matches from one recoverable match and multiple/contradictory evidence.
- Treat zero matches across a complete, validated, paginated webhook list as verified absence and continue deletion without a create or remove call.
- Preserve the staging contract: ordinary staging still requires exactly one enabled matching webhook after an attempted create and must never interpret zero matches as success.
- For one match, retrieve and validate the full projection and one-time signing-secret evidence, persist recovered identity, then remove and verify absence as today.
- Multiple matches, malformed/incomplete pagination, identity/status disagreement, provider outage, or invalid evidence remain retryable redacted failures.
- Add focused provider and PostgreSQL deletion tests for zero, one, multiple, malformed, and retry paths.

## Done when

- A checkpoint-before-POST fixture completes Organization deletion without creating or removing a webhook.
- A single accepted-but-ambiguous webhook is still recovered, persisted, removed, and verified absent.
- Multiple or contradictory matches fail closed and preserve deletion authority for retry.
- No staging recovery behavior is weakened.
- `pnpm validate` and `pnpm validate:postgres` pass.

## Depends on

None.
