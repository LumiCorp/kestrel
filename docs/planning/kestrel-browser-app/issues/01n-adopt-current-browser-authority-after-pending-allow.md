# Adopt current Browser authority after pending allow

## Failed behavior

Commit `29b04c102` rechecks generic availability before a pending Browser approval transitions to `allow`, but returns the persisted prepared call before comparing current policy and approval-authority revisions. The call can therefore execute under the superseded `approval_required` revision after the destination becomes allowed.

## Affected flow

`agents/reference-react/src/steps/acter/policyGates.ts` receives both the persisted approval-bound call and the current trusted prepared Browser call. It owns the pending transition and exact revision/input comparison.

## Repair requirements

- A pending `approval_required -> allow` transition must execute only a call prepared under current trusted Browser/runtime authority.
- Require the current prepared call to match the pending call's exact tool, canonical input, session, run, and operation identity before adopting it.
- Use the current combined policy and approval-authority revisions; never execute the stale approval-bound revision.
- If current preparation is absent or identity/input drifted, block and release the pending approval without execution.
- Preserve the no-second-approval behavior for an unchanged call whose domain became effective.

## Done when

- Revision-only transition to allow executes the current prepared call, not the persisted stale call.
- Input, tool, run/session, descriptor, or operation drift blocks Desktop/hosted single/batch resume.
- An unchanged newly allowed request resumes without another approval.
- Focused Acter, prepared-call integrity, policy transition, and replay suites pass.

## Depends on

None.
