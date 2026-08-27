# Email-Triggered Agent Runs Implementation Queue

Each issue appears in one state. `Ready` is the current dependency-free frontier. Move issues between states as implementation and review change the graph.

## Ready

None.

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

## Done

None.
