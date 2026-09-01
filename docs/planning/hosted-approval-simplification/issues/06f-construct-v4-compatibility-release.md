# Construct the V4 compatibility release

## Failed behavior

The V4 rollout runbook names preset-4/V2 compatibility images, but no source
boundary in the reviewed range can build them. The commit that introduces
preset 4 also hardcodes V4 in both producer Dockerfiles, while the publisher's
protocol option changes only smoke expectations. Old Web also requires preset
3 exactly, so it rejects the hypothetical compatibility image.

## Affected work

[Order the V4 compatibility rollout](06d-order-v4-compatibility-rollout.md),
commit `e520aaaa8`, especially the hosted runtime/worker Dockerfiles, production
image publisher, Web hosted-profile compatibility assertion, build evidence,
and `docs/operations/hosted-approval-v3-rollout-runbook.md`.

## Repair requirements

Create an explicit, source-controlled transition that operators can actually
build and qualify: old Web must safely coexist with the compatibility fleet,
the compatibility images must advertise preset 4 while producing V2, and V4
activation must remain a later identifiable boundary. Do not rely on a smoke
expectation masquerading as a build override or on mutable tags. Preserve exact
image identity, one-Machine-at-a-time rollout, rollback compatibility, and the
no-spend qualification contract.

## Done when

- Repository code and tests construct and distinguish preset-4/V2 compatibility
  images from preset-4/V4 activation images.
- The Web bridge accepts only the explicitly supported compatibility profiles;
  unrelated or stale profiles still fail closed.
- The publisher records and verifies the selected producer protocol as build
  evidence, not only as a post-build expectation.
- The runbook names executable commits/artifacts and every stage has an earlier
  step establishing its preconditions and rollback target.
- Focused build/publisher/profile compatibility tests prove the transition.

## Depends on

[Order the V4 compatibility rollout](06d-order-v4-compatibility-rollout.md).
