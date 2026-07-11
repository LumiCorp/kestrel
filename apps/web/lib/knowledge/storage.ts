import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const defaultKnowledgeRoot = path.join(process.cwd(), ".local", "knowledge");

function sanitizeSegment(value: string) {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

export function getKnowledgeRoot() {
  return path.resolve(
    process.env.KNOWLEDGE_STORAGE_ROOT || defaultKnowledgeRoot
  );
}

export function getSnapshotRootPath(
  organizationId: string,
  snapshotId: string
) {
  return path.join(
    getKnowledgeRoot(),
    sanitizeSegment(organizationId),
    sanitizeSegment(snapshotId)
  );
}

export async function ensureSnapshotRoot(
  organizationId: string,
  snapshotId: string
) {
  const snapshotRoot = getSnapshotRootPath(organizationId, snapshotId);
  await mkdir(snapshotRoot, { recursive: true });
  return snapshotRoot;
}

export async function resetSnapshotRoot(
  organizationId: string,
  snapshotId: string
) {
  const snapshotRoot = getSnapshotRootPath(organizationId, snapshotId);
  await rm(snapshotRoot, { recursive: true, force: true });
  await mkdir(snapshotRoot, { recursive: true });
  return snapshotRoot;
}

export async function removeSnapshotRoot(filesystemPath: string) {
  await rm(filesystemPath, { recursive: true, force: true });
}

export async function duplicateSnapshotRoot(
  sourcePath: string,
  organizationId: string,
  snapshotId: string
) {
  const destination = await resetSnapshotRoot(organizationId, snapshotId);
  await cp(sourcePath, destination, { recursive: true, force: true });
  return destination;
}

export async function writeSnapshotFile(
  snapshotRoot: string,
  relativePath: string,
  contents: string | Buffer
) {
  const outputPath = path.resolve(
    snapshotRoot,
    relativePath.replace(/^\/+/, "")
  );
  if (!outputPath.startsWith(snapshotRoot)) {
    throw new Error("Invalid snapshot path");
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, contents);
  return outputPath;
}

export async function readSnapshotFile(filesystemPath: string) {
  return readFile(filesystemPath);
}

export async function countSnapshotFiles(
  snapshotRoot: string
): Promise<number> {
  let total = 0;
  const entries = await readdir(snapshotRoot, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(snapshotRoot, entry.name);
    if (entry.isDirectory()) {
      total += await countSnapshotFiles(fullPath);
      continue;
    }
    total += 1;
  }
  return total;
}

export async function snapshotExists(filesystemPath: string) {
  try {
    const stats = await stat(filesystemPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}
