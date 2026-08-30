# Make bootstrap authority crash-safe and child-owned

## Failed behavior

The bootstrap authority is published as an empty directory followed by an owner symlink and removed through a cleanup marker followed by rename. A crash between either pair of operations leaves state that later callers cannot recover. The authority also remains owned only by the client PID after it spawns a detached service. If that client dies before the child publishes status, another caller can reclaim the apparently dead authority while the first child is alive and reopen concurrent store initialization.

## Affected flow

This blocks [Serialize developer-shell service bootstrap](04-serialize-service-bootstrap.md), implemented by `337b5897a..e78809c24`.

The trigger is process death at authority publication, cleanup, or detached-child handoff. The existing normal concurrency proofs do not inject failure at those state transitions.

## Repair requirements

- Publish complete authority evidence atomically; no observable authority state may omit its owner identity.
- Make cleanup restartable after process death without deleting a replacement authority.
- Transfer authority to the detached service PID before that child can initialize the store, or provide an equivalent handshake that proves a dead client cannot leave a live untracked bootstrap child.
- Hold authority until the service reaches ready or failed state, then release it without a crash-created permanent wedge.
- Recover only from exact, explicit dead-owner evidence. Do not use age thresholds or timing heuristics as ownership proof.
- Preserve bounded safe refusal for malformed or ambiguous authority state.

## Done when

- Fault injection at publication and cleanup boundaries leaves a state a later process can recover safely.
- Killing the client immediately after spawn cannot allow a second child to initialize while the first child remains alive.
- Normal same-process, cross-process, failed-bootstrap, and competing-binding cases remain serialized.
- Recovery cannot remove a newly published replacement authority.

## Depends on

None.
