# Complete current allow authority adoption

## Failed behavior

Commit `cee504e38` adopts a current Browser allow call after comparing policy revision and operation identity, but the current prepared call does not carry durable approval-authority or hosted actor/Environment identity for that comparison. If releasing the stale prepared call fails, the newly prepared call is also left retained and the cleanup failure is mislabeled as approval corruption.

## Affected flow

`RuntimeIO.prepareToolForApproval`, the tool gateway/registry preparation contract, and `policyGates.ts` own the current allow preparation and adoption transaction. Existing prepared authority fields and release surfaces must carry the proof and cleanup; no new authority channel is needed.

## Repair requirements

- Preserve current approval-authority revision on a Browser call prepared through the approval path even when Browser policy resolves to `allow`.
- For hosted preparation, preserve and compare the current actor, organization, Environment, Project, Thread, descriptor, execution class, and approval-authority identity.
- Require the adopted allow call to match the expected current authority supplied to preparation, not merely the stale pending call.
- If stale-call release fails, attempt to release the newly prepared call and preserve a bounded cleanup failure classification; never report ordinary cleanup failure as malformed approval evidence.
- Never dispatch until stale authority release succeeds.

## Done when

- Desktop and hosted authority-revision drift cannot pass current-call adoption; hosted actor/Environment drift is rejected.
- A correctly bound current allow call resumes without another approval.
- Stale release failure dispatches nothing, releases the new preparation when possible, preserves the cleanup cause, and does not accumulate retained calls across retry.
- Focused Acter, registry preparation, authority parsing, cleanup, and replay suites pass.

## Depends on

None.
