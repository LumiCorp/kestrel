# Revalidate current policy before pending Browser allow

## Failed behavior

Commit `cfc59f05a` handles a pending Browser approval before the current generic mode and tool-class gate. If Browser policy changes from `approval_required` to `allow`, the call can resume even when current interaction mode or external-effect policy now blocks it.

## Affected flow

`agents/reference-react/src/steps/acter/policyGates.ts` owns current availability and pending approval transitions for Desktop/hosted single and batch paths.

## Repair requirements

- Re-evaluate current non-approval availability before a pending Browser call can transition to allowed execution.
- Exempt only the now-obsolete `external.confirm` requirement when trusted Browser policy is `allow`; do not exempt mode, execution-class, capability, descriptor, input, run, or revision restrictions.
- A current deny or unavailable state must block/release the pending call deterministically without execution.
- Preserve the exact prepared-call and hosted V2 integrity checks.

## Done when

- Pending `approval_required -> allow` resumes only when current generic policy still permits the exact call.
- Narrowed interaction mode or external-side-effect authority blocks Desktop/hosted single/batch resume even when Browser policy is now allow.
- Focused policy gate, Acter transition, approval cleanup, and replay suites pass.

## Depends on

None.
