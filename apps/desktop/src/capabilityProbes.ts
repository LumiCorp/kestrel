import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { promisify } from "node:util";

import type { DesktopCapabilityProbeResults } from "../../../src/desktopShell/capabilityRegistry.js";
import type {
  DesktopMcpServerConfig,
  DesktopMicrophoneAccessState,
  DesktopProjectRegistration,
  DesktopSettings,
} from "./contracts.js";
import { verifyDesktopModelCapability } from "./modelProviderVerification.js";

const execFileAsync = promisify(execFile);

export async function probeDesktopCapabilities(input: {
  projects: readonly DesktopProjectRegistration[];
  databaseReady: boolean;
  microphone: DesktopMicrophoneAccessState;
  mcpServers: DesktopMcpServerConfig[];
  settings: DesktopSettings;
  env?: NodeJS.ProcessEnv | undefined;
}): Promise<DesktopCapabilityProbeResults> {
  const env = input.env ?? process.env;
  const shellPath = input.settings.developerShellPath ?? env.SHELL;
  const executablePath = input.settings.developerPath ?? env.PATH;
  const commandEnv = { ...env, ...(shellPath !== undefined ? { SHELL: shellPath } : {}), ...(executablePath !== undefined ? { PATH: executablePath } : {}) };
  const [filesystemAccessible, shellAvailable, docker, ollamaReady, lmstudioReady, languageRuntimes, packageManagers] = await Promise.all([
    hasAccessibleProject(input.projects),
    hasAccessibleShell(shellPath),
    probeDocker(commandEnv),
    probeLocalModel("ollama", input.settings),
    probeLocalModel("lmstudio", input.settings),
    probeExecutables(["node", "python3", "ruby", "go"], commandEnv),
    probeExecutables(["pnpm", "npm", "yarn", "uv", "pip3"], commandEnv),
  ]);
  return {
    filesystemAccessible,
    shellAvailable,
    ...(shellPath !== undefined ? { shellPath } : {}),
    ...(executablePath !== undefined ? { executablePath } : {}),
    languageRuntimes,
    packageManagers,
    dockerInstalled: docker.installed,
    dockerDaemonReachable: docker.daemonReachable,
    dockerImages: docker.images,
    databaseReady: input.databaseReady,
    microphone: input.microphone,
    mcpServers: input.mcpServers,
    localModelProviders: { ollama: ollamaReady, lmstudio: lmstudioReady },
  };
}

async function probeLocalModel(
  provider: "ollama" | "lmstudio",
  settings: DesktopSettings,
): Promise<boolean> {
  try {
    await verifyDesktopModelCapability({ provider, settings, timeoutMs: 1_200 });
    return true;
  } catch {
    return false;
  }
}

async function hasAccessibleProject(
  projects: readonly DesktopProjectRegistration[],
): Promise<boolean> {
  for (const project of projects) {
    try {
      await access(project.path, constants.R_OK);
      return true;
    } catch {
      // Continue through the explicit registered-project inventory.
    }
  }
  return false;
}

async function hasAccessibleShell(shellPath: string | undefined): Promise<boolean> {
  if (shellPath === undefined || shellPath.trim().length === 0) {
    return false;
  }
  try {
    await access(shellPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function probeDocker(env: NodeJS.ProcessEnv): Promise<{ installed: boolean; daemonReachable: boolean; images: { name: string; available: boolean }[] }> {
  const requiredImages = ["node:20-alpine", "python:3.12-alpine", "bash:5.2"];
  try {
    await execFileAsync("docker", ["version", "--format", "{{.Client.Version}}"], {
      timeout: 2_500,
      windowsHide: true,
      env,
    });
  } catch {
    return { installed: false, daemonReachable: false, images: requiredImages.map((name) => ({ name, available: false })) };
  }
  try {
    await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 3_500,
      windowsHide: true,
      env,
    });
    const { stdout } = await execFileAsync("docker", ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"], { timeout: 3_500, windowsHide: true, env });
    const available = new Set(stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean));
    return { installed: true, daemonReachable: true, images: requiredImages.map((name) => ({ name, available: available.has(name) })) };
  } catch {
    return { installed: true, daemonReachable: false, images: requiredImages.map((name) => ({ name, available: false })) };
  }
}

async function probeExecutables(names: string[], env: NodeJS.ProcessEnv): Promise<{ name: string; available: boolean }[]> {
  return await Promise.all(names.map(async (name) => {
    try {
      await execFileAsync(name, ["--version"], { timeout: 1_500, windowsHide: true, env });
      return { name, available: true };
    } catch {
      return { name, available: false };
    }
  }));
}
