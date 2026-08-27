# Email-Triggered Agent Runs Implementation Queue

Each issue appears in one state. `Ready` is the current dependency-free frontier. Move issues between states as implementation and review change the graph.

## Ready

- [Let the triggered agent read an email attachment](06-read-email-attachments-on-demand.md)

## Blocked
- [Retain and inspect email-triggered work safely](07-retain-and-inspect-email-triggered-work.md) — blocked by [Materialize an admitted email as a durable Project run](05-materialize-email-triggered-project-run.md)
- [Safely enable and prove email-triggered work](08-enable-and-prove-email-triggered-work.md) — blocked by [Let the triggered agent read an email attachment](06-read-email-attachments-on-demand.md) and [Retain and inspect email-triggered work safely](07-retain-and-inspect-email-triggered-work.md)

## In progress

None.

## Implemented

None.

## Done

- [Materialize an admitted email as a durable Project run](05-materialize-email-triggered-project-run.md)
- [Hydrate and admit one received email](04-hydrate-and-admit-received-email.md)
- [Accept signed Resend deliveries durably](03-accept-signed-resend-deliveries.md)
- [Reconcile configured Receiving Connections into staged webhooks](41-reconcile-configured-receiving-webhooks.md)
- [Replace Resend credentials without orphaning webhook staging](42-replace-resend-credentials-safely.md)
- [Recover queued receipts after terminal pg-boss jobs](43-recover-terminal-receipt-jobs.md)
- [Decommission Resend receiving before Organization deletion](44-decommission-resend-before-organization-deletion.md)
- [Bound Resend webhook bodies before verification](45-bound-resend-webhook-bodies.md)
- [Fence receiving throughout Organization deletion](46-fence-receiving-during-organization-deletion.md)
- [Prove Resend key replacement through One and Desktop routes](47-prove-resend-key-replacement-through-management-routes.md)
- [Bound Resend management requests](48-bound-resend-management-requests.md)
- [Complete deletion after a webhook create is verified absent](49-complete-deletion-after-verified-absent-create.md)
- [Prevent a concurrent receiving save from restoring a stale key](09-prevent-stale-receiving-key-rollback.md)
- [Return authentication errors for invalid Desktop receiving credentials](12-return-desktop-receiving-auth-errors.md)
- [Keep receiving health evidence truthful after failed checks](10-persist-and-present-receiving-health.md)
- [Reject incomplete Resend domain lists as health evidence](16-reject-incomplete-resend-domain-lists.md)
- [Prevent an older One receiving check from repainting newer health](17-prevent-stale-one-receiving-refreshes.md)
- [Prevent an older stored-key check from overwriting newer durable health](20-order-stored-receiving-health-checks.md)
- [Bind hydrated Resend domain details to the requested identity](22-bind-hydrated-resend-domain-identities.md)
- [Reject malformed successful receiving responses in One](23-validate-one-receiving-responses.md)
- [Reject superseded stored-key receiving saves](25-reject-superseded-receiving-saves.md)
- [Commit One receiving presentation atomically](26-commit-one-receiving-presentation-atomically.md)
- [Reject every superseded stored-key receiving save outcome](27-reject-superseded-receiving-save-outcomes.md)
- [Keep removed-domain failures separate from credential health](18-separate-domain-and-credential-health.md)
- [Scope malformed JSON classification to the explicit parse operation](24-scope-json-syntax-classification.md)
- [Trust freshly restored Organization authority](30-trust-fresh-restored-organization-authority.md)
- [Clear revoked Desktop receiving status](28-clear-revoked-desktop-receiving-status.md)
- [Show redacted receiving status to non-Admin Organization members](14-show-redacted-receiving-status-to-members.md)
- [Reject webhook list and retrieve status contradictions](31-reject-webhook-status-contradictions.md)
- [Prove durable paginated webhook recovery](29-prove-durable-paginated-webhook-recovery.md)
- [Recover an ambiguous Resend webhook create without creating another webhook](15-recover-ambiguous-resend-webhook-creates.md)
- [Make Resend webhook staging recoverable after every provider step](11-stage-resend-webhooks-recoverably.md)
- [Execute the configured receiving route exports](32-execute-configured-receiving-route-exports.md)
- [Execute malformed JSON contracts through every receiving route](21-execute-malformed-json-route-contracts.md)
- [Classify malformed receiving JSON as an invalid request](19-classify-malformed-receiving-json.md)
- [Distinguish provider outages from invalid receiving configuration](13-classify-receiving-provider-failures.md)
- [Configure Organization Resend receiving in One and Desktop](01-prepare-organization-resend-receiving.md)
- [Let Project editors manage private Email Triggers](02-manage-private-project-email-triggers.md)
- [Create private Triggers before inbound activation](33-create-private-triggers-before-inbound-activation.md)
- [Disable Triggers on Organization owner loss](34-disable-triggers-on-organization-owner-loss.md)
- [Preserve Trigger lifecycle disable reasons](35-preserve-trigger-lifecycle-disable-reasons.md)
- [Preserve unavailable Trigger models while editing](36-preserve-unavailable-trigger-models-in-editing.md)
- [Execute the Email Trigger route exports](37-execute-email-trigger-route-exports.md)
- [Reconcile stale Trigger owners during migration](38-reconcile-stale-trigger-owners-during-migration.md)
- [Keep route-export sessions live](39-keep-route-export-sessions-live.md)
- [Close the owner-loss migration cutover race](40-close-owner-loss-migration-cutover-race.md)
