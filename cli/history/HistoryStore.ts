import { mkdir, readFile, appendFile } from "node:fs/promises";
import path from "node:path";

import type { TranscriptLine, TuiHistoryRecord } from "../contracts.js";
import { resolveKestrelHomePath } from "../../src/runtime/kestrelHome.js";
import { extractResponseField, resolveLocalCoreStoreClient } from "../localCoreStoreClient.js";

const HISTORY_FILE_NAME = "history.jsonl";

export class HistoryStore {
  private readonly baseDir: string;
  private readonly filePath: string;

  constructor(baseDir = resolveKestrelHomePath()) {
    this.baseDir = baseDir;
    this.filePath = path.join(this.baseDir, HISTORY_FILE_NAME);
  }

  async append(record: TuiHistoryRecord): Promise<void> {
    const core = resolveLocalCoreStoreClient(this.baseDir);
    if (core !== undefined) {
      await core.client.postJson("/v1/history", { record });
      return;
    }

    try {
      await mkdir(this.baseDir, { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
    } catch (error) {
      if (isNonFatalFsError(error)) {
        return;
      }
      throw error;
    }
  }

  async readTranscript(sessionId: string, maxItems = 200): Promise<TranscriptLine[]> {
    const core = resolveLocalCoreStoreClient(this.baseDir);
    if (core !== undefined) {
      return extractResponseField<TranscriptLine[]>(
        await core.client.getJson(`/v1/history/transcript/${encodeURIComponent(sessionId)}?maxItems=${maxItems}`),
        "transcript",
        "history transcript",
      );
    }

    const records = await this.readRecords();
    const lines = records
      .filter((record) => record.sessionId === sessionId)
      .slice(-maxItems)
      .map((record) => ({
        role: record.role,
        text: record.text,
        data: record.data,
        timestamp: record.timestamp,
        run: record.run,
      }));

    return mergeLegacyAssistantSegments(lines);
  }

  async readSessionOverviews(sessionIds?: string[]): Promise<Record<string, SessionHistoryOverview>> {
    const core = resolveLocalCoreStoreClient(this.baseDir);
    if (core !== undefined) {
      return extractResponseField<Record<string, SessionHistoryOverview>>(
        await core.client.postJson("/v1/history/overviews", { sessionIds }),
        "overviews",
        "history overviews",
      );
    }

    const records = await this.readRecords();
    const filter = sessionIds === undefined ? undefined : new Set(sessionIds);
    const overviews: Record<string, SessionHistoryOverview> = {};

    for (const record of records) {
      if (filter !== undefined && filter.has(record.sessionId) === false) {
        continue;
      }

      const current = overviews[record.sessionId] ?? {
        hasArtifacts: false,
        hasSummary: false,
        restartAvailable: false,
      };

      const preview = record.text.replace(/\s+/gu, " ").trim();
      overviews[record.sessionId] = {
        launchSummary:
          current.launchSummary ?? (record.role === "system" && record.text.startsWith("Task=") ? record.text : undefined),
        lastPreview: preview.length > 0 ? preview : current.lastPreview,
        hasArtifacts: current.hasArtifacts || hasArtifacts(record.data),
        hasSummary: current.hasSummary || (record.role === "assistant" && preview.length > 0),
        restartAvailable: true,
      };
    }

    return overviews;
  }

  private async readRecords(): Promise<TuiHistoryRecord[]> {
    let raw: string;

    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNonFatalFsError(error, ["ENOENT"])) {
        return [];
      }

      throw error;
    }

    return raw
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .map((line) => safeParseRecord(line))
      .filter((record): record is TuiHistoryRecord => record !== undefined);
  }
}

export interface SessionHistoryOverview {
  launchSummary?: string | undefined;
  lastPreview?: string | undefined;
  hasArtifacts: boolean;
  hasSummary: boolean;
  restartAvailable: boolean;
}

function mergeLegacyAssistantSegments(lines: TranscriptLine[]): TranscriptLine[] {
  const merged: TranscriptLine[] = [];

  for (const line of lines) {
    const previous = merged[merged.length - 1];
    if (shouldMergeAssistantSegment(previous, line)) {
      previous.text = `${previous.text}\n${line.text}`;
      continue;
    }

    merged.push({
      role: line.role,
      text: line.text,
      ...(line.data !== undefined ? { data: line.data } : {}),
      timestamp: line.timestamp,
      ...(line.run !== undefined ? { run: line.run } : {}),
    });
  }

  return merged;
}

function shouldMergeAssistantSegment(
  previous: TranscriptLine | undefined,
  current: TranscriptLine,
): previous is TranscriptLine {
  if (previous === undefined) {
    return false;
  }

  if (previous.role !== "assistant" || current.role !== "assistant") {
    return false;
  }

  if (current.data !== undefined || current.run !== undefined) {
    return false;
  }

  const previousTime = Date.parse(previous.timestamp);
  const currentTime = Date.parse(current.timestamp);
  if (Number.isNaN(previousTime) || Number.isNaN(currentTime)) {
    return false;
  }

  return currentTime - previousTime >= 0 && currentTime - previousTime <= 1_000;
}

function isNonFatalFsError(error: unknown, extraCodes: string[] = []): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code !== "string") {
    return false;
  }

  const nonFatal = new Set(["EACCES", "EPERM", "EROFS", ...extraCodes]);
  return nonFatal.has(code);
}

function safeParseRecord(line: string): TuiHistoryRecord | undefined {
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }

    const value = parsed as Record<string, unknown>;
    if (typeof value.sessionId !== "string") {
      return undefined;
    }
    if (value.source !== "runner") {
      return undefined;
    }
    if (typeof value.eventId !== "string") {
      return undefined;
    }
    if (typeof value.timestamp !== "string") {
      return undefined;
    }
    if (typeof value.role !== "string") {
      return undefined;
    }
    if (typeof value.text !== "string") {
      return undefined;
    }

    return parsed as TuiHistoryRecord;
  } catch {
    return undefined;
  }
}

function hasArtifacts(data: Record<string, unknown> | undefined): boolean {
  if (data === undefined) {
    return false;
  }

  const ui = data.ui;
  if (typeof ui !== "object" || ui === null || Array.isArray(ui)) {
    return false;
  }

  const artifacts = (ui as Record<string, unknown>).artifacts;
  return Array.isArray(artifacts) && artifacts.length > 0;
}
