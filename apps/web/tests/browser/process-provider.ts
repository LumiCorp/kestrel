import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type {
  BrowserMachineInfrastructureProvider,
  BrowserMachineProvisioningInput,
  EnvironmentProviderMachine,
} from "../../lib/environments/providers/contracts.js";

export class ProcessBrowserProvider implements BrowserMachineInfrastructureProvider {
  readonly records = new Map<
    string,
    {
      child: ChildProcess;
      directory: string;
      machine: EnvironmentProviderMachine;
      port: number;
    }
  >();
  constructor(private readonly certificate: string) {}

  async createBrowserMachine(input: BrowserMachineProvisioningInput) {
    assert.equal(input.appName, "browser-test");
    const id = `worker-${randomUUID()}`;
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-process-"));
    const config = {
      ...input,
      imageDigest: input.runtimeImageDigest,
      port: 0,
      gatewayHost: "gateway.vm.browser-test.internal",
      gatewayAddress: "127.0.0.1",
      gatewayPort: 43109,
      engineExecutablePath: "/opt/kestrel/browser-runtime/agent-browser",
      chromeExecutablePath: "/opt/kestrel/browser-runtime/chrome/chrome",
    };
    const configPath = path.join(directory, "worker.json");
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const child = fork(
      new URL("./worker.ts", import.meta.url),
      [configPath, path.join(directory, "profile"), this.certificate],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      },
    );
    const machine: EnvironmentProviderMachine = {
      id,
      state: "starting",
      region: input.region,
      image: input.runtimeImageDigest,
      resolvedImageDigest: input.runtimeImageDigest.split("@").at(-1),
      browserSessionId: input.sessionId,
      browserGeneration: input.generation,
      mounts: [],
    };
    const record = { child, directory, machine, port: 0 };
    this.records.set(id, record);
    const ready = await Promise.race([
      once(child, "message", { signal: AbortSignal.timeout(120_000) }).then(
        ([message]) => message as { ready: boolean; port: number },
      ),
      once(child, "exit").then(([code]) => {
        throw new Error(
          `Browser test worker exited before readiness (${code})`,
        );
      }),
    ]);
    assert.equal(ready.ready, true);
    record.port = ready.port;
    machine.state = "started";
    return machine;
  }

  async listBrowserMachines(input: { appName: string; sessionId?: string }) {
    assert.equal(input.appName, "browser-test");
    return [...this.records.values()]
      .filter(
        (record) =>
          record.child.exitCode === null &&
          record.child.signalCode === null &&
          (!input.sessionId ||
            record.machine.browserSessionId === input.sessionId),
      )
      .map((record) => record.machine);
  }
  async getMachine(input: { appName: string; machineId: string }) {
    assert.equal(input.appName, "browser-test");
    const record = this.records.get(input.machineId);
    if (
      !record ||
      record.child.exitCode !== null ||
      record.child.signalCode !== null
    )
      return null;
    return record.machine;
  }
  async deleteMachine(input: { appName: string; machineId: string }) {
    assert.equal(input.appName, "browser-test");
    const record = this.records.get(input.machineId);
    if (!record) return;
    if (record.child.exitCode === null && record.child.signalCode === null) {
      const exited = once(record.child, "exit");
      record.child.kill("SIGTERM");
      await exited;
    }
    await this.removeOwnedProcesses(record.directory);
    await rm(record.directory, { recursive: true, force: true });
    this.records.delete(input.machineId);
  }
  async waitForMachine(input: {
    appName: string;
    machineId: string;
    state: string;
  }) {
    const machine = await this.getMachine(input);
    assert.equal(machine?.state ?? "destroyed", input.state);
  }
  readonly fetch = (async (url, init) => {
    const requested = new URL(String(url));
    const suffix = ".vm.browser-test.internal";
    assert.ok(
      requested.hostname.endsWith(suffix),
      "test provider only routes exact owned worker names",
    );
    const record = this.records.get(
      requested.hostname.slice(0, -suffix.length),
    );
    if (
      !record ||
      record.child.exitCode !== null ||
      record.child.signalCode !== null
    )
      throw new Error("Browser test worker absent");
    const response = await fetch(
      new URL(
        `${requested.pathname}${requested.search}`,
        `http://[::1]:${record.port}`,
      ),
      init,
    );
    if (!response.ok) {
      const error = (await response
        .clone()
        .json()
        .catch(() => ({}))) as { error?: { code?: string } };
      console.error("[browser-test] worker response", {
        path: requested.pathname,
        status: response.status,
        code: error.error?.code,
      });
    }
    return response;
  }) as typeof fetch;
  async crash(machineId: string) {
    const record = this.records.get(machineId);
    assert.ok(record);
    const exited = once(record.child, "exit");
    record.child.kill("SIGKILL");
    await exited;
    // Fly loss removes the VM, including Chrome and its ephemeral filesystem.
    await this.removeOwnedProcesses(record.directory);
    await rm(record.directory, { recursive: true, force: true });
  }
  async close() {
    for (const machineId of this.records.keys())
      await this.deleteMachine({ appName: "browser-test", machineId });
    assert.equal(this.records.size, 0);
  }
  private async removeOwnedProcesses(directory: string) {
    for (const pid of await this.ownedPids(directory)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    const deadline = Date.now() + 5_000;
    while ((await this.ownedPids(directory)).length > 0) {
      assert.ok(
        Date.now() < deadline,
        "owned Browser processes did not terminate",
      );
      await delay(25);
    }
  }
  async ownedPids(directory: string) {
    assert.ok(directory.startsWith(path.join(os.tmpdir(), "browser-process-")));
    const owned: number[] = [];
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/u.test(entry) || Number(entry) === process.pid) continue;
      const command = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(
        () => "",
      );
      if (!command) continue; // Reaped/zombie processes cannot retain live authority.
      const environment = await readFile(
        `/proc/${entry}/environ`,
        "utf8",
      ).catch(() => "");
      const scopedEnvironment = environment
        .split("\0")
        .filter((value) =>
          ["HOME=", "AGENT_BROWSER_SOCKET_DIR="].some((key) =>
            value.startsWith(key),
          ),
        );
      if (
        [...command.split("\0"), ...scopedEnvironment].some(
          (argument) =>
            argument.startsWith(`${directory}/`) ||
            argument.includes(`=${directory}/`),
        )
      ) {
        owned.push(Number(entry));
      }
    }
    return owned;
  }
}
