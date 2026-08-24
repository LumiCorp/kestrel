/**
 * Returns the complete source for the Kestrel-owned, single-payload download
 * process. The tool writes this source into its generated staging directory so
 * the managed Workspace process does not depend on a model-selected command or
 * a system-installed server.
 */
export function buildWorkspaceFileShareServerSource(): string {
  return `const __name = (value) => value;\n(${workspaceFileShareServerMain.toString()})();\n`;
}

async function workspaceFileShareServerMain(): Promise<void> {
  const fs = await import("node:fs");
  const fsPromises = await import("node:fs/promises");
  const http = await import("node:http");
  const path = await import("node:path");

  const encodedConfig = process.argv[2];
  if (!encodedConfig) {
    throw new Error("Missing Kestrel file-share server configuration.");
  }
  const config = JSON.parse(
    Buffer.from(encodedConfig, "base64url").toString("utf8"),
  ) as {
    stagePath: string;
    payloadPath: string;
    downloadName: string;
    mediaType: string;
  };
  const payload = await fsPromises.open(
    config.payloadPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  const payloadStat = await payload.stat();
  if (!payloadStat.isFile()) {
    await payload.close();
    throw new Error("Kestrel file-share payload is not a regular file.");
  }
  const route = `/${encodeURIComponent(config.downloadName)}`;
  const fallbackName = config.downloadName
    .replace(/[\u0000-\u001f\u007f"\\]/gu, "_")
    .replace(/[^\x20-\x7e]/gu, "_");
  const encodedName = encodeURIComponent(config.downloadName).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const disposition =
    `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`;

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== route || requestUrl.search.length > 0) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found.\n");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, {
        allow: "GET, HEAD",
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("Method not allowed.\n");
      return;
    }

    const range = parseRange(request.headers.range, payloadStat.size);
    if (range === "invalid") {
      response.writeHead(416, {
        "accept-ranges": "bytes",
        "content-range": `bytes */${payloadStat.size}`,
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      });
      response.end("Range not satisfiable.\n");
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, payloadStat.size - 1);
    const contentLength = payloadStat.size === 0 ? 0 : end - start + 1;
    const headers: Record<string, string | number> = {
      "accept-ranges": "bytes",
      "content-disposition": disposition,
      "content-length": contentLength,
      "content-type": config.mediaType,
      "x-content-type-options": "nosniff",
    };
    if (range !== undefined) {
      headers["content-range"] = `bytes ${start}-${end}/${payloadStat.size}`;
    }
    response.writeHead(range === undefined ? 200 : 206, headers);
    if (request.method === "HEAD" || payloadStat.size === 0) {
      response.end();
      return;
    }
    const stream = fs.createReadStream(config.payloadPath, {
      fd: payload.fd,
      autoClose: false,
      start,
      end,
    });
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  });

  let shuttingDown = false;
  const shutdown = async (exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceClose = setTimeout(() => server.closeAllConnections(), 2_000);
    forceClose.unref();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearTimeout(forceClose);
    await payload.close().catch(() => undefined);
    await fsPromises.rm(config.stagePath, { recursive: true, force: true })
      .catch(() => undefined);
    process.exitCode = exitCode;
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.once(signal, () => void shutdown(0));
  }
  process.once("uncaughtException", () => void shutdown(1));
  process.once("unhandledRejection", () => void shutdown(1));

  server.listen(0, "127.0.0.1", async () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      await shutdown(1);
      return;
    }
    await fsPromises.unlink(config.payloadPath);
    await fsPromises.unlink(process.argv[1] ?? "").catch(() => undefined);
    process.stdout.write(
      `KESTREL_FILE_SHARE_READY ${JSON.stringify({ port: address.port })}\n`,
    );
  });

  function parseRange(
    header: string | undefined,
    size: number,
  ): { start: number; end: number } | "invalid" | undefined {
    if (header === undefined) return undefined;
    if (!header.startsWith("bytes=") || header.includes(",") || size === 0) {
      return "invalid";
    }
    const match = /^bytes=(\d*)-(\d*)$/u.exec(header);
    if (match === null || (match[1] === "" && match[2] === "")) {
      return "invalid";
    }
    if (match[1] === "") {
      const suffixLength = Number(match[2]);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
        return "invalid";
      }
      return {
        start: Math.max(0, size - suffixLength),
        end: size - 1,
      };
    }
    const start = Number(match[1]);
    const requestedEnd = match[2] === "" ? size - 1 : Number(match[2]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(requestedEnd) ||
      start < 0 ||
      requestedEnd < start ||
      start >= size
    ) {
      return "invalid";
    }
    return { start, end: Math.min(requestedEnd, size - 1) };
  }
}
