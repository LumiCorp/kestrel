export class GatewayModelInUseError extends Error {
  readonly code = "GATEWAY_MODEL_IN_USE";

  constructor() {
    super("An active Environment execution is using this gateway model.");
    this.name = "GatewayModelInUseError";
  }
}
