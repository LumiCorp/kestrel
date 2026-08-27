# Version trusted hosted approval timing

## Failed behavior

Trusted approval timing was added as optional metadata to the existing V3
interaction. That leaves two incompatible meanings under one version: an old
Web service accepts a new runner's V3 card but ignores expiry before persisting
Remember Approval, while a new runner reprojects an old metadata-less V3 card
with timing and rejects its persisted state after restart.

## Affected work

[Make hosted tool availability and approval one truthful decision](06-unify-hosted-tool-decision.md),
commit `04d6a729d`, especially `packages/protocol/src/execution.ts`,
`src/runtime/assistantResponseContract.ts`, `src/runtime/state.ts`, and the
hosted Web and Mobile interaction parsers.

## Repair requirements

Introduce an incompatibly negotiated hosted approval interaction version for
new Remember-capable cards. Trusted `requestedAt` and `expiresAt` evidence must
be required in that version. Preserve V3 exactly as its original metadata-less
contract so an existing V3 Approve Once can validate and resume after runner
upgrade or restart. New Web must reject or omit Remember for legacy V3, and an
old Web must fail closed on the new interaction instead of accepting it as V3.
Do not rewrite pending interactions in place.

## Done when

- An old Web parser rejects a new timing-required interaction before it can
  persist Remember Approval.
- New Web rejects an old runner/profile before model spend and handles an
  already-persisted V3 approval without changing its canonical projection.
- Metadata-less V3 Approve Once survives runner restart and resumes.
- Metadata-less V3 cannot create remembered authority through new Web or
  Mobile.
- New timing-required interactions reject missing, malformed, or non-forward
  expiry evidence.

## Depends on

None.
