# Close hosted readiness admission and truth gaps

## Failed behavior

The shared hosted-model readiness contract is not applied consistently at every default-setting boundary, and two readiness states are not reported truthfully to administrators.

An Environment default can be saved after the gateway credential revision changes because its validator does not supply credential revision or reachability to the role-readiness predicate. Runtime selection rejects that stale route later and substitutes an eligible model, leaving the stored Environment intent ineligible.

The settings surface does not show provider reachability. A syntactically valid retained registration whose provider or model differs from the row is also presented as a legacy registration, which hides the exact identity mismatch and retained evidence.

## Affected work

[Show truthful hosted model readiness by role](11-show-truthful-hosted-model-readiness.md) was implemented in `b19e61d67`. The affected surfaces are `apps/web/lib/ai/environment-inference.ts`, `apps/web/lib/ai/hosted-model-readiness.ts`, and `apps/web/components/settings/ai-providers-client.tsx`.

## Repair requirements

Every hosted default-setting boundary must apply the same current `agent.loop` predicate as listing and runtime admission, including credential revision and reachability. It must reject an ineligible requested default rather than persist it or silently replace it later.

The administrator projection must show approval, reachability, exact identity, declaration, qualification, freshness, eligible roles, and an actionable unavailable reason. A retained registration that parses but does not match the exact provider/model must remain ineligible and be reported as an identity mismatch, not as legacy absence.

Preserve historical registration and grant evidence. Do not add capability inference, provider fallback, or a new model-selection policy.

## Done when

- Rotating a hosted gateway credential or making it unreachable prevents the Environment default boundary from accepting the old qualification.
- A reachable and an unreachable provider are both shown explicitly in the administrator readiness surface.
- A parsed registration with a mismatched provider or model is reported as invalid with its retained evidence visible and remains unavailable for `agent.loop`.
- Focused Environment-default, readiness, and settings-presentation regressions pass.
- The affected Issue 11 admission and truthful-readiness outcome holds end to end.

## Depends on

- [Show truthful hosted model readiness by role](11-show-truthful-hosted-model-readiness.md) (implemented, review pending)
