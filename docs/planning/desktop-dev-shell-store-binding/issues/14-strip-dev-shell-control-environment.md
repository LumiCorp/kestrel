# Strip developer-shell control environment from commands

## Failed behavior

The daemon receives bootstrap authority path, token, owner, socket, log, and status variables. In inherited command mode those private service-control values currently reach workspace commands.

## Repair requirements

- Remove each explicit `KESTREL_DEV_SHELL_*` control and binding variable at the shared child-environment boundary.
- Preserve allowed application `DATABASE_URL` behavior.
- Do not replace the explicit list with prefix matching.

## Done when

- Inherited workspace commands cannot observe authority, owner, socket, log, status, or store-binding variables.
- An allowed application `DATABASE_URL` remains visible.

## Depends on

None.
