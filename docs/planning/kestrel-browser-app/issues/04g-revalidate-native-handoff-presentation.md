# Revalidate native handoff presentation

## Failed behavior

Native window presentation can outlast the lease minted before its asynchronous engine and CDP work, allowing an already-expired handoff to be returned briefly. Revocation also minimizes only the originally stored window ID; if the exact target moves to another Chrome window, the authoritative authentication surface can remain visible.

## Affected flow

`DesktopBrowserService` owns lease commitment and the private adapter owns exact target/window presentation. Presentation and revocation must be one fail-closed transaction bound to the current target and unexpired lease.

## Repair requirements

- Recheck exact Session, generation, connection, target, and lease expiry after presentation and before committing or returning the handoff.
- If presentation completes after expiry or identity drift, immediately revoke the presented receipt; if revocation cannot be proven, terminate the owned engine.
- On revocation, re-resolve the exact target's current window and minimize and verify every distinct stored/current window that may expose it.
- Reject missing, moved, closed, or replaced targets unless revocation or engine termination proves no native authority remains.
- Keep hosted invocation headless and keep CDP/window identities below the renderer boundary.

## Done when

- A delayed presentation beyond lease expiry never returns active native authority and leaves no visible window.
- A target moved from the stored window to a new window causes both windows to be minimized and verified.
- Target lookup, focus, minimization, and verification failures fail closed through exact engine termination.
- Focused lifecycle, injected-clock, CDP window-drift, packaged-composition, and secret-sentinel tests pass.

## Depends on

None.
