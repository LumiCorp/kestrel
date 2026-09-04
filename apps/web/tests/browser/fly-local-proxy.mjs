import { createServer, request as upstreamRequest } from "node:http";
import { createHash } from "node:crypto";

const capabilities = new Set(["open", "snapshot", "inspect", "interact", "navigate", "tabs", "capture", "request_takeover", "close", "request_grant", "upload", "download"]);
const actions = new Set(["policy", "accept", "invoke", "complete", "unknown", "commit", "artifact", "adopt", "adopt-complete", "startup-failed", "prepare-upload", "prepare-download", "release-download"]);

export function permittedRequest(method, rawUrl, environmentId) {
  if (method === "GET" && rawUrl === `/api/runtime/environments/${environmentId}/gateway/config`) return true;
  const parts = rawUrl.split("/");
  return method === "POST" && parts.length === 9 &&
    parts.slice(0, 5).join("/") === "/api/runtime/apps/built_in.browser" &&
    capabilities.has(parts[5]) && ["auto", "confirmed"].includes(parts[6]) &&
    parts[7] === "control" && actions.has(parts[8]);
}

export function createFlyLocalProxy({ environmentId, webPort }) {
  const uploads = [];
  const download = Buffer.from("Kestrel Fly transfer fixture: exact bytes\n");
  const server = createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    if (req.method === "GET" && req.url === "/fixture") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end('<!doctype html><title>Kestrel transfer fixture</title><h1>Kestrel transfer fixture</h1><label>Attachment <input type="file" aria-label="Attachment" onchange="fetch(\'/fixture/upload\',{method:\'POST\',body:this.files[0]}).then(r=>r.json()).then(receipt=>{document.querySelector(\'#status\').textContent=JSON.stringify(receipt)})"></label><p id="status">Ready</p><a href="/fixture/download" download>Download fixture</a>');
      return;
    }
    if (req.method === "GET" && req.url === "/fixture/download") {
      res.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="fixture.txt"', "content-length": download.length });
      res.end(download);
      return;
    }
    if (req.method === "POST" && req.url === "/fixture/upload") {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 64 * 1024 || uploads.length >= 16) throw new Error("fixture limit");
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        uploads.push(bytes);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          receivedBytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }));
      } catch { res.writeHead(413).end(); }
      return;
    }
    if (!permittedRequest(req.method, req.url ?? "", environmentId)) {
      res.writeHead(404).end();
      return;
    }
    const upstream = upstreamRequest({
      hostname: "127.0.0.1", port: webPort, path: req.url, method: req.method,
      headers: Object.fromEntries(["authorization", "content-type", "content-length"].flatMap(name =>
        req.headers[name] === undefined ? [] : [[name, req.headers[name]]])),
    }, response => {
      res.writeHead(response.statusCode ?? 502, { "content-type": response.headers["content-type"] ?? "application/json" });
      response.pipe(res);
    });
    upstream.setTimeout(150_000, () => upstream.destroy());
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });
    req.on("error", () => upstream.destroy());
    req.pipe(upstream);
  });
  return { server, uploads, download };
}
