import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { BROWSER_RUNTIME_RELEASE_MANIFEST } from "./runtimeReleaseManifest.js";

const execFileAsync = promisify(execFile);
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const VERSION_PROBE_MAX_BUFFER_BYTES = 16 * 1024;

export type HostedBrowserRuntimeMeasurement = {
  engineRevision: string;
  chromeRevision: string;
};

export type HostedBrowserVersionProbe = (
  executablePath: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export async function measureHostedBrowserWorkerRuntime(input: {
  engineExecutablePath: string;
  chromeExecutablePath: string;
  probe?: HostedBrowserVersionProbe | undefined;
}): Promise<HostedBrowserRuntimeMeasurement> {
  const probe = input.probe ?? probeExecutableVersion;
  const [engine, chrome] = await Promise.all([
    probe(input.engineExecutablePath, ["--version"]),
    probe(input.chromeExecutablePath, ["--version"]),
  ]).catch(() => {
    throw new Error("Hosted Browser runtime measurement failed.");
  });
  const engineRevision = BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision;
  const chromeRevision = BROWSER_RUNTIME_RELEASE_MANIFEST.chrome.revision;
  const expectedEngineOutput =
    `agent-browser ${engineRevision.replace(/^v/u, "")}`;
  const expectedChromeOutput = `Google Chrome for Testing ${chromeRevision}`;
  if (
    engine.stdout.trim() !== expectedEngineOutput ||
    engine.stderr.trim() !== "" ||
    chrome.stdout.trim() !== expectedChromeOutput ||
    chrome.stderr.trim() !== ""
  ) {
    throw new Error("Hosted Browser runtime does not match the pinned release manifest.");
  }
  return { engineRevision, chromeRevision };
}

async function probeExecutableVersion(
  executablePath: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(executablePath, [...args], {
    encoding: "utf8",
    timeout: VERSION_PROBE_TIMEOUT_MS,
    maxBuffer: VERSION_PROBE_MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}
