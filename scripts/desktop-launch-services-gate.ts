import path from "node:path";

export interface LaunchServicesOpenInput {
  appPath: string;
  userDataPath: string;
  debugPort: number;
  environment: Readonly<Record<string, string>>;
  applicationArguments?: readonly string[] | undefined;
}

export type LaunchServicesCleanupAction = () => void | Promise<void>;

export async function runLaunchServicesCleanupActions(
  actions: ReadonlyArray<LaunchServicesCleanupAction>,
): Promise<void> {
  const errors: Error[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      errors.push(toError(error));
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "Signed LaunchServices gate cleanup failed.",
    );
  }
}

export function resolveLaunchServicesInstalledAppPath(input: {
  applicationsRoot?: string | undefined;
  version: string;
  runId: string;
}): string {
  const applicationsRoot = path.resolve(input.applicationsRoot ?? "/Applications");
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(input.version)) {
    throw new Error(`Invalid Desktop version '${input.version}'.`);
  }
  if (!/^[A-Za-z0-9-]+$/u.test(input.runId)) {
    throw new Error(`Invalid LaunchServices gate run ID '${input.runId}'.`);
  }
  return path.join(
    applicationsRoot,
    `Kestrel LaunchServices Gate ${input.version} ${input.runId}.app`,
  );
}

export function buildLaunchServicesOpenArguments(
  input: LaunchServicesOpenInput,
): string[] {
  if (!path.isAbsolute(input.appPath)) {
    throw new Error("LaunchServices app path must be absolute.");
  }
  if (!path.isAbsolute(input.userDataPath)) {
    throw new Error("LaunchServices user-data path must be absolute.");
  }
  if (
    !Number.isInteger(input.debugPort) ||
    input.debugPort < 1 ||
    input.debugPort > 65_535
  ) {
    throw new Error(`Invalid remote-debugging port '${input.debugPort}'.`);
  }
  const environment = Object.entries(input.environment).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  for (const [name, value] of environment) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) {
      throw new Error(`Invalid LaunchServices environment name '${name}'.`);
    }
    if (value.includes("\0")) {
      throw new Error(`LaunchServices environment '${name}' contains NUL.`);
    }
  }
  const applicationArguments = input.applicationArguments ?? [];
  for (const argument of applicationArguments) {
    if (!argument.startsWith("--") || argument.includes("\0")) {
      throw new Error(
        `Invalid LaunchServices application argument '${argument}'.`,
      );
    }
  }
  return [
    "-n",
    "-W",
    "--fresh",
    ...environment.flatMap(([name, value]) => ["--env", `${name}=${value}`]),
    "-a",
    input.appPath,
    "--args",
    `--user-data-dir=${input.userDataPath}`,
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${input.debugPort}`,
    ...applicationArguments,
  ];
}

export function listExecutableProcessIds(
  processList: string,
  executablePath: string,
  requiredArguments: readonly string[] = [],
): number[] {
  const normalizedPath = path.resolve(executablePath);
  const pids: number[] = [];
  for (const line of processList.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (
      match?.[1] === undefined ||
      match[2]?.includes(normalizedPath) !== true ||
      requiredArguments.some((argument) => !match[2]!.includes(argument))
    ) {
      continue;
    }
    const pid = Number.parseInt(match[1], 10);
    if (Number.isInteger(pid) && pid > 0) {
      pids.push(pid);
    }
  }
  return [...new Set(pids)].sort((left, right) => left - right);
}

export function parseCodeSignatureDetails(value: string): {
  authority: string;
  teamIdentifier: string;
  hardenedRuntime: true;
} {
  const authority = /^Authority=(Developer ID Application:.+)$/mu.exec(
    value,
  )?.[1];
  if (authority === undefined) {
    throw new Error(
      "Installed Desktop must have a Developer ID Application signature.",
    );
  }
  const teamIdentifier = /^TeamIdentifier=(\S+)$/mu.exec(value)?.[1];
  if (teamIdentifier === undefined || teamIdentifier === "not set") {
    throw new Error("Installed Desktop signature must include a team identifier.");
  }
  if (!/flags=.*\([^)]*\bruntime\b[^)]*\)/u.test(value)) {
    throw new Error("Installed Desktop signature must enable hardened runtime.");
  }
  return {
    authority,
    teamIdentifier,
    hardenedRuntime: true,
  };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
