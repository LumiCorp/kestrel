# Do not re-signal dead retained children

## Failed behavior

A child with failed terminal persistence remains registered so repeated close cannot report false success. A later close nevertheless signals its stored numeric process group before checking whether the original ChildProcess is still running. If the PID has been reused, that signal can target an unrelated process group.

## Repair requirements

- Check the exact ChildProcess liveness before sending either shutdown signal.
- Keep dead failed-settlement entries registered so their owned rejection remains visible.
- Do not weaken the full SIGTERM/SIGKILL sequence for children that are still live.

## Done when

- A failed-settlement child is dead and remains owned after the first rejected close.
- A repeated close rejects from the same settlement evidence without attempting any numeric process signal.
- Live multi-child cleanup continues to terminate every captured child.

## Depends on

None.
