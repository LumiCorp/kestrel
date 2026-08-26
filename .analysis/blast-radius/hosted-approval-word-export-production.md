# Production deployment blast radius: hosted approval and Word export repair

## Readiness

**Ready, with two production targets.** The repair affects the Kestrel One Web
application and the durable turn-worker image. It does not change database
schema, environment variables, Preview Edge code, or tenant runtime contracts.

## Intent

Make hosted approval failures classify and retry correctly, keep web-only
artifact tools out of the hosted runtime profile, and expose a real Word
document export through the existing workspace preview publication lifecycle.

## Required production deployments

1. **Kestrel One Web on Vercel (`one`).** Promote the reviewed code through the
   protected `production` branch. This deploys the approval recorder, approval
   retry handling, hosted profile and provider registry, and durable turn store
   changes. The normal Vercel build also owns the ordered production migration;
   this change adds no migration.
2. **Kestrel One `turn-worker` on Fly.** Publish the reviewed image and update
   every in-scope turn-worker Machine, one exact Machine at a time. The worker
   loads the changed durable turn processor and shared tool catalog, including
   `kestrel_one.word_document_create` and the corrected file-share MIME logic.

The turn-worker rollout follows the Web deployment and its successful build.
Use the existing `production:image:publish --role turn-worker` and
`production:fly:machine --role turn-worker --machine <id>` procedures.

## Not required by this change

- **No database migration or data backfill.** The changed store logic uses the
  existing interaction fields and persistence model.
- **No Preview Edge deployment.** Word export uses the existing preview
  publication API and route; no `apps/preview-edge` code changed.
- **No control-worker, managed RunPod-worker, or environment-router rollout.**
  The worker-health signature remains backward-compatible and its production
  default remains `0.0.0.0`; only the hermetic test supplies loopback.
- **No tenant runtime promotion.** This is not a Workspace Runtime or
  Environment Router image change.
- **No `docs` deployment.** No documentation or docs-runtime code changed.
- **No new secrets or configuration activation.** Existing preview, database,
  and approval authorities are reused.

## Production verification

- Confirm the `one` Vercel deployment completed its build and migration.
- Confirm a durable turn can request and resume a hosted approval, including a
  retryable metadata/binding failure and a non-retryable access failure.
- Confirm a Build-mode turn can create a `.docx`, returns the public preview
  URL, reports the Word MIME type, and the link downloads valid Word content.
- Confirm the turn-worker Machine health and durable turn completion after each
  Machine update.

## Evidence

- **E1 — Changed-file inventory (Observed current):** `git diff --name-only`
  and `git status --short` at revision `06c9fab835935e7add851003994c882b52d91bab`.
  The changed production seams are under `apps/web` and shared `tools`; no
  deployment manifests or migrations changed.
- **E2 — Web delivery contract (Observed current):** `apps/web/vercel.json`
  defines the native `one` deployment from the protected production branch and
  its ordered migration/build command.
- **E3 — Turn-worker ownership (Static analysis):**
  `apps/web/scripts/turn-worker.ts` starts `startDurableThreadTurnWorker`, and
  `apps/web/lib/turns/queue.ts` dynamically invokes
  `apps/web/lib/turns/process-runtime.ts`.
- **E4 — Shared catalog reachability (Static analysis):**
  `tools/catalog.ts` registers the Word tool, and
  `tools/runtime/UnifiedToolRegistry.ts` imports the default catalog.
- **E5 — Production delivery policy (Declared):**
  `docs/production-delivery-channels.md` requires Vercel promotion for `one`
  and manual image publication plus exact Fly Machine updates for `turn-worker`.
- **E6 — Validation (Demonstrated by test):** `pnpm validate` passed after the
  repair; the provider/tool-contract lane passed 107 tests.

## Unknowns

- The exact production `one` deployment ID and turn-worker Machine IDs are not
  available from this local inspection.
- A live production smoke has not been run, so provider and Fly configuration
  readiness remains an operator check.

