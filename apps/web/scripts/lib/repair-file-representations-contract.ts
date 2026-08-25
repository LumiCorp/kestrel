export type RepairFileRepresentationOptions = {
  apply: boolean;
  limit: number;
  organizationId?: string;
};

export type RepairFileRepresentationCounts = {
  scanned: number;
  repaired: number;
  stillFailed: number;
  skipped: number;
};

export async function repairFileRepresentationCandidates<T>(input: {
  candidates: T[];
  initialSkipped: number;
  repair(candidate: T): Promise<void>;
  inspect(candidate: T): Promise<"ready" | "failed" | "missing">;
}): Promise<RepairFileRepresentationCounts> {
  const result: RepairFileRepresentationCounts = {
    scanned: input.candidates.length,
    repaired: 0,
    stillFailed: 0,
    skipped: input.initialSkipped,
  };
  for (const candidate of input.candidates) {
    try {
      await input.repair(candidate);
      const status = await input.inspect(candidate);
      if (status === "ready") result.repaired += 1;
      else if (status === "missing") result.skipped += 1;
      else result.stillFailed += 1;
    } catch {
      // Candidate failures are recoverable only when durable state can still be
      // inspected. A database/inspection outage is an infrastructure failure,
      // so let it reject the batch instead of emitting a false-success summary.
      const status = await input.inspect(candidate);
      if (status === "missing") result.skipped += 1;
      else result.stillFailed += 1;
    }
  }
  return result;
}

export function parseRepairFileRepresentationArgs(
  args: string[],
): RepairFileRepresentationOptions {
  const options: RepairFileRepresentationOptions = { apply: false, limit: 100 };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") continue;
    if (token === "--apply") {
      options.apply = true;
      continue;
    }
    if (token === "--limit" || token === "--organization-id") {
      const value = args[index + 1]?.trim();
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
      if (token === "--limit") {
        const limit = Number(value);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
          throw new Error("--limit must be an integer from 1 to 1000.");
        }
        options.limit = limit;
      } else {
        options.organizationId = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument '${token}'.`);
  }
  return options;
}
