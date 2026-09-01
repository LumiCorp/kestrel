# Bind Browser policy through every approval path

## Failed behavior

Repair commit `2e0ee9771` resolves trusted Browser policy for single calls, but an already-effective grant can still be rejected when the static `external.confirm` capability is disabled. Desktop local approval evidence does not bind the Browser policy revision, so an approval created under revision A can authorize a newly prepared call under revision B. Tool batches bypass input-dependent inspection entirely, producing static approval and execution-class decisions for `browser.request_grant` and `browser.tabs`.

## Affected flow

This defect blocks [Resolve Browser policy before approval](01a-resolve-browser-policy-before-approval.md) in repair commit `2e0ee9771`.

`agents/reference-react/src/steps/acter.ts` and `policyGates.ts` own single and batch policy evaluation and Desktop/hosted approval waits. `UnifiedToolRegistry.inspectToolCall` and preparation own trusted Browser policy and input-dependent execution class. The durable approval binding must carry the same decision, class, descriptor, input, run authority, and combined Browser/runtime policy revision into resume.

The repair boundary includes effective capability calculation after trusted policy resolution, Desktop approval evidence, batch inspection, prepared-call reuse, and Desktop/hosted tests.

## Repair requirements

- A trusted Browser `allow` decision for an already-effective grant must proceed automatically even when no new `external.confirm` authority is available; it must not create an approval interaction.
- A trusted `deny` decision must block without approval. Only `approval_required` may require `external.confirm` and create a wait.
- Bind Desktop and hosted approval evidence to the combined runtime and Browser policy revision used to prepare the exact call. A revision change must invalidate the old approval instead of authorizing a newly prepared call.
- Apply trusted policy inspection and input-dependent execution-class resolution to every reachable invocation form, including tool batches, before committing an approval decision.
- An approved batch item must resume the exact inspected/prepared call; allow and deny items must not inherit approval authority from another item.
- Preserve non-Browser batch behavior and do not infer policy from URL paths, keywords, or page content.

## Done when

- Desktop and hosted Acter tests prove all three grant decisions with `external.confirm` enabled and disabled where applicable.
- A Desktop approval under policy revision A cannot execute a call prepared under revision B.
- Single and batch calls produce identical policy decisions and execution classes for grant and tab list/switch/close operations.
- Hosted Ask First can batch a tab list without a class mismatch; a new eligible grant asks exactly once; already-effective and forbidden grants do not ask.
- Focused Acter, approval, batch, prepared-call, and replay suites pass.

## Depends on

None.
