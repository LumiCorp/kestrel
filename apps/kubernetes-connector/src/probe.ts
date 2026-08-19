import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function runQualificationProbe(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const nonce = requireValue(environment.QUALIFICATION_NONCE, "QUALIFICATION_NONCE");
  const noncePath = environment.QUALIFICATION_NONCE_PATH ?? "/workspace/.kestrel-qualification-nonce";
  if (environment.QUALIFICATION_READ_ONLY === "true") {
    const stored = (await readFile(noncePath, "utf8")).trim();
    if (stored !== nonce) throw new Error("Qualification nonce restore mismatch.");
  } else {
    await mkdir(dirname(noncePath), { recursive: true });
    await writeFile(noncePath, nonce, { mode: 0o600 });
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/health") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ready: true, nonce }));
  });
  server.listen(8080, "0.0.0.0");
}

export async function runNetworkProbe(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const target = requireValue(environment.PROBE_TARGET, "PROBE_TARGET");
  const expectation = environment.PROBE_EXPECT;
  if (expectation !== "success" && expectation !== "failure") {
    throw new Error("PROBE_EXPECT must be success or failure.");
  }
  let succeeded = false;
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(5_000) });
    succeeded = response.ok;
    await response.body?.cancel();
  } catch {}
  if ((expectation === "success") !== succeeded) {
    throw new Error(`Network probe expected ${expectation}.`);
  }
}

export async function runNetworkProbeServer(
  environment: NodeJS.ProcessEnv = process.env,
) {
  await runNetworkProbe(environment);
  const server = createServer((_, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ready: true }));
  });
  server.listen(8080, "0.0.0.0");
}

function requireValue(value: string | undefined, label: string) {
  const result = value?.trim();
  if (!result) throw new Error(`${label} is required.`);
  return result;
}
