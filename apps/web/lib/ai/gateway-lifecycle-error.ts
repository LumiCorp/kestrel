export class GatewayModelInUseError extends Error {
  readonly code = "GATEWAY_MODEL_IN_USE";

  constructor() {
    super("An active Environment execution is using this gateway model.");
    this.name = "GatewayModelInUseError";
  }
}

export class GatewayModelEconomicsProfileRequiredError extends Error {
  readonly code = "GATEWAY_MODEL_ECONOMICS_PROFILE_REQUIRED";

  constructor(input: { provider: string; model: string }) {
    super(
      `Cannot approve ${input.provider}/${input.model} because provider capacity metadata is missing. Refresh the provider catalog and try again.`,
    );
    this.name = "GatewayModelEconomicsProfileRequiredError";
  }
}
