import { WORKSPACE_READINESS_TIMEOUT_MS } from "@lumi/kestrel-environment-auth";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

const BACKUP_CHUNK_BYTES = 512 * 1024;

export async function uploadBackupArchive(input: {
  route: () => { baseUrl: string; authToken: string };
  archive: Buffer;
  checksumSha256: string;
  fetchImpl?: typeof fetch | undefined;
}) {
  return uploadBackupArchiveStream({
    ...input,
    archive: Readable.from(input.archive),
  });
}

export async function uploadBackupArchiveStream(input: {
  route: () => { baseUrl: string; authToken: string };
  archive: NodeJS.ReadableStream;
  checksumSha256: string;
  fetchImpl?: typeof fetch | undefined;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const createRoute = input.route();
  const createResponse = await fetchImpl(
    new URL("/v1/backups/imports", createRoute.baseUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${createRoute.authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ checksumSha256: input.checksumSha256 }),
      cache: "no-store",
    },
  );
  const created = (await createResponse.json().catch(() => null)) as {
    id?: string;
  } | null;
  if (!(createResponse.ok && created?.id)) {
    throw new Error("Workspace backup import could not start.");
  }
  const importId = created.id;
  try {
    let chunkIndex = 0;
    let pending = Buffer.alloc(0);
    const checksum = createHash("sha256");
    const uploadChunk = async (chunk: Buffer, index: number) => {
      const chunkRoute = input.route();
      const response = await fetchImpl(
        new URL(
          `/v1/backups/imports/${importId}/chunks/${index}`,
          chunkRoute.baseUrl,
        ),
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${chunkRoute.authToken}`,
            "content-type": "application/octet-stream",
          },
          body: new Uint8Array(chunk),
          cache: "no-store",
        },
      );
      if (!response.ok) throw new Error("Workspace backup chunk was rejected.");
    };
    for await (const value of input.archive) {
      const incoming = Buffer.isBuffer(value) ? value : Buffer.from(value);
      checksum.update(incoming);
      pending = Buffer.concat([pending, incoming]);
      while (pending.length >= BACKUP_CHUNK_BYTES) {
        await uploadChunk(pending.subarray(0, BACKUP_CHUNK_BYTES), chunkIndex);
        pending = pending.subarray(BACKUP_CHUNK_BYTES);
        chunkIndex += 1;
      }
    }
    if (pending.length > 0) await uploadChunk(pending, chunkIndex);
    if (checksum.digest("hex") !== input.checksumSha256) {
      throw Object.assign(
        new Error("Workspace backup checksum verification failed."),
        { code: "WORKSPACE_BACKUP_CHECKSUM_MISMATCH" },
      );
    }
    const completeRoute = input.route();
    const completeResponse = await fetchImpl(
      new URL(
        `/v1/backups/imports/${importId}/complete`,
        completeRoute.baseUrl,
      ),
      {
        method: "POST",
        headers: { authorization: `Bearer ${completeRoute.authToken}` },
        cache: "no-store",
      },
    );
    if (!completeResponse.ok) {
      throw new Error("Workspace backup import did not complete.");
    }
  } catch (error) {
    const abortRoute = input.route();
    await fetchImpl(
      new URL(`/v1/backups/imports/${importId}`, abortRoute.baseUrl),
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${abortRoute.authToken}` },
        cache: "no-store",
      },
    ).catch(() => {});
    throw error;
  }
}

export async function waitForWorkspaceService(
  route: () => { baseUrl: string; authToken: string },
  input: {
    fetchImpl?: typeof fetch | undefined;
    timeoutMs?: number | undefined;
    pollIntervalMs?: number | undefined;
  } = {},
) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const deadline =
    Date.now() + (input.timeoutMs ?? WORKSPACE_READINESS_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const current = route();
    const response = await fetchImpl(new URL("/v1/apps", current.baseUrl), {
      headers: { authorization: `Bearer ${current.authToken}` },
      cache: "no-store",
    }).catch(() => null);
    if (response?.ok) return;
    await new Promise((resolve) =>
      setTimeout(resolve, input.pollIntervalMs ?? 500),
    );
  }
  throw new Error("Replacement Workspace service did not become healthy.");
}
