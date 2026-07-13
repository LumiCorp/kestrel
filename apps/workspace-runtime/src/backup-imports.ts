import { createHash, randomUUID, type Hash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { WorkspaceRequestError } from "./security.js";

const MAX_IMPORT_BYTES = 256 * 1024 * 1024;

type BackupImport = {
  id: string;
  archivePath: string;
  expectedSha256: string;
  hash: Hash;
  nextChunkIndex: number;
  size: number;
};

export class WorkspaceBackupImportRegistry {
  private readonly imports = new Map<string, BackupImport>();

  constructor(private readonly workspaceRoot: string) {}

  async create(expectedSha256: string) {
    if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
      throw new WorkspaceRequestError(400, "WORKSPACE_BACKUP_CHECKSUM_INVALID");
    }
    const id = randomUUID();
    const root = path.join(os.tmpdir(), "kestrel-backup-imports");
    await mkdir(root, { recursive: true });
    const archivePath = path.join(root, `${id}.tar.gz`);
    this.imports.set(id, {
      id,
      archivePath,
      expectedSha256,
      hash: createHash("sha256"),
      nextChunkIndex: 0,
      size: 0,
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
    if (current.size > MAX_IMPORT_BYTES) {
      await this.abort(id);
      throw new WorkspaceRequestError(413, "WORKSPACE_BACKUP_TOO_LARGE");
    }
    current.hash.update(content);
    await pipeline(
      Readable.from([content]),
      createWriteStream(current.archivePath, { flags: "a" })
    );
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
      await extractArchive(current.archivePath, this.workspaceRoot);
      this.imports.delete(id);
      await rm(current.archivePath, { force: true });
      return { checksumSha256, size: current.size };
    } catch (error) {
      await this.abort(id);
      throw error;
    }
  }

  async abort(id: string) {
    const current = this.imports.get(id);
    this.imports.delete(id);
    if (current) await rm(current.archivePath, { force: true });
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

function extractArchive(archivePath: string, workspaceRoot: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archivePath, "-C", workspaceRoot]);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new WorkspaceRequestError(400, "WORKSPACE_RESTORE_FAILED"));
    });
  });
}
