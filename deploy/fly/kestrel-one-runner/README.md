# Legacy Kestrel One runner image

This directory retains the old combined runner image only for historical local
compatibility. Production does not publish or deploy it. Workspace Runtime and
Environment Router are separate catalog roles and use the manual commands in
[the runtime rollout](./ROLLOUT.md). That rollout requires a same-tag image
pair, one durable canary Environment update, Workspace and public preview proof,
explicit activation for new Environments, and per-Environment rollback.
