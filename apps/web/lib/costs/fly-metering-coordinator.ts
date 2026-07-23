export type FlyOrganizationMeteringFailure = {
  organizationId: string;
  message: string;
};

export async function runFlyOrganizationMetering<TProvider, TResult>(input: {
  organizationIds: Iterable<string>;
  createProvider: (organizationId: string) => Promise<TProvider>;
  meterOrganization: (input: {
    organizationId: string;
    provider: TProvider;
  }) => Promise<TResult>;
  onFailure?: (failure: FlyOrganizationMeteringFailure) => void;
}) {
  const results: Array<{ organizationId: string; result: TResult }> = [];
  const failures: FlyOrganizationMeteringFailure[] = [];
  for (const organizationId of new Set(input.organizationIds)) {
    try {
      const provider = await input.createProvider(organizationId);
      results.push({
        organizationId,
        result: await input.meterOrganization({ organizationId, provider }),
      });
    } catch (error) {
      const failure = {
        organizationId,
        message: error instanceof Error ? error.message : "Unknown error",
      };
      failures.push(failure);
      input.onFailure?.(failure);
    }
  }
  return { results, failures };
}
