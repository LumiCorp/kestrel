import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { BROWSER_RUNTIME_RELEASE_MANIFEST } from "./runtimeReleaseManifest.js";

const execFileAsync = promisify(execFile);
export const HOSTED_BROWSER_VERSION_PROBE_TIMEOUT_MS = 15_000;
export const HOSTED_BROWSER_VERSION_PROBE_MAX_BUFFER_BYTES = 16 * 1024;

export type HostedBrowserRuntimeMeasurement = {
  engineRevision: string;
  chromeRevision: string;
};

export type HostedBrowserVersionProbe = (
  executablePath: string,
  args: readonly string[],
  options: {
    timeoutMs: number;
    maxBufferBytes: number;
  },
) => Promise<{ stdout: string; stderr: string }>;

export async function measureHostedBrowserWorkerRuntime(input: {
  engineExecutablePath: string;
  chromeExecutablePath: string;
  probe?: HostedBrowserVersionProbe | undefined;
}): Promise<HostedBrowserRuntimeMeasurement> {
  const probe = input.probe ?? probeExecutableVersion;
  const probeOptions = {
    timeoutMs: HOSTED_BROWSER_VERSION_PROBE_TIMEOUT_MS,
    maxBufferBytes: HOSTED_BROWSER_VERSION_PROBE_MAX_BUFFER_BYTES,
  };
  const [engine, chrome] = await Promise.all([
    runVersionProbe("engine", input.engineExecutablePath, probe, probeOptions),
    runVersionProbe("Chrome", input.chromeExecutablePath, probe, probeOptions),
  ]);
  const engineRevision = BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision;
  const chromeRevision = BROWSER_RUNTIME_RELEASE_MANIFEST.chrome.revision;
  const expectedEngineOutput =
    `agent-browser ${engineRevision.replace(/^v/u, "")}`;
  const expectedChromeOutput = `Google Chrome for Testing ${chromeRevision}`;
  assertExactVersionOutput("engine", engine, expectedEngineOutput);
  assertExactVersionOutput("Chrome", chrome, expectedChromeOutput);
  return { engineRevision, chromeRevision };
}

function assertExactVersionOutput(
  label: "engine" | "Chrome",
  measured: { stdout: string; stderr: string },
  expectedStdout: string,
): void {
  if (
    measured.stdout.trim() !== expectedStdout ||
    measured.stderr.trim() !== ""
  ) {
    throw new Error(
      `Hosted Browser ${label} version output does not match the pinned release manifest.`,
    );
  }
}

async function probeExecutableVersion(
  executablePath: string,
  args: readonly string[],
  options: {
    timeoutMs: number;
    maxBufferBytes: number;
  },
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(executablePath, [...args], {
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: options.maxBufferBytes,
    windowsHide: true,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function runVersionProbe(
  label: "engine" | "Chrome",
  executablePath: string,
  probe: HostedBrowserVersionProbe,
  options: { timeoutMs: number; maxBufferBytes: number },
) {
  try {
    return await probe(executablePath, ["--version"], options);
  } catch (error) {
    const timedOut = isProbeTimeout(error);
    throw new Error(
      timedOut
        ? `Hosted Browser ${label} version probe timed out after ${options.timeoutMs}ms.`
        : `Hosted Browser ${label} version probe failed.`,
    );
  }
}

function isProbeTimeout(error: unknown): boolean {
  if (!(error && typeof error === "object")) return false;
  const record = error as Record<string, unknown>;
  return record.killed === true ||
    record.code === "ETIMEDOUT" ||
    record.signal === "SIGTERM";
}
