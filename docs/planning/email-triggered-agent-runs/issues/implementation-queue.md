# Email-Triggered Agent Runs Implementation Queue

Each issue appears in one state. `Ready` is the current dependency-free frontier. Move issues between states as implementation and review change the graph.

## Ready

- [Keep removed-domain failures separate from credential health](18-separate-domain-and-credential-health.md)
- [Execute malformed JSON contracts through every receiving route](21-execute-malformed-json-route-contracts.md)
- [Scope malformed JSON classification to the explicit parse operation](24-scope-json-syntax-classification.md)
- [Clear revoked Desktop receiving status](28-clear-revoked-desktop-receiving-status.md)
- [Prove durable paginated webhook recovery](29-prove-durable-paginated-webhook-recovery.md)

## In progress

None.

## Blocked

- [Let Project editors manage private Email Triggers](02-manage-private-project-email-triggers.md) — blocked by [Configure Organization Resend receiving in One and Desktop](01-prepare-organization-resend-receiving.md)
- [Accept signed Resend deliveries durably](03-accept-signed-resend-deliveries.md) — blocked by [Configure Organization Resend receiving in One and Desktop](01-prepare-organization-resend-receiving.md)
- [Hydrate and admit one received email](04-hydrate-and-admit-received-email.md) — blocked by [Let Project editors manage private Email Triggers](02-manage-private-project-email-triggers.md) and [Accept signed Resend deliveries durably](03-accept-signed-resend-deliveries.md)
- [Materialize an admitted email as a durable Project run](05-materialize-email-triggered-project-run.md) — blocked by [Hydrate and admit one received email](04-hydrate-and-admit-received-email.md)
- [Let the triggered agent read an email attachment](06-read-email-attachments-on-demand.md) — blocked by [Materialize an admitted email as a durable Project run](05-materialize-email-triggered-project-run.md)
- [Retain and inspect email-triggered work safely](07-retain-and-inspect-email-triggered-work.md) — blocked by [Materialize an admitted email as a durable Project run](05-materialize-email-triggered-project-run.md)
- [Safely enable and prove email-triggered work](08-enable-and-prove-email-triggered-work.md) — blocked by [Let the triggered agent read an email attachment](06-read-email-attachments-on-demand.md) and [Retain and inspect email-triggered work safely](07-retain-and-inspect-email-triggered-work.md)

## Implemented

- [Configure Organization Resend receiving in One and Desktop](01-prepare-organization-resend-receiving.md)
- [Keep receiving health evidence truthful after failed checks](10-persist-and-present-receiving-health.md)
- [Make Resend webhook staging recoverable after every provider step](11-stage-resend-webhooks-recoverably.md)
- [Distinguish provider outages from invalid receiving configuration](13-classify-receiving-provider-failures.md)
- [Classify malformed receiving JSON as an invalid request](19-classify-malformed-receiving-json.md)
- [Show redacted receiving status to non-Admin Organization members](14-show-redacted-receiving-status-to-members.md)
- [Recover an ambiguous Resend webhook create without creating another webhook](15-recover-ambiguous-resend-webhook-creates.md)

## Done

- [Prevent a concurrent receiving save from restoring a stale key](09-prevent-stale-receiving-key-rollback.md)
- [Return authentication errors for invalid Desktop receiving credentials](12-return-desktop-receiving-auth-errors.md)
- [Reject incomplete Resend domain lists as health evidence](16-reject-incomplete-resend-domain-lists.md)
- [Prevent an older One receiving check from repainting newer health](17-prevent-stale-one-receiving-refreshes.md)
- [Prevent an older stored-key check from overwriting newer durable health](20-order-stored-receiving-health-checks.md)
- [Bind hydrated Resend domain details to the requested identity](22-bind-hydrated-resend-domain-identities.md)
- [Reject malformed successful receiving responses in One](23-validate-one-receiving-responses.md)
- [Reject superseded stored-key receiving saves](25-reject-superseded-receiving-saves.md)
- [Commit One receiving presentation atomically](26-commit-one-receiving-presentation-atomically.md)
- [Reject every superseded stored-key receiving save outcome](27-reject-superseded-receiving-save-outcomes.md)
