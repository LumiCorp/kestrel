# Generalize prepared approval cleanup

## Failed behavior

The first cleanup repair covers V4 Remember expiry and selected current-policy
rejections, but other Web-owned rejection paths still terminalize without
contacting the waiting runtime. Expired or unavailable provider Approve Once,
Remember binding/not-pending failures, resource loss, and opportunistic
provider expiry can leave the exact prepared execution source retained.

## Affected work

[Release a Web-rejected prepared approval](06b-release-web-rejected-prepared-approval.md),
commit `219f41cb2`, especially `apps/web/lib/turns/store.ts`,
`apps/web/lib/apps/app-operation-approvals.ts`, durable turn claiming, and the
runner's existing decline/release transition.

## Repair requirements

Every non-executable Web rejection of a prepared V2/V3/V4 approval must either
release the exact prepared invocation or enqueue one cleanup-only continuation.
The cleanup continuation must preserve the submitted human decision as audit
evidence while sending no executable approval authority to the runner. It must
drive the existing decline/release effect exactly once, redact provider payload
when applicable, and terminalize truthfully after cleanup. Opportunistic expiry
must use the same canonical path with queue/thread lock order preserved. Do not
add a second prepared-resource owner or replay the rejected decision.

## Done when

- Expired, unavailable, policy-rejected, and binding-rejected Approve Once and
  Remember paths execute no tool and release the exact prepared call once.
- Background provider expiry cannot strand a pending or processing runtime
  interaction.
- Provider payload is redacted atomically and the eventual interaction/turn
  failure remains truthful.
- Duplicate submissions, cleanup retries, and concurrent expiry preserve one
  cleanup continuation, one release effect, and canonical lock order.
- Focused PostgreSQL plus runtime/registry tests cover the full bridge.

## Depends on

[Release a Web-rejected prepared approval](06b-release-web-rejected-prepared-approval.md).
