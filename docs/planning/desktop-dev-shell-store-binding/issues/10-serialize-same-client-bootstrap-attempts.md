# Serialize same-client bootstrap attempts

## Failed behavior

Two simultaneous cold commands issued through one `LocalDevShellService` reuse one client authority token. Authority publication derives its staging-directory name from that PID and token, so both attempts remove and create the same staging path. One attempt can escape with a raw `EEXIST` instead of waiting for the first bootstrap and reusing the resulting service.

## Affected flow

This blocks [Make bootstrap authority crash-safe and child-owned](07-make-bootstrap-authority-crash-safe.md). The existing cross-instance concurrency proof uses distinct tokens and does not cover simultaneous calls on one service instance.

## Repair requirements

- Give every bootstrap acquisition attempt an unambiguous identity.
- Make unpublished staging paths unique even if a caller supplies the same valid owner evidence concurrently.
- Preserve atomic publication, exact dead-owner recovery, and bounded waiting.
- Do not add timing or retry heuristics.

## Done when

- Two same-path acquisitions with identical supplied owner evidence cannot collide in their private staging state or leak `EEXIST`.
- Two simultaneous cold commands on one `LocalDevShellService` both complete while only one service is spawned.
- Existing cross-instance, crash-recovery, handoff, and malformed-evidence tests remain green.

## Depends on

None.
