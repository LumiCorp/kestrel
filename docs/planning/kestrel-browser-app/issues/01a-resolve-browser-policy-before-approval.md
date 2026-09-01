# Resolve Browser policy before approval

## Failed behavior

`browser.request_grant` cannot produce its required three outcomes through the current runtime path. Desktop asks before it knows whether the domain is already effective or forbidden. Hosted policy can be configured to ask for every request or no request, but it cannot ask only for a new eligible personal grant.

`browser.tabs` has the same ordering defect. The static descriptor classifies every operation as an external side effect. Preparation later classifies `list` as read-only. If hosted App policy is Ask First, the approval gate compares those two classes and rejects the prepared call instead of listing tabs.

## Affected flow

This defect blocks [Register the Browser App and stable tool contract](01-register-the-browser-app-and-tool-contract.md) in integration commit `114c49840`.

For a grant request, the model input enters the static Browser descriptor and Desktop or hosted App policy. `agents/reference-react/src/steps/acter/policyGates.ts` decides whether to wait for approval before `BrowserServicePort` can resolve current domain authority. `tools/runtime/UnifiedToolRegistry.ts` and `tools/browser/modules.ts` prepare only the later invocation. The observable result is either an unnecessary approval for an already-effective or forbidden domain, or no approval for a new eligible grant.

For tab listing, the approval gate observes the descriptor's external-effect class. `UnifiedToolRegistry` later records the input-dependent read-only class. The mismatch produces `HOSTED_PREPARED_APPROVAL_INVALID` before execution.

The complete repair boundary includes Browser policy inspection and preparation, `UnifiedToolRegistry`, the runtime approval gate, Desktop and hosted App policy projection, and their focused tests.

## Repair requirements

- Resolve input-dependent Browser policy before an approval wait is committed.
- `browser.request_grant` must return `allow`, `deny`, or `approval_required` from trusted current authority without executing the grant effect.
- The durable prepared call must carry the same decision and authority that the approval gate used.
- An already-effective grant must proceed automatically. A forbidden destination must fail without asking. A new eligible grant must ask once.
- `browser.tabs` list, switch, and close must use one consistent execution class from policy evaluation through prepared execution and result evidence.
- Do not classify destinations or actions from keywords, URL paths, page content, or other heuristics.

## Done when

- Desktop and hosted tests prove all three grant branches before handler dispatch.
- An eligible grant resumes the exact approved prepared call, while allow and deny branches create no approval interaction.
- Hosted Ask First policy can list tabs without an execution-class mismatch.
- Tab list produces read-only evidence. Switch and close produce exact external-effect evidence.
- Focused approval and prepared-call suites pass.

## Depends on

None.
