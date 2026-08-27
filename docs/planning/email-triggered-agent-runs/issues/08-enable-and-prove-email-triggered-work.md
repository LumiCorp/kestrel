# Safely enable and prove email-triggered work

## Useful outcome

Release operators can enable inbound receiving only after Kestrel can safely accept, hydrate, materialize, inspect, retain, and process attachments from every email. The complete private-trigger workflow has production evidence, including one useful connected business-App action under the Project's existing controls.

## What changes

- Add one readiness decision that covers the Receiving Connection schema and secret, staged provider webhook, signed route, durable receipt queue and recovery, hydration worker, materializer, attachment relay, daily retention maintenance, inspection surfaces, and redaction evidence.
- Verify that Kestrel One and Kestrel Desktop configure and render the same hosted Receiving Connection. Save or replace the write-only key and receiving subdomain from each surface, refresh the other, and prove there is no Desktop-local secret or configuration copy.
- Keep inbound status unavailable and the staged Resend webhook disabled while any required owner is missing or unhealthy.
- Enable the existing staged provider webhook only after readiness passes. Do not create a second webhook or move registration ownership out of the signed-ingress issue.
- Define rollback and disablement behavior that stops new receipts at the public route without cancelling materialized Threads or turns.
- Run a real or deployment-faithful full-story verification with a signed email containing a text-extractable PDF. Prove one receipt, one private Thread, one noninteractive turn, current Project context, and the deterministic untrusted email envelope.
- Require the agent to call `kestrel_one.email_get_attachment`, read the PDF, and call it again without another provider download or Kestrel file.
- Require the triggered run to invoke one already-connected calendar, email, accounting, support, or other business App. The App action must follow the Project's existing access, approval, spending, and evidence rules.
- Prove hosted execution and a disconnected Desktop-backed Environment that waits durably and continues after reconnection without resending the email. Desktop must never receive the webhook.
- Close Desktop after configuring an enabled connection and prove Kestrel One still accepts and materializes email. Reopen Desktop and prove it reads current hosted state rather than stale local state.
- Prove replay, invalid signature, ambiguous recipient, claimed-From mismatch, stale Trigger revision, Execution Owner loss, model loss, cross-tenant attachment access, and protected-value redaction.
- Preserve outbound Organization Email configuration, outbound testing, and `email.send` behavior.
- Record Security review evidence for the private-address capability, raw-body signature boundary, hosted and Desktop secret handling, typed Desktop bridge, local persistence and support-bundle exclusion, tenant binding, sender-authentication language, attachment authorization, retention behavior, and redaction before enablement.
- Keep normal operation free of manual forwarding, attachment download, turn creation, or Desktop ingress work.

## Requirements and delivery context

This issue activates the behavior delivered by the preceding issues; it must not introduce a new admission rule, App policy, retry heuristic, service principal, workflow recipe, or public Trigger mode.

Release readiness must be derived from durable and operational evidence rather than an Admin action racing deployment order. A secondary smoke or reporting failure must not replace the owning receipt, turn, tool, or policy outcome.

The portable validation and PostgreSQL boundary gates remain release requirements. Process-boundary validation applies because the flow spans the Kestrel One web process, turn worker, Environment router, hosted runtime, and Desktop-backed execution route.

The canonical requirements are in the [Email-Triggered Agent Runs Product Brief](../../email-triggered-agent-runs-product-brief.md).

## Done when

- Inbound receiving cannot report ready or enable its provider webhook while any schema, route, secret, queue, worker, materializer, relay, retention, inspection, or redaction owner is unavailable.
- Kestrel One and Desktop prove cross-surface state parity, write-only secret behavior, server-enforced Organization Admin authorization, and zero Desktop-local secret or receiving-state persistence.
- The complete signed email creates exactly one receipt, Thread, message, and turn and never duplicates work when replayed by Svix or Resend email identity.
- The agent reads and reuses one text-extractable PDF through the receipt-scoped tool and can reopen the imported file later through `kestrel.files.open`.
- The triggered agent completes one useful action through an already-connected business App under the existing access, approval, spending, and evidence rules.
- Hosted execution and Desktop durable wait and reconnect pass without Desktop ingress or email resend; hosted receiving also continues while Desktop is closed after setup.
- Invalid signature, ambiguity, filter mismatch, stale revision, owner loss, model loss, and cross-scope attachment attempts start no unauthorized work and remain inspectable.
- Security review evidence covers every required private-admission, signature, hosted/Desktop secret, typed bridge, local-persistence, tenant, sender-language, attachment, retention, and redaction boundary.
- Rollback or disablement stops new receipts and leaves materialized work and evidence intact.
- Outbound email regression coverage remains green.
- Focused readiness, webhook activation, rollback, Security review, full-story, Kestrel One/Desktop management parity, Desktop-close continuity, hosted, Desktop execution, connected-App, replay, negative-path, and redaction tests pass.
- `pnpm validate`, `pnpm validate:postgres`, and `pnpm validate:process` pass.

## Depends on

- [Let the triggered agent read an email attachment](06-read-email-attachments-on-demand.md)
- [Retain and inspect email-triggered work safely](07-retain-and-inspect-email-triggered-work.md)
