import { createHash } from "node:crypto";

const MAX_ARTIFACT_COUNT = 1000;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

interface StoredArtifact {
  ref: string;
  content: string;
  contentType: string;
  byteLength: number;
  sha256: string;
  createdAt: string;
}

const artifacts = new Map<string, StoredArtifact>();
let retainedBytes = 0;

export function storeTextArtifact(input: {
  content: string;
  contentType?: string | undefined;
  namespace?: string | undefined;
}): StoredArtifact {
  const contentType = input.contentType ?? "text/plain; charset=utf-8";
  const sha256 = createHash("sha256").update(input.content).digest("hex");
  const ref = `${input.namespace ?? "artifact"}:${sha256}`;
  const existing = artifacts.get(ref);
  if (existing !== undefined) {
    artifacts.delete(ref);
    artifacts.set(ref, existing);
    return existing;
  }
  const artifact: StoredArtifact = {
    ref,
    content: input.content,
    contentType,
    byteLength: Buffer.byteLength(input.content, "utf8"),
    sha256,
    createdAt: new Date().toISOString(),
  };
  artifacts.set(ref, artifact);
  retainedBytes += artifact.byteLength;
  evictArtifacts();
  return artifact;
}

export function storeJsonArtifact(ref: string, value: unknown): StoredArtifact {
  const existing = artifacts.get(ref);
  if (existing !== undefined) {
    artifacts.delete(ref);
    artifacts.set(ref, existing);
    return existing;
  }
  const content = validateJsonArtifactValue(value);
  const stored = storeTextArtifact({
    content,
    contentType: "application/json; charset=utf-8",
    namespace: "tool-output",
  });
  if (stored.ref === ref) {
    return stored;
  }
  const artifact = { ...stored, ref };
  artifacts.delete(stored.ref);
  const replaced = artifacts.get(ref);
  retainedBytes -= replaced?.byteLength ?? 0;
  artifacts.set(ref, artifact);
  return artifact;
}

function validateJsonArtifactValue(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

export function readTextArtifact(ref: string): StoredArtifact | undefined {
  const artifact = artifacts.get(ref);
  if (artifact === undefined) {
    return;
  }
  artifacts.delete(ref);
  artifacts.set(ref, artifact);
  return artifact;
}

function evictArtifacts(): void {
  while (artifacts.size > MAX_ARTIFACT_COUNT || retainedBytes > MAX_ARTIFACT_BYTES) {
    const oldestRef = artifacts.keys().next().value as string | undefined;
    if (oldestRef === undefined) {
      return;
    }
    const oldest = artifacts.get(oldestRef);
    artifacts.delete(oldestRef);
    retainedBytes -= oldest?.byteLength ?? 0;
  }
}
