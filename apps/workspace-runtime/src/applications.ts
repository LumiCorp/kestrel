import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath, WorkspaceRequestError } from "./security.js";

export type WorkspaceApplication = {
  id: string;
  name: string;
  command: string;
  workingDirectory: string;
  port: number;
  desiredState: "running" | "stopped";
  status: "starting" | "running" | "stopped" | "failed";
  processId: number | null;
  createdAt: string;
  updatedAt: string;
};

export const WORKSPACE_APPLICATION_TERMINATION_GRACE_MS = 10_000;
const WORKSPACE_APPLICATION_KILL_GRACE_MS = 1_000;
const PROCESS_GROUP_POLL_INTERVAL_MS = 25;

type ApplicationProcess = {
  child: ChildProcess;
  processGroupId: number;
  generation: number;
  exitCode: number | null;
  expectedStop: boolean;
  cleanupError: unknown;
  settled: Promise<void>;
  resolveSettled: () => void;
  shutdownGroup: Promise<void> | null;
  log: Awaited<ReturnType<typeof open>>;
};

export class WorkspaceApplicationRegistry {
  private readonly applications = new Map<string, WorkspaceApplication>();
  private readonly processes = new Map<string, ApplicationProcess>();
  private readonly generations = new Map<string, number>();
  private readonly transitions = new Map<string, Promise<void>>();
  private readonly registryPath: string;
  private readonly workspaceRoot: string;
  private readonly terminationGraceMs: number;

  constructor(
    workspaceRoot: string,
    options: { terminationGraceMs?: number } = {}
  ) {
    this.workspaceRoot = workspaceRoot;
    this.terminationGraceMs =
      options.terminationGraceMs ?? WORKSPACE_APPLICATION_TERMINATION_GRACE_MS;
    this.registryPath = path.join(
      workspaceRoot,
      ".kestrel",
      "applications.json"
    );
  }

  async restore() {
    try {
      const rows = JSON.parse(
        await readFile(this.registryPath, "utf8")
      ) as unknown;
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        const parsed = parseStoredApplication(row);
        if (parsed) {
          this.applications.set(parsed.id, {
            ...parsed,
            status: "stopped",
            processId: null,
          });
        }
      }
    } catch {}
    for (const application of this.applications.values()) {
      if (application.desiredState !== "running") continue;
      await this.start(application.id).catch(async () => {
        Object.assign(application, {
          status: "failed",
          processId: null,
          updatedAt: new Date().toISOString(),
        });
        await this.persist();
      });
    }
  }

  list() {
    return [...this.applications.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  get(id: string) {
    return this.applications.get(id) ?? null;
  }

  async register(value: unknown) {
    const input = await parseRegistration(value, this.workspaceRoot);
    const now = new Date().toISOString();
    const application: WorkspaceApplication = {
      id: randomUUID(),
      ...input,
      desiredState: "running",
      status: "starting",
      processId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.applications.set(application.id, application);
    await this.start(application.id);
    return this.get(application.id)!;
  }

  async start(id: string) {
    return this.transition(id, () => this.startApplication(id));
  }

  async stop(id: string) {
    return this.transition(id, () => this.stopApplication(id));
  }

  async stopAll() {
    await Promise.all(
      [...this.processes.entries()].map(async ([id, runtime]) => {
        runtime.expectedStop = true;
        await this.shutdownRuntime(runtime);
        await runtime.settled;
        if (runtime.cleanupError) {
          throw new WorkspaceRequestError(500, "APPLICATION_STOP_FAILED");
        }
        return this.applications.get(id);
      })
    );
  }

  private async startApplication(id: string): Promise<WorkspaceApplication> {
    const application = this.applications.get(id);
    if (!application)
      throw new WorkspaceRequestError(404, "APPLICATION_NOT_FOUND");
    const existing = this.processes.get(id);
    if (existing) {
      if (
        !existing.expectedStop &&
        existing.child.exitCode === null &&
        existing.child.signalCode === null
      ) {
        return application;
      }
      await existing.settled;
      return this.startApplication(id);
    }
    Object.assign(application, {
      desiredState: "running",
      status: "starting",
      processId: null,
      updatedAt: new Date().toISOString(),
    });
    await this.persist();
    const log = await open(
      path.join(this.workspaceRoot, ".kestrel", `application-${id}.log`),
      "a"
    );
    const child = spawn("/bin/sh", ["-lc", application.command], {
      cwd: await resolveWorkspacePath(
        this.workspaceRoot,
        application.workingDirectory
      ),
      env: { ...process.env, PORT: String(application.port) },
      stdio: ["ignore", log.fd, log.fd],
      detached: true,
    });
    if (child.pid === undefined) {
      await log.close();
      Object.assign(application, {
        status: "failed",
        processId: null,
        updatedAt: new Date().toISOString(),
      });
      await this.persist();
      throw new WorkspaceRequestError(500, "APPLICATION_START_FAILED");
    }
    const generation = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, generation);
    let resolveSettled!: () => void;
    const runtime: ApplicationProcess = {
      child,
      processGroupId: child.pid,
      generation,
      exitCode: null,
      expectedStop: false,
      cleanupError: null,
      settled: new Promise<void>((resolve) => {
        resolveSettled = resolve;
      }),
      resolveSettled,
      shutdownGroup: null,
      log,
    };
    this.processes.set(id, runtime);
    Object.assign(application, {
      status: "running",
      processId: child.pid,
      updatedAt: new Date().toISOString(),
    });
    let childSettled = false;
    const settleChild = (exitCode: number | null) => {
      if (childSettled) return;
      childSettled = true;
      runtime.exitCode = exitCode;
      void this.settleRuntime(id, runtime);
    };
    child.once("error", () => settleChild(null));
    child.once("exit", (exitCode) => settleChild(exitCode));
    await this.persist();
    return application;
  }

  private async stopApplication(id: string): Promise<WorkspaceApplication> {
    const application = this.applications.get(id);
    if (!application)
      throw new WorkspaceRequestError(404, "APPLICATION_NOT_FOUND");
    const runtime = this.processes.get(id);
    Object.assign(application, {
      desiredState: "stopped",
      status: runtime ? application.status : "stopped",
      processId: runtime?.child.pid ?? null,
      updatedAt: new Date().toISOString(),
    });
    await this.persist();
    if (!runtime) return application;
    runtime.expectedStop = true;
    await this.shutdownRuntime(runtime);
    await runtime.settled;
    if (runtime.cleanupError) {
      throw new WorkspaceRequestError(500, "APPLICATION_STOP_FAILED");
    }
    return application;
  }

  private async settleRuntime(id: string, runtime: ApplicationProcess) {
    try {
      await this.shutdownRuntime(runtime);
    } catch (error) {
      runtime.cleanupError = error;
    }
    try {
      if (this.processes.get(id) !== runtime) return;
      this.processes.delete(id);
      const application = this.applications.get(id);
      if (!application || this.generations.get(id) !== runtime.generation) return;
      Object.assign(application, {
        status:
          !runtime.cleanupError &&
          (runtime.expectedStop || runtime.exitCode === 0)
            ? "stopped"
            : "failed",
        processId: null,
        updatedAt: new Date().toISOString(),
      });
      await this.persist();
    } finally {
      await runtime.log.close().catch(() => {});
      runtime.resolveSettled();
    }
  }

  private shutdownRuntime(runtime: ApplicationProcess) {
    runtime.shutdownGroup ??= terminateProcessGroup({
      processGroupId: runtime.processGroupId,
      terminationGraceMs: this.terminationGraceMs,
    });
    return runtime.shutdownGroup;
  }

  private transition<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.transitions.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const settled = current.then(
      () => undefined,
      () => undefined
    );
    this.transitions.set(id, settled);
    return current.finally(() => {
      if (this.transitions.get(id) === settled) this.transitions.delete(id);
    });
  }

  private async persist() {
    await writeFile(
      this.registryPath,
      JSON.stringify(this.list(), null, 2),
      "utf8"
    );
  }
}

async function terminateProcessGroup(input: {
  processGroupId: number;
  terminationGraceMs: number;
}) {
  if (process.platform === "linux") {
    await terminateLinuxProcessGroup(input);
    return;
  }
  signalProcessGroup(input.processGroupId, "SIGTERM");
  if (await waitForProcessGroupExit(input.processGroupId, input.terminationGraceMs)) {
    return;
  }
  signalProcessGroup(input.processGroupId, "SIGKILL");
  if (
    !(await waitForProcessGroupExit(
      input.processGroupId,
      WORKSPACE_APPLICATION_KILL_GRACE_MS
    ))
  ) {
    throw new Error("Application process group did not terminate.");
  }
}

async function terminateLinuxProcessGroup(input: {
  processGroupId: number;
  terminationGraceMs: number;
}) {
  const gracefulDeadline = Date.now() + input.terminationGraceMs;
  const signaled = new Set<number>();
  while (Date.now() < gracefulDeadline) {
    const members = await listLinuxProcessGroupMembers(input.processGroupId);
    const liveMembers = members.filter(isLiveLinuxProcess);
    if (liveMembers.length === 0) return;
    for (const member of leafTerminationTargets(
      input.processGroupId,
      members,
      liveMembers
    )) {
      if (signaled.has(member.processId)) continue;
      signalProcess(member.processId, "SIGTERM");
      signaled.add(member.processId);
    }
    await new Promise((resolve) =>
      setTimeout(resolve, PROCESS_GROUP_POLL_INTERVAL_MS)
    );
  }

  const killDeadline = Date.now() + WORKSPACE_APPLICATION_KILL_GRACE_MS;
  const killed = new Set<number>();
  while (Date.now() < killDeadline) {
    const members = await listLinuxProcessGroupMembers(input.processGroupId);
    const liveMembers = members.filter(isLiveLinuxProcess);
    if (liveMembers.length === 0) return;
    for (const member of leafTerminationTargets(
      input.processGroupId,
      members,
      liveMembers
    )) {
      if (killed.has(member.processId)) continue;
      signalProcess(member.processId, "SIGKILL");
      killed.add(member.processId);
    }
    await new Promise((resolve) =>
      setTimeout(resolve, PROCESS_GROUP_POLL_INTERVAL_MS)
    );
  }

  const remaining = (await listLinuxProcessGroupMembers(input.processGroupId))
    .filter(isLiveLinuxProcess);
  for (const member of remaining) signalProcess(member.processId, "SIGKILL");
  if (
    !(await waitForProcessGroupExit(
      input.processGroupId,
      WORKSPACE_APPLICATION_KILL_GRACE_MS
    ))
  ) {
    throw new Error("Application process group did not terminate.");
  }
}

function signalProcess(processId: number, signal: NodeJS.Signals) {
  try {
    process.kill(processId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals) {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupExit(processGroupId: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (await processGroupHasLiveMembers(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) =>
      setTimeout(resolve, PROCESS_GROUP_POLL_INTERVAL_MS)
    );
  }
  return true;
}

async function processGroupHasLiveMembers(processGroupId: number) {
  if (process.platform === "linux") {
    return (await listLinuxProcessGroupMembers(processGroupId)).some(
      isLiveLinuxProcess
    );
  }

  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

type LinuxProcessGroupMember = {
  processId: number;
  parentProcessId: number;
  state: string;
};

function isLiveLinuxProcess(member: LinuxProcessGroupMember) {
  return member.state !== "Z" && member.state !== "X";
}

function leafTerminationTargets(
  processGroupId: number,
  members: ReadonlyArray<LinuxProcessGroupMember>,
  liveMembers: ReadonlyArray<LinuxProcessGroupMember>
) {
  const descendants = liveMembers.filter(
    (member) => member.processId !== processGroupId
  );
  const candidates = descendants.length > 0 ? descendants : liveMembers;
  return candidates.filter(
    (candidate) =>
      !members.some((member) => member.parentProcessId === candidate.processId)
  );
}

async function listLinuxProcessGroupMembers(processGroupId: number) {
  const members: LinuxProcessGroupMember[] = [];
  const entries = await readdir("/proc", { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const stat = await readFile(`/proc/${entry.name}/stat`, "utf8").catch(
      () => null
    );
    if (stat === null) continue;
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd === -1) continue;
    const [state, parentProcess, processGroup] = stat
      .slice(commandEnd + 2)
      .split(" ");
    if (
      state === undefined ||
      parentProcess === undefined ||
      processGroup === undefined
    ) {
      continue;
    }
    if (Number(processGroup) === processGroupId) {
      members.push({
        processId: Number(entry.name),
        parentProcessId: Number(parentProcess),
        state,
      });
    }
  }
  return members;
}

export async function parseRegistration(value: unknown, workspaceRoot: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkspaceRequestError(400, "APPLICATION_INPUT_INVALID");
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 120 ||
    typeof input.command !== "string" ||
    !input.command.trim() ||
    input.command.length > 2000 ||
    typeof input.port !== "number" ||
    !Number.isInteger(input.port) ||
    input.port < 1024 ||
    input.port > 65_535 ||
    input.port === 43_104 ||
    input.port === 43_105
  ) {
    throw new WorkspaceRequestError(400, "APPLICATION_INPUT_INVALID");
  }
  const workingDirectory =
    typeof input.workingDirectory === "string" ? input.workingDirectory : "";
  await resolveWorkspacePath(workspaceRoot, workingDirectory);
  return {
    name: input.name.trim(),
    command: input.command.trim(),
    workingDirectory,
    port: input.port,
  };
}

function parseStoredApplication(value: unknown): WorkspaceApplication | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" &&
    typeof row.name === "string" &&
    typeof row.command === "string" &&
    typeof row.workingDirectory === "string" &&
    typeof row.port === "number" &&
    typeof row.createdAt === "string" &&
    typeof row.updatedAt === "string" &&
    (row.desiredState === undefined ||
      row.desiredState === "running" ||
      row.desiredState === "stopped")
    ? ({
        ...row,
        desiredState: row.desiredState ?? "running",
      } as WorkspaceApplication)
    : null;
}
