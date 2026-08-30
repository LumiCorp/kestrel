# Align the supervisor environment regression with private control stripping

## Failed behavior

The supervisor implementation and real smoke test correctly strip all `KESTREL_DEV_SHELL_*` service-control variables from workspace commands, but an older unit assertion still requires the private socket path to be exposed.

## Repair requirements

- Make the unit regression assert the current private-control contract.
- Preserve access to the in-shell client package and ordinary application environment such as `COREPACK_HOME`.
- Continue proving unrelated private service variables do not leak.

## Done when

- The command sees the in-shell client and ordinary application environment.
- The command sees neither the service socket path nor the test-only private variable.
- The focused supervisor suite passes against the implemented issue-14 contract.

## Depends on

None.
