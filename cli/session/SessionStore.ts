import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SessionsFile, TuiSessionMeta } from "../contracts.js";
import {
  DEFAULT_ACT_SUBMODE,
  DEFAULT_INTERACTION_MODE,
  normalizeInteractionMode,
} from "../../src/mode/contracts.js";
import { resolveKestrelHomePath } from "../../src/runtime/kestrelHome.js";
import { extractResponseField, resolveLocalCoreStoreClient } from "../localCoreStoreClient.js";

const SESSION_FILE_NAME = "sessions.json";

export class SessionStore {
  private readonly baseDir: string;
  private readonly filePath: string;

  constructor(baseDir = resolveKestrelHomePath()) {
    this.baseDir = baseDir;
    this.filePath = path.join(this.baseDir, SESSION_FILE_NAME);
  }

  async load(): Promise<SessionsFile> {
    const core = resolveLocalCoreStoreClient(this.baseDir);
    if (core !== undefined) {
      const response = await core.client.getJson("/v1/sessions");
      const activeSessionName = typeof response === "object" && response !== null && Array.isArray(response) === false
        ? (response as { activeSessionName?: unknown }).activeSessionName
        : undefined;
      return {
        version: 5,
        ...(typeof activeSessionName === "string"
          ? { activeSessionName }
          : {}),
        sessions: extractResponseField<TuiSessionMeta[]>(response, "sessions", "sessions"),
      };
    }

    await mkdir(this.baseDir, { recursive: true });

    const raw = await this.readFile();
    if (raw === undefined) {
      const empty: SessionsFile = {
        version: 5,
        sessions: [],
      };
      await this.save(empty);
      return empty;
    }

    try {
      return parseSessionsFile(raw);
    } catch (error) {
      if (error instanceof SessionSchemaVersionError) {
        const empty: SessionsFile = {
          version: 5,
          sessions: [],
        };
        await this.save(empty);
        return empty;
      }
      throw error;
    }
  }

  async save(file: SessionsFile): Promise<void> {
    const core = resolveLocalCoreStoreClient(this.baseDir);
    if (core !== undefined) {
      await core.client.putJson("/v1/sessions", { sessions: file });
      return;
    }

    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  }

  upsert(file: SessionsFile, session: TuiSessionMeta): SessionsFile {
    const sessions = [...file.sessions];
    const index = sessions.findIndex((s) => s.name === session.name);
    if (index >= 0) {
      sessions[index] = session;
    } else {
      sessions.push(session);
    }

    return {
      ...file,
      sessions,
      activeSessionName: session.name,
    };
  }

  setActive(file: SessionsFile, name: string): SessionsFile {
    return {
      ...file,
      activeSessionName: name,
    };
  }

  findByName(file: SessionsFile, name: string): TuiSessionMeta | undefined {
    return file.sessions.find((session) => session.name === name);
  }

  resolveSelector(file: SessionsFile, selector: string): SessionSelectorResolution {
    const trimmed = selector.trim();
    if (trimmed.length === 0) {
      return { status: "not_found" };
    }

    const named = this.findByName(file, trimmed);
    if (named !== undefined) {
      return { status: "matched", session: named, match: "name" };
    }

    const exactId = file.sessions.find((session) => session.sessionId === trimmed);
    if (exactId !== undefined) {
      return { status: "matched", session: exactId, match: "sessionId" };
    }

    const needle = trimmed.toLowerCase();
    const idMatches = file.sessions.filter((session) =>
      session.sessionId.toLowerCase().includes(needle),
    );
    if (idMatches.length === 1) {
      return { status: "matched", session: idMatches[0]!, match: "sessionIdFragment" };
    }
    if (idMatches.length > 1) {
      return { status: "ambiguous", matches: idMatches };
    }

    return { status: "not_found" };
  }

  getActive(file: SessionsFile): TuiSessionMeta | undefined {
    if (file.activeSessionName === undefined) {
      return undefined;
    }

    return this.findByName(file, file.activeSessionName);
  }

  private async readFile(): Promise<string | undefined> {
    try {
      return await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }

      throw error;
    }
  }
}

export type SessionSelectorResolution =
  | {
      status: "matched";
      session: TuiSessionMeta;
      match: "name" | "sessionId" | "sessionIdFragment";
    }
  | {
      status: "ambiguous";
      matches: TuiSessionMeta[];
    }
  | {
      status: "not_found";
    };

export function parseSessionsFile(raw: string): SessionsFile {
  let decoded: unknown;

  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid sessions JSON: ${error instanceof Error ? error.message : "unknown parse error"}`,
    );
  }

  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new Error("sessions.json must be an object");
  }

  const root = decoded as Record<string, unknown>;
  if (root.version !== 2 && root.version !== 3 && root.version !== 4 && root.version !== 5) {
    throw new SessionSchemaVersionError("sessions.json version must be 2, 3, 4, or 5");
  }

  const activeSessionName =
    typeof root.activeSessionName === "string" ? root.activeSessionName : undefined;

  const sessionsInput = root.sessions;
  if (Array.isArray(sessionsInput) === false) {
    throw new Error("sessions.json sessions must be an array");
  }

  const sessions = sessionsInput.map(validateSession);

  return {
    version: 5,
    ...(activeSessionName !== undefined ? { activeSessionName } : {}),
    sessions,
  };
}

class SessionSchemaVersionError extends Error {}

function validateSession(value: unknown): TuiSessionMeta {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("session entries must be objects");
  }

  const entry = value as Record<string, unknown>;

  const pendingWaitFor =
    typeof entry.pendingWaitFor === "object" &&
    entry.pendingWaitFor !== null &&
    Array.isArray(entry.pendingWaitFor) === false
      ? (entry.pendingWaitFor as TuiSessionMeta["pendingWaitFor"])
      : undefined;
  const lastRunStatus = typeof entry.lastRunStatus === "string"
    ? (entry.lastRunStatus as TuiSessionMeta["lastRunStatus"])
    : undefined;
  const lastMessagePreview = typeof entry.lastMessagePreview === "string"
    ? entry.lastMessagePreview
    : undefined;
  const profileLabel = typeof entry.profileLabel === "string"
    ? entry.profileLabel
    : undefined;
  const launchPresetId = typeof entry.launchPresetId === "string"
    ? entry.launchPresetId as TuiSessionMeta["launchPresetId"]
    : undefined;
  const launchTemplateId = typeof entry.launchTemplateId === "string"
    ? entry.launchTemplateId as TuiSessionMeta["launchTemplateId"]
    : undefined;
  const workspaceBinding = entry.workspaceBinding === "active" || entry.workspaceBinding === "detached"
    ? entry.workspaceBinding
    : undefined;
  const workspaceLabel = typeof entry.workspaceLabel === "string"
    ? entry.workspaceLabel
    : undefined;
  const launchSummary = typeof entry.launchSummary === "string"
    ? entry.launchSummary
    : undefined;
  const hasArtifacts = typeof entry.hasArtifacts === "boolean"
    ? entry.hasArtifacts
    : undefined;
  const hasSummary = typeof entry.hasSummary === "boolean"
    ? entry.hasSummary
    : undefined;
  const activeSkillPackId = typeof entry.activeSkillPackId === "string"
    ? entry.activeSkillPackId
    : undefined;
  const pendingManualCompaction =
    typeof entry.pendingManualCompaction === "boolean" ? entry.pendingManualCompaction : undefined;
  const autoCompactionEnabled =
    typeof entry.autoCompactionEnabled === "boolean" ? entry.autoCompactionEnabled : undefined;
  const suppressAutoCompactionOnce =
    typeof entry.suppressAutoCompactionOnce === "boolean"
      ? entry.suppressAutoCompactionOnce
      : undefined;
  const delegation =
    typeof entry.delegation === "object" &&
    entry.delegation !== null &&
    Array.isArray(entry.delegation) === false
      ? (entry.delegation as TuiSessionMeta["delegation"])
      : undefined;
  const operatorState =
    typeof entry.operatorState === "object" &&
    entry.operatorState !== null &&
    Array.isArray(entry.operatorState) === false
      ? (entry.operatorState as TuiSessionMeta["operatorState"])
      : undefined;
  const executionPolicy =
    typeof entry.executionPolicy === "object" &&
    entry.executionPolicy !== null &&
    Array.isArray(entry.executionPolicy) === false
      ? (entry.executionPolicy as TuiSessionMeta["executionPolicy"])
      : undefined;
  const modeResolution = normalizeInteractionMode({
    interactionMode: entry.interactionMode,
    actSubmode: entry.actSubmode,
    defaultInteractionMode: DEFAULT_INTERACTION_MODE,
    defaultActSubmode: DEFAULT_ACT_SUBMODE,
  });

  return {
    name: readRequiredString(entry, "name"),
    sessionId: readRequiredString(entry, "sessionId"),
    profileId: readRequiredString(entry, "profileId"),
    ...(profileLabel !== undefined ? { profileLabel } : {}),
    ...(launchPresetId !== undefined ? { launchPresetId } : {}),
    ...(launchTemplateId !== undefined ? { launchTemplateId } : {}),
    ...(workspaceBinding !== undefined ? { workspaceBinding } : {}),
    ...(typeof entry.workspaceId === "string" ? { workspaceId: entry.workspaceId } : {}),
    ...(typeof entry.workspaceRoot === "string" ? { workspaceRoot: entry.workspaceRoot } : {}),
    ...(workspaceLabel !== undefined ? { workspaceLabel } : {}),
    createdAt: readRequiredString(entry, "createdAt"),
    updatedAt: readRequiredString(entry, "updatedAt"),
    started: typeof entry.started === "boolean" ? entry.started : false,
    ...(lastRunStatus !== undefined ? { lastRunStatus } : {}),
    ...(pendingWaitFor !== undefined ? { pendingWaitFor } : {}),
    ...(lastMessagePreview !== undefined ? { lastMessagePreview } : {}),
    ...(launchSummary !== undefined ? { launchSummary } : {}),
    ...(hasArtifacts !== undefined ? { hasArtifacts } : {}),
    ...(hasSummary !== undefined ? { hasSummary } : {}),
    ...(activeSkillPackId !== undefined ? { activeSkillPackId } : {}),
    ...(pendingManualCompaction !== undefined ? { pendingManualCompaction } : {}),
    ...(autoCompactionEnabled !== undefined ? { autoCompactionEnabled } : {}),
    ...(suppressAutoCompactionOnce !== undefined ? { suppressAutoCompactionOnce } : {}),
    ...(delegation !== undefined ? { delegation } : {}),
    ...(operatorState !== undefined ? { operatorState } : {}),
    interactionMode: modeResolution.interactionMode,
    ...(modeResolution.actSubmode !== undefined ? { actSubmode: modeResolution.actSubmode } : {}),
    ...(executionPolicy !== undefined ? { executionPolicy } : {}),
  };
}

function readRequiredString(value: Record<string, unknown>, key: string): string {
  const maybe = value[key];
  if (typeof maybe !== "string" || maybe.trim().length === 0) {
    throw new Error(`Session field '${key}' must be a non-empty string`);
  }

  return maybe;
}
