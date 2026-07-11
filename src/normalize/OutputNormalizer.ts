import type {
  NormalizedOutput,
  OutputNormalizer,
} from "../kestrel/contracts/execution.js";

export class DefaultOutputNormalizer implements OutputNormalizer {
  normalize(input: NormalizedOutput): NormalizedOutput {
    const waitFor =
      input.waitFor === undefined
        ? undefined
        : input.waitFor.kind === "user"
          ? {
              ...input.waitFor,
              metadata: { ...input.waitFor.metadata },
            }
          : {
              ...input.waitFor,
              ...(input.waitFor.metadata === undefined
                ? {}
                : { metadata: { ...input.waitFor.metadata } }),
            };
    return {
      ...input,
      waitFor,
      continuation:
        input.continuation === undefined
          ? undefined
          : {
              ...input.continuation,
            },
      errors: [...input.errors],
      telemetry: {
        ...input.telemetry,
      },
      readBudgets:
        input.readBudgets === undefined
          ? undefined
          : {
              filesystemResume: {
                ...input.readBudgets.filesystemResume,
                configuredLimits: {
                  ...input.readBudgets.filesystemResume.configuredLimits,
                },
                usage: {
                  ...input.readBudgets.filesystemResume.usage,
                },
                remaining: {
                  ...input.readBudgets.filesystemResume.remaining,
                },
              },
            },
      quality: {
        ...input.quality,
      },
      checkpoint:
        input.checkpoint === undefined
          ? undefined
          : {
              ...input.checkpoint,
            },
    };
  }
}
