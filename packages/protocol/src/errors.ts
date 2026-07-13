export type RunnerProtocolContractErrorCode =
  | "RUNNER_PROTOCOL_INVALID"
  | "RUNNER_HEALTH_INVALID";

export class RunnerProtocolContractError extends Error {
  readonly code: RunnerProtocolContractErrorCode;

  constructor(
    message: string,
    code: RunnerProtocolContractErrorCode = "RUNNER_PROTOCOL_INVALID",
  ) {
    super(message);
    this.name = "RunnerProtocolContractError";
    this.code = code;
  }
}
