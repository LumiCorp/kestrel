---
id: hosted-model-economics-profile-rollout
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-19
depends_on:
  - ../../apps/web/lib/ai/model-economics-profile.ts
  - ../../apps/web/scripts/backfill-model-economics-profiles.ts
  - ../../src/profile/kestrelOnePolicy.ts
---

# Hosted model economics-profile rollout

The hosted model approval path persists an exact Kestrel economics profile in
the approved gateway model metadata. Kestrel One, hosted Desktop, and hosted
CLI/TUI execution consume that profile. Desktop-local and standalone local
CLI/TUI models do not require one.

This follows the shared hosted runtime contract described in
[hosted workspace runtime recovery](../hosted-workspace-runtime-recovery.md).

## Preflight

Run the read-only inventory first:

```sh
pnpm --filter @kestrel/kestrel-one gateway-model-economics:backfill --dry-run
```

Review `repairable` and every `skipped` row. A skipped row with
`missing_capacity_metadata` needs a provider catalog refresh or explicit
operator remediation; removing and re-adding the model does not create missing
capacity metadata.

Rows classified as `openrouter_resolution_required` must be repaired through
the exact OpenRouter model-detail approval path; they never receive the
conservative fallback. Rows classified as `identity_unverified` or
`missing_capacity_metadata` are not safe to repair and become unapproved when
`--apply` is explicitly requested, while remaining visible in provider
settings for remediation.

To scope the inventory to one organization:

```sh
pnpm --filter @kestrel/kestrel-one gateway-model-economics:backfill \
  --dry-run --organization-id <organization-id>
```

## Deployment order

1. Deploy the server/runtime change that creates profiles during approval and
   carries them into the hosted execution profile.
2. Re-run the dry-run inventory against the target database.
3. Apply only after the output has been reviewed:

   ```sh
   pnpm --filter @kestrel/kestrel-one gateway-model-economics:backfill --apply
   ```

4. Verify a repaired model can start a hosted thread/chat in Kestrel One and a
   hosted Desktop/CLI/TUI route.
5. Monitor the structured warning
   `Approved hosted gateway model has no economics profile` and the runtime
   code `HARNESS_ECONOMICS_MODEL_PROFILE_REQUIRED`.

The backfill is idempotent and updates only approved language models for
Kestrel-runtime providers. It does not change approval state, defaults,
credentials, or local-model behavior.

## Remediation

If a model remains skipped, refresh the provider catalog so context and output
capacity are present. If the provider cannot advertise those values, keep the
model unapproved for hosted Kestrel execution until an explicit economics
profile can be supplied through the owning provider workflow.
