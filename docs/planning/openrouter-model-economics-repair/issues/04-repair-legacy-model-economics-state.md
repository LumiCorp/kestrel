# Repair legacy model profiles without losing default intent

## Useful outcome

Operators can inventory and repair existing approved hosted models with the final admission rules. Valid exact routes become ready, unrepaired rows become visibly unavailable, and stored Environment default intent remains recoverable.

This slice completes the transition from legacy approval-only state to truthful hosted model eligibility.

## What changes

Extend the existing economics-profile backfill into a resumable repair operation that uses the same provider resolution, profile derivation, fallback, and eligibility contracts as live approval.

The dry run must classify every applicable hosted language row as:

- Already valid.
- Repairable from provider facts.
- Repairable with an eligible provider default.
- Exact identity mismatch.
- Router or non-exact route.
- Provider authentication or lookup failure.
- Missing required capacity.
- Equal-capacity admission.
- Concurrently changed or stale evidence.

For approved OpenRouter rows, resolve the exact route through the model-detail endpoint. Require the returned ID to match. Never apply conservative fallback to OpenRouter.

For fallback-eligible providers, use the adapter rules and precedence delivered by the provider fallback issue. Preserve valid existing profiles and prefer provider facts.

Apply mode must write only reviewed, still-current results. Compare row update time or another row version and gateway credential revision before mutation. Successful rows receive provider evidence, exact profile, and provenance. Rows that cannot be repaired become unapproved and non-default while remaining visible to administrators.

Do not delete stale Environment default references. The runtime eligibility behavior from the prerequisite issue must keep those references inactive and make deterministic substitution visible. A later exact repair may reactivate the same stored reference.

Update the hosted model economics rollout guidance and support-facing remediation text. Administrators must be directed to retry provider resolution, correct the exact route, or replace a stale default. They must not be told to create an economics profile manually.

Emit structured, credential-safe results that let operators distinguish retryable provider failures from permanent route or contract failures. The operation must remain safe to repeat after partial success or concurrent changes.

## Requirements and delivery context

The canonical requirements are in the [Product Brief](../../openrouter-model-economics-repair-product-brief.md).

The existing pure planning seam is `apps/web/lib/ai/model-economics-profile-backfill.ts`. The operator entry point is `apps/web/scripts/backfill-model-economics-profiles.ts`, and the current runbook is `docs/references/model-economics-profile-rollout.md`.

The current backfill only derives profiles from stored metadata and skips missing capacity. Replace that limitation by reusing the authoritative live admission services. Do not duplicate provider identity or fallback rules in the script.

Keep dry-run as the default safe inspection path and require an explicit apply mode. Preserve organization scoping, idempotency, conditional updates, and credential secrecy.

Runtime eligibility protection must already be active before apply mode changes legacy rows. The repair operation must not broaden into infrastructure deployment or production execution.

## Done when

- Dry run classifies all applicable legacy hosted rows without mutation and reports enough evidence for operator review.
- Apply repairs exact OpenRouter models such as `qwen/qwen3.8-27b` and accepts equal capacity for `z-ai/glm-5.2:free` when their returned IDs match.
- Apply assigns conservative profiles only through eligible provider adapters and records `kestrel_default` provenance.
- Unrepairable rows become unapproved and non-default but remain visible with actionable status.
- Stale Environment default references remain stored, inactive, and visible; successful repair can restore their eligibility.
- Concurrent row or credential changes are skipped rather than overwritten.
- The operation is idempotent, resumable, organization-scopeable, and credential-safe.
- Updated operator and support guidance describes the new statuses and remediation paths.
- Focused planning, apply, concurrency, failure classification, and transition tests pass.
- `pnpm validate` passes.

## Depends on

- [Keep ineligible hosted models out of runtime selection](02-enforce-hosted-model-runtime-eligibility.md)
- [Assign disclosed defaults only through eligible provider adapters](03-add-provider-declared-economics-fallbacks.md)
