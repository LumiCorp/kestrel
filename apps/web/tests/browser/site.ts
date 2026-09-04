import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export async function createSite() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "browser-site-"));
  const certificate = path.join(directory, "fixture.pem");
  const key = path.join(directory, "fixture.key");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=Browser local fixture",
      "-addext",
      "subjectAltName=DNS:example.com,DNS:example.net",
      "-keyout",
      key,
      "-out",
      certificate,
    ],
    { stdio: "ignore" },
  );
  const uploads: Buffer[] = [];
  const submissions: string[] = [];
  const secretProofs: Record<string, string> = {};
  const download = Buffer.from(
    "Kestrel approved download: exact fixture bytes\n",
  );
  let releaseDownload: (() => void) | undefined;
  let downloadStarted = false;
  const server = createServer(
    { key: await readFile(key), cert: await readFile(certificate) },
    async (request, response) => {
      if (
        request.url === "/upload" ||
        request.url === "/submit" ||
        request.url === "/secret-proof"
      ) {
        const parts: Buffer[] = [];
        for await (const part of request) parts.push(Buffer.from(part));
        const bytes = Buffer.concat(parts);
        if (request.url === "/upload") uploads.push(bytes);
        else if (request.url === "/submit") submissions.push(bytes.toString());
        else Object.assign(secretProofs, JSON.parse(bytes.toString()));
        response.end("received");
      } else if (request.url === "/download") {
        response.writeHead(200, {
          "content-type": "text/plain",
          "content-disposition": 'attachment; filename="fixture.txt"',
          "content-length": download.length,
        });
        downloadStarted = true;
        response.write(download.subarray(0, 1));
        releaseDownload = () => {
          response.end(download.subarray(1));
          releaseDownload = undefined;
          downloadStarted = false;
        };
      } else {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<!doctype html><html><head><title>Browser fixture</title></head><body>
<h1>Connected Browser fixture</h1><p id="status">Not clicked</p>
<button onclick="document.querySelector('#status').textContent='Clicked successfully'">Change status</button>
<label>Message <input aria-label="Message" id="message"></label>
<button onclick="fetch('/submit',{method:'POST',body:document.querySelector('#message').value}).then(()=>document.querySelector('#status').textContent='Submitted successfully')">Submit message</button>
<label style="position:absolute;top:300px;left:10px">Password <input aria-label="Password" type="password" autocomplete="current-password" id="password" style="display:block;width:240px;height:24px" oninput="prove(this)"></label>
<label style="position:absolute;top:370px;left:10px">OTP <input aria-label="OTP" autocomplete="one-time-code" inputmode="numeric" id="otp" style="display:block;width:240px;height:24px" oninput="prove(this)"></label>
<label style="position:absolute;top:440px;left:10px">Personal note <input aria-label="Personal note" id="note" style="display:block;width:240px;height:24px" oninput="prove(this)"></label>
<label>Attachment <input aria-label="Attachment" id="file" type="file" onchange="fetch('/upload',{method:'POST',body:this.files[0]}).then(()=>document.querySelector('#status').textContent='Uploaded successfully')"></label>
<a href="/download" download>Download fixture</a>
<script>async function prove(element){const bytes=new TextEncoder().encode(element.value);const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');await fetch('/secret-proof',{method:'POST',body:JSON.stringify({[element.id]:hash})});}</script>
</body></html>`);
      }
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  return {
    certificate,
    uploads,
    submissions,
    secretProofs,
    download,
    get downloadStarted() {
      return downloadStarted;
    },
    finishDownload() {
      assert.ok(releaseDownload, "a fixture download must be in progress");
      releaseDownload();
    },
    async resolve(hostname: string) {
      assert.ok(
        ["example.com", "example.net"].includes(hostname),
        "only fixed fixture origins may resolve",
      );
      return [{ address: "93.184.216.34", family: 4 as const }];
    },
    dial(input: { address: { address: string }; port: number }) {
      assert.equal(input.address.address, "93.184.216.34");
      assert.equal(input.port, 443);
      return net.connect({ host: "127.0.0.1", port });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
