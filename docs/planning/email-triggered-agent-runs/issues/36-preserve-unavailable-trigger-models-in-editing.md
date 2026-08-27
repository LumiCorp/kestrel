# Preserve unavailable Trigger models while editing

## Failed behavior

When an edit dialog loads the current Project Environment's available models, it silently replaces a configured model that is no longer returned with the default or first available model. Saving an unrelated name or instruction edit then changes the Trigger's model without the user's choice, contrary to the required preservation of configured model identity across availability changes.

## Affected work

This repairs [Let Project editors manage private Email Triggers](02-manage-private-project-email-triggers.md) in change `73c5375f3..049c82bef`, specifically edit-form model reconciliation and submission.

## Repair requirements

Never substitute a model during edit initialization or model-list refresh. Keep the configured model visible as unavailable when it is absent from the current selectable list, explain that it must be replaced before the Trigger can be enabled or an explicit model change can be saved, and require the user to deliberately select a replacement. Preserve automatic default selection for new Trigger creation. Do not weaken server-side model validation or proactively disable a Trigger merely because model availability changed.

## Done when

- Opening and closing an unavailable-model Trigger does not alter the draft model.
- Editing an unrelated field never silently submits a default or first model as a replacement.
- The UI visibly distinguishes the preserved unavailable model and an explicit user-selected replacement.
- New Trigger creation still selects the Project Environment default through the existing model rules.
- UI contract and state-transition tests execute the unavailable-model edit path.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
