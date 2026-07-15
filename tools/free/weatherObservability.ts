export interface WeatherProviderAttemptEvidence {
  provider: "open-meteo" | "visual-crossing";
  outcome: "succeeded" | "failed" | "timed_out" | "unavailable";
  durationMs: number;
  failureCode?: string | undefined;
  failureClassification?: string | undefined;
}

export type WeatherProviderAttemptOutcome<T> =
  | {
      status: "succeeded";
      value: T;
      attempt: WeatherProviderAttemptEvidence;
    }
  | {
      status: "failed";
      error: unknown;
      attempt: WeatherProviderAttemptEvidence;
    };

/** Record one exact provider attempt without deciding whether another runs. */
export async function executeObservedWeatherProviderAttempt<T>(input: {
  provider: WeatherProviderAttemptEvidence["provider"];
  execute: () => Promise<T>;
  now?: (() => number) | undefined;
}): Promise<WeatherProviderAttemptOutcome<T>> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  try {
    return {
      status: "succeeded",
      value: await input.execute(),
      attempt: {
        provider: input.provider,
        outcome: "succeeded",
        durationMs: elapsed(startedAt, now()),
      },
    };
  } catch (error) {
    const failure = parseFailureEvidence(error);
    return {
      status: "failed",
      error,
      attempt: {
        provider: input.provider,
        outcome: "failed",
        durationMs: elapsed(startedAt, now()),
        ...(failure.code !== undefined ? { failureCode: failure.code } : {}),
        ...(failure.classification !== undefined
          ? { failureClassification: failure.classification }
          : {}),
      },
    };
  }
}

function elapsed(startedAt: number, completedAt: number) {
  return Math.max(0, Math.round(completedAt - startedAt));
}

function parseFailureEvidence(error: unknown): {
  code?: string | undefined;
  classification?: string | undefined;
} {
  if (!(error && typeof error === "object")) return {};
  const value = error as {
    code?: unknown;
    details?: { classification?: unknown } | undefined;
  };
  return {
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    ...(typeof value.details?.classification === "string"
      ? { classification: value.details.classification }
      : {}),
  };
}
