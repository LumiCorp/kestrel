import assert from "node:assert/strict";
import test from "node:test";
import { uploadBackupArchive } from "./backup-transfer";

test("backup transfer stays within bounded gateway requests and refreshes tickets", async () => {
  const requests: Array<{
    pathname: string;
    method: string;
    authorization: string | null;
    bodyBytes: number;
  }> = [];
  let ticket = 0;
  const fetchImpl = (async (
    request: string | URL | Request,
    init?: RequestInit
  ) => {
    const body = init?.body;
    requests.push({
      pathname: new URL(String(request)).pathname,
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
      bodyBytes:
        body instanceof Uint8Array
          ? body.byteLength
          : typeof body === "string"
            ? Buffer.byteLength(body)
            : 0,
    });
    return new URL(String(request)).pathname === "/v1/backups/imports"
      ? Response.json({ id: "import-1" }, { status: 201 })
      : Response.json({ ok: true });
  }) as typeof fetch;
  await uploadBackupArchive({
    route: () => ({
      baseUrl: "https://router.example",
      authToken: `ticket-${++ticket}`,
    }),
    archive: Buffer.alloc(1_200_000, 1),
    checksumSha256: "a".repeat(64),
    fetchImpl,
  });
  const chunks = requests.filter((request) => request.method === "PUT");
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((request) => request.bodyBytes <= 512 * 1024));
  assert.equal(
    new Set(requests.map((request) => request.authorization)).size,
    5
  );
  assert.equal(
    requests.at(-1)?.pathname,
    "/v1/backups/imports/import-1/complete"
  );
});

test("failed backup transfer aborts the import", async () => {
  const methods: string[] = [];
  const fetchImpl = (async (
    request: string | URL | Request,
    init?: RequestInit
  ) => {
    methods.push(init?.method ?? "GET");
    const pathname = new URL(String(request)).pathname;
    if (pathname === "/v1/backups/imports") {
      return Response.json({ id: "import-1" }, { status: 201 });
    }
    if (init?.method === "PUT") {
      return Response.json({ error: true }, { status: 409 });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
  await assert.rejects(
    uploadBackupArchive({
      route: () => ({
        baseUrl: "https://router.example",
        authToken: "ticket",
      }),
      archive: Buffer.from("archive"),
      checksumSha256: "a".repeat(64),
      fetchImpl,
    })
  );
  assert.deepEqual(methods, ["POST", "PUT", "DELETE"]);
});
