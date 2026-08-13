import { createHash, randomUUID, type Hash } from "node:crypto";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { WorkspaceRequestError } from "./security.js";
import { restorePortableBackupPayload } from "./portable-worktree-backup.js";
import { resolveWorkspaceBackupLogicalLimit } from "./backup-preparations.js";

type BackupImport = {
  id: string;
  expectedSha256: string;
  hash: Hash;
  nextChunkIndex: number;
  size: number;
  maxBytes: number;
  extractor: ChildProcessWithoutNullStreams;
  extraction: Promise<void>;
};

export class WorkspaceBackupImportRegistry {
  private readonly imports = new Map<string, BackupImport>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly options: { maxImportBytes?: number | undefined } = {},
  ) {}

  async create(expectedSha256: string) {
    if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
      throw new WorkspaceRequestError(400, "WORKSPACE_BACKUP_CHECKSUM_INVALID");
    }
    const id = randomUUID();
    const maxBytes =
      this.options.maxImportBytes ??
      (await resolveWorkspaceBackupLogicalLimit(this.workspaceRoot));
    const extractor = spawn("tar", ["-xzf", "-", "-C", this.workspaceRoot]);
    extractor.stderr.resume();
    const extraction = waitForExtraction(extractor);
    void extraction.catch(() => {});
    this.imports.set(id, {
      id,
      expectedSha256,
      hash: createHash("sha256"),
      nextChunkIndex: 0,
      size: 0,
      maxBytes,
      extractor,
      extraction,
    });
    return { id };
  }

  async append(id: string, chunkIndex: number, content: Buffer) {
    const current = this.require(id);
    if (chunkIndex !== current.nextChunkIndex) {
      throw new WorkspaceRequestError(
        409,
        "WORKSPACE_BACKUP_CHUNK_OUT_OF_ORDER"
      );
    }
    if (content.length === 0 || content.length > 768 * 1024) {
      throw new WorkspaceRequestError(413, "WORKSPACE_BACKUP_CHUNK_INVALID");
    }
    current.size += content.length;
    if (current.size > current.maxBytes) {
      await this.abort(id);
      throw new WorkspaceRequestError(413, "WORKSPACE_BACKUP_TOO_LARGE");
    }
    current.hash.update(content);
    await writeExtractionChunk(current.extractor, content);
    current.nextChunkIndex += 1;
    return { nextChunkIndex: current.nextChunkIndex, size: current.size };
  }

  async complete(id: string) {
    const current = this.require(id);
    const checksumSha256 = current.hash.digest("hex");
    if (checksumSha256 !== current.expectedSha256) {
      await this.abort(id);
      throw new WorkspaceRequestError(
        409,
        "WORKSPACE_BACKUP_CHECKSUM_MISMATCH"
      );
    }
    try {
      current.extractor.stdin.end();
      await current.extraction;
      await restorePortableBackupPayload(this.workspaceRoot);
      this.imports.delete(id);
      return { checksumSha256, size: current.size };
    } catch (error) {
      await this.abort(id);
      throw error;
    }
  }

  async abort(id: string) {
    const current = this.imports.get(id);
    this.imports.delete(id);
    if (current) {
      current.extractor.stdin.destroy();
      current.extractor.kill("SIGKILL");
      await current.extraction.catch(() => {});
    }
  }

  async closeAll() {
    await Promise.all([...this.imports.keys()].map((id) => this.abort(id)));
  }

  private require(id: string) {
    const current = this.imports.get(id);
    if (!current) {
      throw new WorkspaceRequestError(404, "WORKSPACE_BACKUP_IMPORT_NOT_FOUND");
    }
    return current;
  }
}

function waitForExtraction(child: ChildProcessWithoutNullStreams) {
  return new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new WorkspaceRequestError(400, "WORKSPACE_RESTORE_FAILED"));
    });
  });
}

function writeExtractionChunk(
  child: ChildProcessWithoutNullStreams,
  content: Buffer,
) {
  return new Promise<void>((resolve, reject) => {
    child.stdin.write(content, (error) => (error ? reject(error) : resolve()));
  });
}
