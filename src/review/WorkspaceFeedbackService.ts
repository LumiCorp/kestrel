import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import type { WorkspaceFeedbackComment, WorkspaceFeedbackSnapshot } from "./contracts.js";

interface Store { version: 1; comments: WorkspaceFeedbackComment[] }

export class WorkspaceFeedbackService {
  private comments = new Map<string, WorkspaceFeedbackComment>();
  private persistTail: Promise<void> = Promise.resolve();

  constructor(private readonly metadataPath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.metadataPath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.metadataPath, "utf8")) as Partial<Store>;
      if (parsed.version === 1 && Array.isArray(parsed.comments)) {
        for (const comment of parsed.comments) if (isComment(comment)) this.comments.set(comment.commentId, comment);
      }
    } catch { /* A missing or invalid local metadata file starts empty. */ }
    await this.persist();
  }

  async add(input: {
    sessionId: string; threadId: string; candidateFingerprint: string; path: string; line: number; side: "LEFT" | "RIGHT"; body: string;
  }): Promise<WorkspaceFeedbackSnapshot> {
    const now = new Date().toISOString();
    const comment: WorkspaceFeedbackComment = {
      commentId: randomUUID(), sessionId: text(input.sessionId, "sessionId", 256), threadId: text(input.threadId, "threadId", 256),
      candidateFingerprint: fingerprint(input.candidateFingerprint), path: filePath(input.path), line: positiveInteger(input.line, "line"),
      side: input.side === "LEFT" ? "LEFT" : "RIGHT", body: text(input.body, "body", 16 * 1024), status: "pending", createdAt: now, updatedAt: now,
    };
    this.comments.set(comment.commentId, comment);
    await this.persist();
    return this.list({ sessionId: comment.sessionId, threadId: comment.threadId, candidateFingerprint: comment.candidateFingerprint });
  }

  async list(input: { sessionId: string; threadId: string; candidateFingerprint: string }): Promise<WorkspaceFeedbackSnapshot> {
    const sessionId = text(input.sessionId, "sessionId", 256);
    const threadId = text(input.threadId, "threadId", 256);
    const candidateFingerprint = fingerprint(input.candidateFingerprint);
    let changed = false;
    for (const [id, comment] of this.comments) {
      if (comment.sessionId === sessionId && comment.threadId === threadId && (comment.status === "pending" || comment.status === "submitted") && comment.candidateFingerprint !== candidateFingerprint) {
        this.comments.set(id, { ...comment, status: "stale", updatedAt: new Date().toISOString() });
        changed = true;
      }
    }
    if (changed) await this.persist();
    return { sessionId, threadId, candidateFingerprint, comments: [...this.comments.values()].filter((comment) => comment.sessionId === sessionId && comment.threadId === threadId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((comment) => ({ ...comment })) };
  }

  async remove(input: { sessionId: string; threadId: string; commentId: string; candidateFingerprint: string }): Promise<WorkspaceFeedbackSnapshot> {
    const comment = this.requireOwned(input.commentId, input.sessionId, input.threadId);
    if (comment.status !== "pending" || comment.candidateFingerprint !== input.candidateFingerprint) throw failure("WORKSPACE_FEEDBACK_STALE", "Only current pending feedback can be removed.");
    this.comments.delete(comment.commentId);
    await this.persist();
    return this.list(input);
  }

  async prepareSubmission(input: { sessionId: string; threadId: string; candidateFingerprint: string; commentIds: string[] }): Promise<WorkspaceFeedbackComment[]> {
    if (!Array.isArray(input.commentIds) || input.commentIds.length === 0 || input.commentIds.length > 100) throw failure("WORKSPACE_FEEDBACK_SELECTION_INVALID", "Select between 1 and 100 feedback comments.");
    return [...new Set(input.commentIds)].map((id) => {
      const comment = this.requireOwned(id, input.sessionId, input.threadId);
      if (comment.status !== "pending" || comment.candidateFingerprint !== input.candidateFingerprint) throw failure("WORKSPACE_FEEDBACK_STALE", "Selected feedback no longer matches the current candidate.", { commentId: id });
      return comment;
    });
  }

  async markSubmitted(input: { sessionId: string; threadId: string; candidateFingerprint: string; commentIds: string[]; runId?: string | undefined }): Promise<WorkspaceFeedbackSnapshot> {
    const selected = await this.prepareSubmission(input);
    const now = new Date().toISOString();
    for (const comment of selected) this.comments.set(comment.commentId, { ...comment, status: "submitted", updatedAt: now, submittedAt: now, ...(input.runId ? { submissionRunId: input.runId } : {}) });
    await this.persist();
    return this.list(input);
  }

  private requireOwned(commentId: string, sessionId: string, threadId: string): WorkspaceFeedbackComment {
    const comment = this.comments.get(text(commentId, "commentId", 256));
    if (!comment || comment.sessionId !== sessionId || comment.threadId !== threadId) throw failure("WORKSPACE_FEEDBACK_NOT_FOUND", "Workspace feedback is unavailable.");
    return comment;
  }

  private async persist(): Promise<void> {
    const retained = [...this.comments.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(-1000);
    if (retained.length !== this.comments.size) this.comments = new Map(retained.map((comment) => [comment.commentId, comment]));
    const value: Store = { version: 1, comments: retained };
    const temp = `${this.metadataPath}.tmp`;
    this.persistTail = this.persistTail.then(async () => { await writeFile(temp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temp, this.metadataPath); });
    await this.persistTail;
  }
}

function text(value: string, label: string, max: number): string { if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw failure("WORKSPACE_FEEDBACK_INPUT_INVALID", `${label} is invalid.`); return value.trim(); }
function fingerprint(value: string): string { const normalized = text(value, "candidateFingerprint", 256); if (!/^sha256:[a-f0-9]{64}$/u.test(normalized)) throw failure("WORKSPACE_FEEDBACK_INPUT_INVALID", "candidateFingerprint is invalid."); return normalized; }
function filePath(value: string): string { const normalized = text(value, "path", 4096).replaceAll("\\", "/"); if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) throw failure("WORKSPACE_FEEDBACK_INPUT_INVALID", "path is invalid."); return normalized; }
function positiveInteger(value: number, label: string): number { if (!Number.isInteger(value) || value <= 0) throw failure("WORKSPACE_FEEDBACK_INPUT_INVALID", `${label} is invalid.`); return value; }
function isComment(value: unknown): value is WorkspaceFeedbackComment { if (typeof value !== "object" || value === null || Array.isArray(value)) return false; const record = value as Record<string, unknown>; return typeof record.commentId === "string" && typeof record.sessionId === "string" && typeof record.threadId === "string" && typeof record.candidateFingerprint === "string" && typeof record.path === "string" && typeof record.line === "number" && (record.side === "LEFT" || record.side === "RIGHT") && typeof record.body === "string" && (record.status === "pending" || record.status === "submitted" || record.status === "resolved" || record.status === "stale") && typeof record.createdAt === "string" && typeof record.updatedAt === "string"; }
function failure(code: string, message: string, details: Record<string, unknown> = {}): Error { return createRuntimeFailure(code, message, { subsystem: "review", classification: "state", recoverable: true, ...details }); }
