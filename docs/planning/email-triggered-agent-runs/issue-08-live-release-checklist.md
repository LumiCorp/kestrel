# Issue 8 live activation checklist

Use one internal Organization, Project, private Email Trigger, sending mailbox,
and controlled reply mailbox. Do not use a customer-facing Trigger for this
release proof.

## Before enablement

- Record the deployed application revision and the completed `pnpm validate`,
  `pnpm validate:postgres`, and `pnpm validate:process` results.
- Bind both `KESTREL_EMAIL_RECEIVING_RELEASE_EVIDENCE_REVISION` and
  `KESTREL_EMAIL_RECEIVING_SECURITY_REVIEW_REVISION` to that exact deployment
  revision. Kestrel One will not enable inbound receiving without these
  server-owned gates and a current readiness run for the staged webhook.
- Confirm the turn worker is running, receipt reconciliation is current, and
  the configured Resend domain, credential, and staged webhook are healthy.
- Record the Security review for private-address capability handling, raw-body
  signature verification, Kestrel One and Desktop secret handling, tenant
  binding, attachment authorization, retention, and redaction.
- Configure or rotate the hosted connection from Kestrel One and refresh
  Desktop. Configure or rotate it from Desktop and refresh Kestrel One. Verify
  the same redacted state and that Desktop settings and support bundles contain
  no receiving credential or configuration copy.

## Live proof

1. An Organization Admin runs **Run release readiness** in Kestrel One, then
   enables inbound receiving. Record the redacted status and Admin audit event.
2. With Desktop closed, deliver one signed email with a text-extractable PDF
   to the private Trigger. Record one receipt, private Thread, message, and
   noninteractive turn with current Project context.
3. Confirm the run calls `kestrel_one.email_get_attachment`, reads the PDF,
   and reuses the imported Kestrel file on the second call.
4. Confirm the run requests the ordinary connected-email approval. An operator
   approves the controlled reply and records the existing approval and delivery
   evidence.
5. Repeat the delivery proof in a hosted Environment and a disconnected
   Desktop-backed Environment. The Desktop-backed run must wait durably and
   complete after reconnection without a second delivery.

## Failure and rollback proof

- Replay the signed delivery by Svix and Resend email identity. Confirm no
  duplicate receipt, Thread, or turn.
- Exercise invalid signature, ambiguous recipient, claimed-From mismatch,
  stale Trigger revision, Execution Owner loss, unavailable model, and
  cross-tenant attachment access. Confirm each produces no unauthorized work
  and safe inspection evidence.
- Disable inbound receiving in Kestrel One. Confirm the public route stops new
  receipts while materialized Threads and turns continue. If provider
  disablement fails, leave Kestrel ingress closed and retry the same disable
  action; do not create or replace a webhook.
