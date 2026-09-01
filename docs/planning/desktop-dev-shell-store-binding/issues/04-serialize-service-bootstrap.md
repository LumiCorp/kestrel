# Serialize developer-shell service bootstrap

## Failed behavior

Concurrent first requests against the same developer-shell base directory can both observe no health endpoint and spawn separate detached services. Each child initializes the same control store and unconditionally removes the same socket before binding. The competing PGlite recovery paths can quarantine or rename a newly created store, both commands can fail with `store_init_failed`, and a later child can unlink an earlier child's live endpoint.

## Affected flow

This blocks [Bind the developer shell to Local Core storage authority](01-bind-developer-shell-storage-authority.md) and [Make incompatible developer-shell replacement exclusive](03-make-incompatible-service-replacement-exclusive.md), implemented through `fa4d681ce..337b5897a`.

The trigger is two `LocalDevShellService` instances or processes entering `ensureService` for the same socket at the same time. There is no shared startup authority, a `booting` sidecar is not sufficient exclusion, and the service process removes the socket without proving it is stale.

## Repair requirements

- Serialize cold bootstrap and incompatible replacement for one developer-shell base directory across service instances and processes.
- Hold that authority until a compatible health endpoint is established or bootstrap fails, then release it safely.
- A waiter must re-read health and reuse the compatible service after acquiring authority rather than spawning another daemon.
- Do not let a service child blindly unlink a socket that may belong to a concurrent or already-ready daemon.
- Recover abandoned bootstrap authority only from explicit stale-owner evidence; do not add timing guesses or heuristic ownership.
- Preserve the safe missing/corrupt identity behavior and command non-execution guarantees.

## Done when

- Two simultaneous cold requests using the same binding launch one service and both commands complete.
- Competing instances with different bindings cannot concurrently initialize stores or overwrite each other's endpoint.
- A failed bootstrap releases its authority so a later request can retry safely.
- Focused regression tests cover simultaneous same-binding cold start and competing-binding launch behavior.
- Issues 01 through 03 remain satisfied.

## Depends on

None.
