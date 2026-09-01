# Bridge the deployed preset-2 baseline

## Failed behavior

The compatibility runbook starts by requiring a uniform preset-3 fleet, but
the reviewed baseline commit `1760c3769` defines `workspace_hosted` preset 2.
Preset 3 exists only in an undeployed intermediate repair commit. Deploying the
current bridge Web against the real preset-2 baseline would reject hosted
profile resolution before the compatibility image rollout can begin.

## Affected work

[Construct the V4 compatibility release](06f-construct-v4-compatibility-release.md),
commit `6c2129467`, especially the Web profile allowlist, profile-resolution
tests, and `docs/operations/hosted-approval-v3-rollout-runbook.md`.

## Repair requirements

Create and document an executable transition from the exact unmarked preset-2
`workspace_hosted`/`hosted_workspace` baseline to the marked preset-4/V2
compatibility fleet. Preserve fail-closed behavior for `ci_bot`, unrelated
policy packs, ambiguous marked profiles, and unsupported protocol versions.
Do not assume preset 3 was deployed. The legacy bridge allowance must be
explicitly temporary and removable only after inventory proves drain.

## Done when

- Bridge Web accepts the exact unmarked preset-2 baseline and rejects preset 2
  with contradictory producer metadata or policy identity.
- The tested path is baseline preset 2 -> bridge Web -> preset-4/V2 fleet ->
  preset-4/V4 activation, with safe rollback targets at each boundary.
- The runbook inventories the actual baseline and never requires an undeployed
  preset-3 precondition.
- Focused profile and rollout contract tests prove the transition and fail-
  closed cases.

## Depends on

[Construct the V4 compatibility release](06f-construct-v4-compatibility-release.md).
