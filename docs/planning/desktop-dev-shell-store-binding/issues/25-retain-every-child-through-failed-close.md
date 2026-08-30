# Retain every child through failed supervisor close

## Failed behavior

Supervisor close clears all active-process ownership before stopping children, then awaits each child sequentially. If an early child's terminal settlement rejects, later children are never signaled, remain live and unaddressable, and a repeated close falsely succeeds because the registry is already empty.

## Repair requirements

- Keep each process registered until its own terminal handler settles successfully.
- Start shutdown cleanup for every captured child even when another child's settlement fails.
- Reject close only after every captured child has been given the full SIGTERM/SIGKILL and settlement sequence.
- Preserve failure evidence for more than one rejected settlement.

## Done when

- With two live children and a terminal-write failure for the first, close terminates both exact child PIDs before rejecting.
- The failed child remains owned by the supervisor and a repeated close continues to reject rather than reporting false success.
- Successful child settlement still removes that child from active ownership.

## Depends on

None.
