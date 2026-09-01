# Make Environment default admission current and atomic

## Failed behavior

The Environment inference selector can show a stale or unreachable hosted model as eligible because its read projection omits credential revision and reachability. The write boundary then rejects that same selection.

The write boundary also validates a gateway/model snapshot before a separate default upsert. A credential rotation between those operations can persist a default whose qualification is no longer current.

## Affected work

[Close hosted readiness admission and truth gaps](14-close-hosted-readiness-admission-and-truth-gaps.md) was implemented in `ae7e879f3`. The affected path is `apps/web/lib/ai/environment-inference.ts`, its selector consumer, and Environment inference tests.

## Repair requirements

The selector and default-setting mutation must use the same current `agent.loop` readiness predicate, including gateway reachability and credential revision. The mutation must bind validation and persistence to one current gateway revision so a concurrent credential change cannot persist stale intent.

Reject the requested model when it is not current. Preserve historic registrations and defaults; do not substitute a model, infer capabilities, or add provider fallback.

## Done when

- The selector excludes stale and unreachable hosted models.
- A credential change interleaved with default selection prevents the old qualification from being persisted.
- Focused selector, mutation, and concurrent-rotation regressions pass.
- Issue 14's Environment-default readiness outcome is restored.

## Depends on

- [Close hosted readiness admission and truth gaps](14-close-hosted-readiness-admission-and-truth-gaps.md) (implemented, review pending)
