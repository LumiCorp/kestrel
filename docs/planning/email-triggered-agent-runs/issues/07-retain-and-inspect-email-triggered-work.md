# Retain and inspect email-triggered work safely

## Useful outcome

Project members and support can see where an email stopped without exposing protected content. Email content, receipt evidence, and attachment provenance follow the settled lifecycle even when cleanup or presentation fails.

This is the operating lifecycle slice. It does not activate production receiving or change email admission, execution, or attachment semantics established by the earlier issues.

## What changes

- Show Project members the Trigger, receipt, hydration, rejection, materialization, and linked Thread outcomes they are authorized to inspect. The attachment tool issue owns its tool-call and import-failure presentation.
- Let support and operators correlate the Receiving Connection, Delivery Receipt, Trigger, Thread, turn, and Delivery Attachment through opaque internal IDs and stable reason codes.
- Keep the Thread and turn records authoritative after materialization. Do not copy running or terminal execution state into the receipt.
- Record bounded metrics for webhook freshness, queue latency, duplicate delivery, hydration, admission, rejection, materialization, execution routing, and worker reconciliation. The attachment tool owns attachment-import metrics.
- Audit every relevant log, analytic event, durable event, error, and model-visible surface. Redact Trigger addresses, credentials, signing material, raw bodies, provider IDs, temporary URLs, and email content where retention forbids it.
- Preserve the original durable failure when presentation, metric, cleanup reporting, or other secondary work fails.
- Add authenticated daily maintenance for terminal, nonmaterialized receipts. Purge the minimal diagnostic record at 30 days; do not use the five-second turn-worker reconciliation loop for retention.
- Prove that nonmaterialized terminal transitions already removed hydrated content immediately. The daily purge is not a fallback for content scrubbing.
- Keep materialized receipt and Delivery Attachment records for the linked Thread lifecycle. Deleting the Thread removes that provenance without affecting unrelated work.
- Preserve outbound Organization Email configuration, outbound testing, and `email.send` behavior.

## Requirements and delivery context

Use the existing authenticated attachment-cleanup cron route and `apps/web/vercel.json` as the operating pattern for daily retention maintenance. Keep the receipt worker's short reconciliation loop focused on durable dispatch and interruption recovery.

Extend the Triggers and Thread surfaces rather than creating a separate workflow console. Operator evidence must be useful without disclosing private addresses, email content, provider identities, credentials, or temporary access.

The canonical requirements are in the [Email-Triggered Agent Runs Product Brief](../../email-triggered-agent-runs-product-brief.md).

## Done when

- A Project member can distinguish queued, hydrating, admitted, rejected, failed, and materialized receipt outcomes and open the linked Thread when one exists.
- Support can distinguish signature, payload, duplicate, recipient, filter, hydration, owner, revision, model, and routing failures without protected content. The attachment tool issue owns attachment, integrity, quarantine, and representation failure evidence.
- Every nonmaterialized terminal receipt is content-free immediately, retains only allowed diagnostic metadata through day 29, and is purged at day 30.
- Replay deduplication remains effective during that 30-day terminal-record window and does not claim protection after the purged nonmaterialized receipt no longer exists.
- Materialized receipts and Delivery Attachments follow Thread deletion, while unrelated Threads, turns, files, and receipts remain unchanged.
- Redaction tests find no Trigger address, secret, raw body, provider ID, temporary URL, or prohibited email content in protected surfaces.
- Outbound email regression coverage remains green.
- Focused retention, cron authorization, route ownership, inspection, redaction, and lifecycle tests pass.
- `pnpm validate` and `pnpm validate:postgres` pass.

## Depends on

- [Materialize an admitted email as a durable Project run](05-materialize-email-triggered-project-run.md)
