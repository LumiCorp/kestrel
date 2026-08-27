export type EmailTriggerModelSelectionOption = {
  id: string;
  isDefault: boolean;
};

export function reconcileEmailTriggerModelSelection(input: {
  currentModelId: string;
  models: EmailTriggerModelSelectionOption[];
  mode: "create" | "edit";
}) {
  if (input.models.some((model) => model.id === input.currentModelId)) {
    return input.currentModelId;
  }
  if (input.mode === "edit") {
    return input.currentModelId;
  }
  return (
    input.models.find((model) => model.isDefault)?.id ??
    input.models[0]?.id ??
    ""
  );
}

export function emailTriggerModelIsUnavailable(input: {
  configuredModelId: string;
  models: EmailTriggerModelSelectionOption[];
}) {
  return !input.models.some(
    (model) => model.id === input.configuredModelId,
  );
}
