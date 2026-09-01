# Order the V4 compatibility rollout

## Failed behavior

The V4 runbook deploys new Web first and requires a fresh hosted V2 interaction
while production runtime images still advertise hosted preset 2 or 3. New Web
requires preset 4 for every ordinary hosted resolution, so Stage 1 rejects the
old images before the checkpoint and cannot reach its own resume evidence.

## Affected work

[Version trusted hosted approval timing](06a-version-trusted-hosted-approval-timing.md),
commit `c357e3142`, especially
`docs/operations/hosted-approval-v3-rollout-runbook.md` and the preset-4 Web
compatibility assertion.

## Repair requirements

Make the operator sequence executable without a hosted outage. Qualify and
roll V2-producing, preset-4 compatibility runtime/worker images before the Web
reader/preset assertion becomes active, and prove old Web fails safely or
accepts that compatibility pair as intended. Then deploy V2/V3/V4 readers and
run the inactive V2 checkpoint before V4 activation. Preserve exact-target,
one-Machine-at-a-time, rollback, and no-spend canary constraints.

## Done when

- Every stage's stated preconditions are established by an earlier step.
- No stage requires new Web to accept preset-2/3 runtime images.
- Compatibility images remain V2 producers while advertising preset 4.
- Rollback directions and evidence requirements are explicit and internally
  consistent.

## Depends on

None.
