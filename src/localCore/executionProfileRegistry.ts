import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { TuiProfile } from "../../cli/contracts.js";
import {
  fingerprintResolvedProfile,
  KESTREL_ONE_POLICY_ID,
} from "../profile/kestrelOnePolicy.js";
import type { ShellPresetId } from "../profile/runtimeProfile.js";

const REGISTRY_VERSION = 1;
const registryWriteQueues = new Map<string, Promise<void>>();

interface ExecutionProfileRegistryFile {
  version: typeof REGISTRY_VERSION;
  profiles: TuiProfile[];
}

export interface RegisteredExecutionProfile {
  profileId: string;
  profile: TuiProfile;
  fingerprint: string;
}

export interface ExecutionProfileRevisionProvenance {
  policy: {
    id: string;
    version: number;
  };
  environmentPreset: {
    id: ShellPresetId;
    version: number;
  };
  modelConfiguration?: {
    id: string;
    revision: number;
  } | undefined;
  integrationContracts?: Array<{
    id: string;
    revision: number;
  }> | undefined;
  authoringProfile?: {
    id: string;
    revision: string;
  } | undefined;
}

export class LocalCoreExecutionProfileRegistry {
  private readonly filePath: string;

  constructor(homePath: string) {
    this.filePath = path.join(
      homePath,
      "runtime",
      "execution-profiles.json",
    );
  }

  async register(
    inputProfile: TuiProfile,
    environmentPresetId: ShellPresetId,
    revisionProvenance?: ExecutionProfileRevisionProvenance | undefined,
  ): Promise<RegisteredExecutionProfile> {
    assertSecretFreeProfile(inputProfile);
    const fingerprintSeed = {
      ...structuredClone(inputProfile),
      id:
        inputProfile.agentProfileId === KESTREL_ONE_POLICY_ID
          ? KESTREL_ONE_POLICY_ID
          : inputProfile.id,
    };
    const fingerprint = fingerprintResolvedProfile(
      fingerprintSeed,
      revisionProvenance,
    );
    const prefix =
      inputProfile.agentProfileId === KESTREL_ONE_POLICY_ID
        ? KESTREL_ONE_POLICY_ID
        : `custom:${sanitizeId(inputProfile.id)}`;
    const profileId = `${prefix}:${environmentPresetId}:${fingerprint}`;
    const profile: TuiProfile = {
      ...structuredClone(inputProfile),
      id: profileId,
    };
    return await withRegistryWriteLock(this.filePath, async () => {
      const registry = await this.read();
      const existing = registry.profiles.find(
        (candidate) => candidate.id === profileId,
      );
      if (existing !== undefined) {
        return { profileId, profile: existing, fingerprint };
      }
      await this.write({
        version: REGISTRY_VERSION,
        profiles: [...registry.profiles, profile],
      });
      return { profileId, profile, fingerprint };
    });
  }

  async get(profileId: string): Promise<TuiProfile | undefined> {
    const profile = (await this.read()).profiles.find(
      (candidate) => candidate.id === profileId,
    );
    return profile === undefined ? undefined : structuredClone(profile);
  }

  async list(): Promise<TuiProfile[]> {
    return structuredClone((await this.read()).profiles);
  }

  private async read(): Promise<ExecutionProfileRegistryFile> {
    try {
      const decoded = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (
        typeof decoded !== "object" ||
        decoded === null ||
        Array.isArray(decoded)
      ) {
        throw new Error("Local Core execution profile registry must be an object.");
      }
      const record = decoded as Record<string, unknown>;
      if (record.version !== REGISTRY_VERSION || Array.isArray(record.profiles) === false) {
        throw new Error(
          `Local Core execution profile registry version must be ${REGISTRY_VERSION}.`,
        );
      }
      const profiles = record.profiles.map((entry, index) =>
        parseStoredProfile(entry, index),
      );
      return { version: REGISTRY_VERSION, profiles };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: REGISTRY_VERSION, profiles: [] };
      }
      throw error;
    }
  }

  private async write(value: ExecutionProfileRegistryFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary =
      `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
  }
}

async function withRegistryWriteLock<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = registryWriteQueues.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  registryWriteQueues.set(filePath, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (registryWriteQueues.get(filePath) === queued) {
      registryWriteQueues.delete(filePath);
    }
  }
}

function parseStoredProfile(value: unknown, index: number): TuiProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Local Core execution profile registry profiles[${index}] must be an object.`,
    );
  }
  const profile = value as Partial<TuiProfile>;
  if (
    typeof profile.id !== "string" ||
    profile.id.trim().length === 0 ||
    typeof profile.label !== "string" ||
    profile.label.trim().length === 0 ||
    profile.agent !== "reference-react"
  ) {
    throw new Error(
      `Local Core execution profile registry profiles[${index}] is invalid.`,
    );
  }
  assertSecretFreeProfile(profile as TuiProfile);
  return structuredClone(profile as TuiProfile);
}

function assertSecretFreeProfile(profile: TuiProfile): void {
  const serialized = JSON.stringify(profile);
  for (const forbidden of [
    "\"apiKey\"",
    "\"accessToken\"",
    "\"refreshToken\"",
    "\"secret\"",
  ]) {
    if (serialized.includes(forbidden)) {
      throw new Error(
        "Local Core execution profile snapshots cannot contain secret material.",
      );
    }
  }
}

function sanitizeId(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/gu, "-");
  return normalized.length > 0 ? normalized : "profile";
}
