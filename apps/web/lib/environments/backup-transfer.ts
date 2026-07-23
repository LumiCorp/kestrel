import { WORKSPACE_READINESS_TIMEOUT_MS } from "@lumi/kestrel-environment-auth";

const BACKUP_CHUNK_BYTES = 512 * 1024;

export async function uploadBackupArchive(input: {
  route: () => { baseUrl: string; authToken: string };
  archive: Buffer;
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
    }
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
    for (
      let offset = 0;
      offset < input.archive.length;
      offset += BACKUP_CHUNK_BYTES
    ) {
      const chunkRoute = input.route();
      const response = await fetchImpl(
        new URL(
          `/v1/backups/imports/${importId}/chunks/${chunkIndex}`,
          chunkRoute.baseUrl
        ),
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${chunkRoute.authToken}`,
            "content-type": "application/octet-stream",
          },
          body: new Uint8Array(
            input.archive.subarray(offset, offset + BACKUP_CHUNK_BYTES)
          ),
          cache: "no-store",
        }
      );
      if (!response.ok) throw new Error("Workspace backup chunk was rejected.");
      chunkIndex += 1;
    }
    const completeRoute = input.route();
    const completeResponse = await fetchImpl(
      new URL(
        `/v1/backups/imports/${importId}/complete`,
        completeRoute.baseUrl
      ),
      {
        method: "POST",
        headers: { authorization: `Bearer ${completeRoute.authToken}` },
        cache: "no-store",
      }
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
      }
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
  } = {}
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
      setTimeout(resolve, input.pollIntervalMs ?? 500)
    );
  }
  throw new Error("Replacement Workspace service did not become healthy.");
}
