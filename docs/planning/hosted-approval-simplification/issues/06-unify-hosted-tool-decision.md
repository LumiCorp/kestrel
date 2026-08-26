# Make hosted tool availability and approval one truthful decision

## Useful outcome

A hosted user can ask Kestrel to run `exec_command` and receive behavior that
matches Environment and Project policy. Ask First keeps the tool available and
shows the approval card after selection. Blocked makes the tool unavailable
everywhere. Kestrel no longer hides a tool from the model and then rejects the
model for reporting that absence.

This slice repairs the defining hosted-shell scenario before model spend and
through execution. It also makes the completed Remember Approval behavior
reachable under the default hosted profile.

## What changes

Add the dedicated `hosted_workspace` policy pack and bind new
`workspace_hosted` profile resolutions to it. The pack must allow
`read_only`, `sandboxed_only`, and `external_side_effect` classes. It must
allow the hosted surface's existing `workspace.read`, `workspace.write`,
`shell.exec`, `mission_control.work_item.write`, `network.call`,
`code.execute`, `mcp.invoke`, and `external.confirm` approval capabilities. It
must leave runtime-strict approval off. App, MCP, and command policy still
controls actual visibility below this ceiling. Keep `ci_bot` unchanged.

Replace pack-name satisfiability assumptions with descriptor-level checks
against the compiled policy. Every external-side-effect descriptor must name
at least one approval capability. A profile that claims a required hosted tool
while denying its class or capability must fail before a model request.

Use one shared effective tool resolver for profile qualification, model tool
projection, unavailable-tool validation, Acter execution checks, approval
presentation, remembered-approval eligibility, Web, Mobile, canaries, and
diagnostics. The result must carry availability, approval mode, reason,
Remember eligibility, and authority revision. Preserve the evidence used to
explain the result without creating another mutable policy store.

Keep Ask First tools model-visible. Remove tools blocked by mode, class, or
capability from both the model surface and the effective available-tool set
used by validation. When policy hides the requested tool and the model has no
control that can change that policy, accept a truthful
`requested_tool_unavailable` result as terminal. Do not prescribe an impossible
policy action or make another paid model call for the same contradiction.

Carry the resolver's authoritative Remember eligibility to Web and Mobile.
Environment or Project Ask First must offer Decline, Approve Once, and Remember
Approval. Subject Ask, tool-minimum Ask, explicit runtime strictness, disabled
capability, lost actor access, Blocked, and unavailable tools must not offer
Remember Approval.

Treat model presentation as a revisioned snapshot. Before execution, run the
same resolver against current authority. If policy became stricter after model
presentation or approval, fail closed or require fresh approval. Do not honor
stale presentation authority.

Make exact-tool canaries preflight the effective decision before provider or
model spend. The preflight must prove that the requested tool is visible under
the real hosted profile and policy.

## Requirements and delivery context

The canonical requirements are in the [Hosted Approval Simplification Product Brief](../../hosted-approval-simplification-product-brief.md).

The current composition seams are `src/profile/runtimeProfile.ts`,
`src/profile/kestrelOnePolicy.ts`, `cli/runtime/approvalPolicyPacks.ts`,
`src/mode/contracts.ts`, and the tool descriptors under `tools/`. The model and
execution seams are `agents/reference-react/src/steps/deliberator.ts`,
`agents/reference-react/src/policy/DecisionPolicy.ts`, and
`agents/reference-react/src/steps/acter/policyGates.ts`.

The completed remembered-approval path already resolves evidence in
`tools/runtime/UnifiedToolRegistry.ts`. Web and Mobile currently project
eligibility through `apps/web/lib/apps/runtime-approval-policy.ts`,
`apps/web/components/chatbot/interaction-panel.tsx`, and the Mobile interaction
DTO and routes. Reuse that authority and remove duplicate reason-string
decisions instead of adding a client exception.

Preserve Environment and Project Automatic, Ask First, and Blocked. Preserve
explicit runtime strictness as a valid stricter ceiling. Do not broaden the
developer pack, weaken `ci_bot`, reclassify shell execution, let remembered
evidence override strictness, or add heuristic tool matching, retry ranking,
or a second policy engine.

Existing resolved hosted profiles retain their recorded pack and contract
revision until they finish, drain, or expire. Do not rewrite pending approval
authority in place.

## Done when

- The default `workspace_hosted` profile uses `hosted_workspace`; the inherited
  Workspace App capability exposes `exec_command` under Environment or Project
  Ask First and removes it under Blocked. `ci_bot` behavior remains unchanged.
- Descriptor-level qualification rejects a required hosted tool denied by its
  compiled class or capability policy before any model request.
- Catalog validation rejects an external-side-effect descriptor with no
  approval capability.
- Model projection, unavailable-tool validation, execution, approval
  presentation, Web, Mobile, canaries, and diagnostics produce the same
  effective result from the same revisioned inputs.
- Environment and Project Ask First both show Decline, Approve Once, and
  Remember Approval. Every stricter or blocked case follows the Product Brief
  and does not offer Remember Approval.
- A policy-hidden requested tool with no available correction control ends in
  one truthful terminal result without another model call.
- A policy revision that becomes stricter after presentation or approval fails
  closed or requires fresh approval before execution.
- The exact-command canary fails during no-spend preflight when the requested
  tool is not effectively visible and reaches the approval card when it is.
- Focused profile, descriptor, deliberator, decision-policy, Acter, Web,
  Mobile, and canary tests pass.
- `pnpm validate` and `pnpm validate:process` pass.
