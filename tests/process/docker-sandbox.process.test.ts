import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  DOCKER_CAPABILITY_ENDPOINT,
  DockerSandboxCancellationError,
  DockerSandboxExecutor,
  DockerUnavailableError,
} from "../../src/code/DockerSandboxExecutor.js";
import type {
  AppliedCodeExecutionPolicy,
  CodeExecutionRequest,
  SandboxExecutionOutput,
} from "../../src/code/contracts.js";

const execFileAsync = promisify(execFile);
let dockerReady: Promise<void> | undefined;

test(
  "Docker sandbox runs non-root with a read-only root and no host bind mounts",
  async () => {
    await requireDocker();
    const containerName = testContainerName("isolation");
    const execution = fixedNameExecutor(containerName).execute({
      request: {
        language: "javascript",
        code: `
          const fs = require("node:fs");
          let rootWritable = true;
          try { fs.writeFileSync("/root-owned", "no"); } catch { rootWritable = false; }
          setTimeout(() => console.log(JSON.stringify({ uid: process.getuid(), gid: process.getgid(), home: process.env.HOME, rootWritable })), 500);
        `,
      },
      policy: policy(),
    });

    await waitForContainer(containerName, true);
    const inspected = await inspectContainer(containerName);
    assert.equal(inspected.Config.User, "65532:65532");
    assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
    assert.equal(
      inspected.Mounts.some((mount) => mount.Type === "bind"),
      false,
    );
    assert.match(inspected.HostConfig.Tmpfs["/workspace"] ?? "", /size=32m/u);
    assert.match(inspected.HostConfig.Tmpfs["/workspace"] ?? "", /nr_inodes=1024/u);
    assert.match(inspected.HostConfig.Tmpfs["/tmp"] ?? "", /size=16m/u);
    assert.match(inspected.HostConfig.Tmpfs["/tmp"] ?? "", /nr_inodes=512/u);

    const result = await execution;
    assert.equal(result.status, "ok", result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      uid: 65_532,
      gid: 65_532,
      home: "/tmp",
      rootWritable: false,
    });
  },
);

test(
  "Docker sandbox rejects privilege escalation and setuid or setgid elevation",
  async () => {
    await requireDocker();
    const result = await executeWithName("privilege", {
      language: "javascript",
      code: `
        const fs = require("node:fs");
        const { spawnSync } = require("node:child_process");
        function attempt(name, operation) {
          try {
            operation();
            return [name, { rejected: false }];
          } catch (error) {
            return [name, { rejected: true, code: error.code ?? error.name }];
          }
        }
        fs.copyFileSync("/bin/busybox", "/workspace/setid-probe");
        fs.chmodSync("/workspace/setid-probe", 0o6755);
        const setidRun = spawnSync("/workspace/setid-probe", ["id", "-u"], { encoding: "utf8" });
        const privilegedFiles = spawnSync("find", ["/", "-xdev", "-type", "f", "-perm", "/6000"], { encoding: "utf8" });
        const evidence = Object.fromEntries([
          attempt("setuid", () => process.setuid(0)),
          attempt("setgid", () => process.setgid(0)),
          attempt("setgroups", () => process.setgroups([0])),
          attempt("chown_root", () => fs.chownSync("/workspace/setid-probe", 0, 0)),
        ]);
        console.log(JSON.stringify({
          uid: process.getuid(),
          gid: process.getgid(),
          groups: process.getgroups(),
          evidence,
          setidUid: setidRun.stdout?.trim() ?? "",
          setidStatus: setidRun.status,
          setidError: setidRun.error?.code ?? null,
          privilegedFiles: privilegedFiles.stdout.trim().split("\\n").filter(Boolean),
        }));
      `,
    });

    assert.equal(result.status, "ok", result.stderr);
    const evidence = JSON.parse(result.stdout.trim()) as {
      uid: number;
      gid: number;
      groups: number[];
      evidence: Record<string, { rejected: boolean }>;
      setidUid: string;
      setidStatus: number | null;
      setidError: string | null;
      privilegedFiles: string[];
    };
    assert.equal(evidence.uid, 65_532);
    assert.equal(evidence.gid, 65_532);
    assert.deepEqual(evidence.groups, [65_532]);
    for (const probe of ["setuid", "setgid", "setgroups", "chown_root"]) {
      assert.equal(evidence.evidence[probe]?.rejected, true, probe);
    }
    assert.equal(
      evidence.setidError !== null || evidence.setidStatus !== 0 || evidence.setidUid === "65532",
      true,
    );
    assert.deepEqual(evidence.privilegedFiles, []);
  },
);

test(
  "Docker sandbox rejects namespace, mount, pivot-root, and device attacks",
  async () => {
    await requireDocker();
    const containerName = testContainerName("kernel-boundaries");
    const execution = fixedNameExecutor(containerName).execute({
      request: {
        language: "javascript",
        code: `
          const fs = require("node:fs");
          const { spawnSync } = require("node:child_process");
          fs.mkdirSync("/workspace/mount-target");
          fs.mkdirSync("/workspace/new-root/old-root", { recursive: true });
          const probes = {
            unshare_mount: ["unshare", ["-m", "true"]],
            unshare_user: ["unshare", ["-U", "true"]],
            unshare_network: ["unshare", ["-n", "true"]],
            setns_mount: ["nsenter", ["-t", "1", "-m", "true"]],
            mount: ["mount", ["-t", "tmpfs", "tmpfs", "/workspace/mount-target"]],
            remount: ["mount", ["-o", "remount,rw", "/"]],
            pivot_root: ["pivot_root", ["/workspace/new-root", "/workspace/new-root/old-root"]],
            device_create: ["mknod", ["/workspace/probe-device", "c", "1", "3"]],
          };
          const evidence = Object.fromEntries(Object.entries(probes).map(([name, [command, args]]) => {
            const attempt = spawnSync(command, args, { encoding: "utf8" });
            return [name, { status: attempt.status, error: attempt.stderr.trim() }];
          }));
          const devices = Object.fromEntries(["/dev/mem", "/dev/kmsg", "/dev/sda"].map((device) => {
            try {
              fs.openSync(device, "r");
              return [device, "opened"];
            } catch (error) {
              return [device, error.code ?? error.name];
            }
          }));
          setTimeout(() => console.log(JSON.stringify({ evidence, devices })), 500);
        `,
      },
      policy: policy(),
    });

    await waitForContainer(containerName, true);
    const inspected = await inspectContainer(containerName);
    assert.equal(inspected.HostConfig.Privileged, false);
    assert.equal(inspected.HostConfig.PidMode, "");
    assert.equal(inspected.HostConfig.NetworkMode, "none");
    assert.equal(inspected.HostConfig.UsernsMode === "host", false);
    assert.deepEqual(inspected.HostConfig.Binds, null);
    assert.deepEqual(inspected.HostConfig.Devices, []);
    assert.equal(inspected.Mounts.some((mount) => mount.Type === "bind"), false);

    const result = await execution;
    assert.equal(result.status, "ok", result.stderr);
    const evidence = JSON.parse(result.stdout.trim()) as {
      evidence: Record<string, { status: number; error: string }>;
      devices: Record<string, string>;
    };
    for (const probe of [
      "unshare_mount",
      "unshare_user",
      "unshare_network",
      "setns_mount",
      "mount",
      "remount",
      "pivot_root",
      "device_create",
    ]) {
      assert.notEqual(evidence.evidence[probe]?.status, 0, probe);
    }
    for (const device of ["/dev/mem", "/dev/kmsg", "/dev/sda"]) {
      assert.notEqual(evidence.devices[device], "opened", device);
    }
    await assertContainerAndProcessesRemoved(containerName);
  },
);

test(
  "Docker sandbox reports workspace byte quota exhaustion as an execution error",
  async () => {
    await requireDocker();
    const result = await executeWithName("workspace-bytes", {
      language: "javascript",
      code: `
        const fs = require("node:fs");
        fs.writeFileSync("too-large.bin", Buffer.alloc(12 * 1024 * 1024, 1));
      `,
    }, policy({ workspaceSizeMb: 8, memoryMb: 64 }));

    assert.equal(result.status, "error");
    assert.match(result.stderr, /ENOSPC|no space left/u);
  },
);

test(
  "Docker sandbox enforces workspace and tmp inode ceilings",
  async () => {
    await requireDocker();
    const result = await executeWithName("inode-limits", {
      language: "javascript",
      code: `
        const fs = require("node:fs");
        function exhaust(directory) {
          fs.mkdirSync(directory);
          let created = 0;
          try {
            for (; created < 500; created += 1) fs.writeFileSync(directory + "/" + created, "x");
          } catch (error) {
            return { created, code: error.code };
          }
          return { created, code: "survived" };
        }
        console.log(JSON.stringify({ workspace: exhaust("/workspace/files"), tmp: exhaust("/tmp/files") }));
      `,
    }, policy({ workspaceInodes: 64, tmpInodes: 32 }));

    assert.equal(result.status, "ok", result.stderr);
    const evidence = JSON.parse(result.stdout.trim()) as {
      workspace: { created: number; code: string };
      tmp: { created: number; code: string };
    };
    assert.equal(evidence.workspace.code, "ENOSPC");
    assert.equal(evidence.tmp.code, "ENOSPC");
    assert.equal(evidence.workspace.created < 64, true);
    assert.equal(evidence.tmp.created < 32, true);
  },
);

test(
  "Docker sandbox bounds tmpfs bytes independently from the workspace",
  async () => {
    await requireDocker();
    const result = await executeWithName("tmp-bytes", {
      language: "javascript",
      code: `
        const fs = require("node:fs");
        fs.writeFileSync("/workspace/small.txt", "workspace-ok");
        fs.writeFileSync("/tmp/too-large.bin", Buffer.alloc(6 * 1024 * 1024, 1));
      `,
    }, policy({ workspaceSizeMb: 16, tmpSizeMb: 4, memoryMb: 64 }));

    assert.equal(result.status, "error");
    assert.match(result.stderr, /ENOSPC|no space left/u);
  },
);

test(
  "Docker sandbox bounds concurrent fork attempts and removes every child",
  async () => {
    await requireDocker();
    const containerName = testContainerName("pids");
    const executor = fixedNameExecutor(containerName);
    const execution = executor.execute({
      request: {
        language: "javascript",
        code: `
          const { spawn } = require("node:child_process");
          let errors = 0;
          for (let index = 0; index < 200; index += 1) {
            const child = spawn("sh", ["-c", "sleep 30"]);
            child.on("error", () => { errors += 1; });
          }
          setTimeout(() => {
            console.log(JSON.stringify({ errors }));
            process.exit(errors > 0 ? 0 : 3);
          }, 750);
        `,
      },
      policy: policy({ pidsLimit: 32, timeoutMs: 5_000 }),
    });

    await waitForContainer(containerName, true);
    const hostConfig = await inspectHostConfig(containerName);
    assert.equal(hostConfig.PidsLimit, 32);

    const result = await execution;
    assert.equal(result.status, "ok", result.stderr);
    const evidence = JSON.parse(result.stdout.trim()) as { errors?: number };
    assert.equal((evidence.errors ?? 0) > 0, true);
    await assertContainerAndProcessesRemoved(containerName);
  },
);

test(
  "Docker sandbox memory pressure terminates inside the configured limit",
  async () => {
    await requireDocker();
    const result = await executeWithName("memory", {
      language: "javascript",
      code: `
        const chunks = [];
        while (true) {
          chunks.push(Buffer.alloc(8 * 1024 * 1024, 0xff));
        }
      `,
    }, policy({ memoryMb: 64, timeoutMs: 5_000 }));

    assert.equal(result.status, "error", result.stderr);
    assert.equal(result.exitCode, 137);
    assert.equal(result.durationMs < 5_000, true);
  },
);

test(
  "Docker sandbox freezes background writers before copying artifacts",
  async () => {
    await requireDocker();
    const containerName = testContainerName("paused-snapshot");
    const lifecycleSince = new Date(Date.now() - 1_000).toISOString();
    const execution = fixedNameExecutor(containerName).execute({
      request: {
        language: "javascript",
        code: `
          const { spawn } = require("node:child_process");
          const fs = require("node:fs");
          fs.writeFileSync("artifact.txt", "ready\\n");
          fs.writeFileSync("padding.bin", Buffer.alloc(12 * 1024 * 1024, 7));
          const child = spawn("sh", ["-c", "while :; do printf x >> /workspace/artifact.txt; sleep 0.01; done"], { detached: true, stdio: "ignore" });
          child.unref();
          console.log("done");
        `,
      },
      policy: policy({ workspaceSizeMb: 24, maxArtifactBytes: 16 * 1024 * 1024 }),
    });

    const result = await execution;
    await assertContainerLifecycleEvent(containerName, "pause", lifecycleSince);
    assert.equal(result.status, "ok", result.stderr);
    const artifact = result.artifacts.find((item) => item.path === "artifact.txt");
    assert.ok(
      artifact?.preview,
      `expected artifact.txt in ${JSON.stringify(result.artifacts)}`,
    );
    assert.equal(artifact.preview.truncated, artifact.sizeBytes > 2_000);
    if (artifact.preview.truncated === false) {
      assert.equal(
        artifact.sha256,
        createHash("sha256").update(artifact.preview.text).digest("hex"),
      );
    }
  },
);

test(
  "Docker sandbox excludes absolute, relative, chained, dangling, and special-file artifacts",
  async () => {
    await requireDocker();
    const result = await executeWithName("artifact-types", {
      language: "javascript",
      code: `
        const fs = require("node:fs");
        const net = require("node:net");
        const { spawnSync } = require("node:child_process");
        fs.writeFileSync("safe.txt", "safe-artifact");
        fs.symlinkSync("/etc/passwd", "absolute-link");
        fs.symlinkSync("safe.txt", "relative-link");
        fs.symlinkSync("chain-two", "chain-one");
        fs.symlinkSync("/etc/passwd", "chain-two");
        fs.symlinkSync("missing-target", "dangling-link");
        fs.symlinkSync("/etc", "artifact-output");
        const fifo = spawnSync("mkfifo", ["artifact-fifo"], { encoding: "utf8" });
        if (fifo.status !== 0) throw new Error(fifo.stderr || "mkfifo failed");
        const server = net.createServer();
        server.listen("/workspace/artifact-socket", () => server.close());
        server.on("close", () => console.log("created"));
      `,
    });

    assert.equal(result.status, "ok", result.stderr);
    assert.equal(result.stdout.trim(), "created");
    assert.deepEqual(
      result.artifacts.map((artifact) => artifact.path),
      ["safe.txt"],
    );
    assert.equal(result.artifacts[0]?.preview?.text, "safe-artifact");
    assert.equal(
      result.artifacts.some((artifact) =>
        artifact.preview?.text.includes("root:") === true),
      false,
    );
  },
);

test(
  "Docker sandbox preserves JavaScript, Python, and Bash execution",
  async () => {
    await requireDocker();
    for (const request of [
      { language: "javascript", code: "console.log('javascript-ok')" },
      { language: "python", code: "print('python-ok')" },
      { language: "bash", code: "printf 'bash-ok\\n'" },
    ] satisfies CodeExecutionRequest[]) {
      const result = await executeWithName(request.language, request);
      assert.equal(result.status, "ok", result.stderr);
      assert.equal(result.stdout.trim(), `${request.language}-ok`);
    }
  },
);

test(
  "Docker sandbox installs local npm and Python dependencies without a registry",
  async () => {
    await requireDocker();
    const npmResult = await executeWithName("npm-local", {
      language: "javascript",
      code: "console.log(require('kestrel-local-proof'))",
      dependencies: ["./fixtures/npm-proof"],
      files: [
        {
          path: "fixtures/npm-proof/package.json",
          content: JSON.stringify({ name: "kestrel-local-proof", version: "1.0.0", main: "index.js" }),
        },
        { path: "fixtures/npm-proof/index.js", content: "module.exports = 'npm-local-ok';" },
      ],
    }, policy({ allowDependencyInstall: true, timeoutMs: 20_000 }));
    assert.equal(npmResult.status, "ok", npmResult.stderr);
    assert.equal(npmResult.stdout.trim(), "npm-local-ok");

    const pythonResult = await executeWithName("python-local", {
      language: "python",
      code: "import kestrel_local_proof; print(kestrel_local_proof.VALUE)",
      dependencies: ["./fixtures/python-proof"],
      files: [
        {
          path: "fixtures/python-proof/pyproject.toml",
          content: "[build-system]\nrequires = []\nbuild-backend = 'backend'\nbackend-path = ['.']\n",
        },
        {
          path: "fixtures/python-proof/backend.py",
          content: `import os
import zipfile

NAME = "kestrel_local_proof-1.0.0-py3-none-any.whl"
DIST_INFO = "kestrel_local_proof-1.0.0.dist-info"

def get_requires_for_build_wheel(config_settings=None):
    return []

def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    target = os.path.join(wheel_directory, NAME)
    with zipfile.ZipFile(target, "w") as wheel:
        wheel.write("kestrel_local_proof.py", "kestrel_local_proof.py")
        wheel.writestr(f"{DIST_INFO}/METADATA", "Metadata-Version: 2.1\\nName: kestrel-local-proof\\nVersion: 1.0.0\\n")
        wheel.writestr(f"{DIST_INFO}/WHEEL", "Wheel-Version: 1.0\\nGenerator: kestrel-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n")
        wheel.writestr(f"{DIST_INFO}/RECORD", "")
    return NAME
`,
        },
        {
          path: "fixtures/python-proof/kestrel_local_proof.py",
          content: "VALUE = 'python-local-ok'\n",
        },
      ],
    }, policy({ allowDependencyInstall: true, timeoutMs: 20_000 }));
    assert.equal(pythonResult.status, "ok", pythonResult.stderr);
    assert.equal(pythonResult.stdout.trim(), "python-local-ok");
  },
);

test(
  "Docker sandbox cannot steal host environment, filesystem, process, or namespace canaries",
  async () => {
    await requireDocker();
    const variableName = `KESTREL_SANDBOX_SECRET_${randomUUID().replaceAll("-", "")}`;
    const secret = `secret-${randomUUID()}`;
    const hostRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-host-canary-"));
    const hostPath = path.join(hostRoot, "canary.txt");
    const secretDigest = createHash("sha256").update(secret).digest("hex");
    await writeFile(hostPath, secret, "utf8");
    process.env[variableName] = secret;
    try {
      const result = await executeWithName("secret", {
        language: "javascript",
        code: `
          const fs = require("node:fs");
          const { createHash } = require("node:crypto");
          const name = ${JSON.stringify(variableName)};
          const secretDigest = ${JSON.stringify(secretDigest)};
          const hostPath = ${JSON.stringify(hostPath)};
          const paths = [
            hostPath,
            "/proc/1/environ",
            "/proc/1/root/proc/1/environ",
            "/proc/1/root" + hostPath,
            "/host" + hostPath,
          ];
          const evidence = Object.fromEntries(paths.map((candidate) => {
            try {
              const value = fs.readFileSync(candidate);
              const digest = createHash("sha256").update(value).digest("hex");
              return [candidate, { readable: true, secret: digest === secretDigest }];
            } catch (error) {
              return [candidate, { readable: false, secret: false, code: error.code }];
            }
          }));
          fs.writeFileSync("canary-search.json", JSON.stringify(evidence));
          console.log(JSON.stringify({ inherited: process.env[name] !== undefined, evidence }));
        `,
      });

      assert.equal(result.status, "ok", result.stderr);
      const evidence = JSON.parse(result.stdout.trim()) as {
        inherited: boolean;
        evidence: Record<string, { readable: boolean; secret: boolean }>;
      };
      assert.equal(evidence.inherited, false);
      assert.equal(evidence.evidence[hostPath]?.readable, false);
      assert.equal(
        Object.values(evidence.evidence).some((item) => item.secret),
        false,
      );
      assert.equal(
        `${result.stdout}\n${result.stderr}\n${JSON.stringify(result.artifacts)}`.includes(secret),
        false,
      );
    } finally {
      delete process.env[variableName];
      await rm(hostRoot, { recursive: true, force: true });
    }
  },
);

test(
  "Docker sandbox blocks outbound traffic in network-off mode",
  async () => {
    await requireDocker();
    const result = await executeWithName("network", {
      language: "javascript",
      code: `
        fetch("http://1.1.1.1", { signal: AbortSignal.timeout(1_000) })
          .then(() => {
            console.error("network unexpectedly available");
            process.exit(2);
          })
          .catch(() => console.log("blocked"));
      `,
    });

    assert.equal(result.status, "ok", result.stderr);
    assert.equal(result.stdout.trim(), "blocked");
  },
);

test(
  "Docker sandbox capability transport reaches only the exact trusted stub without exposing its lease",
  async () => {
    await requireDocker();
    const containerName = testContainerName("capability");
    const brokerName = `${containerName}-broker`;
    const lease = `opaque-lease-${randomUUID()}`;
    const hostCanary = `host-canary-${randomUUID()}`;
    const variableName = `KESTREL_CAPABILITY_HOST_${randomUUID().replaceAll("-", "")}`;
    process.env[variableName] = hostCanary;
    try {
      const execution = fixedNameExecutor(containerName).execute({
        request: {
          language: "javascript",
          code: `
            const http = require("node:http");
            const fs = require("node:fs");
            function request(url, options = {}) {
              return new Promise(resolve => {
                const call = http.request(url, { ...options, timeout: 500 }, response => {
                  let body = ""; response.on("data", chunk => body += chunk);
                  response.on("end", () => resolve({ status: response.statusCode, body }));
                });
                call.on("timeout", () => call.destroy(new Error("timeout")));
                call.on("error", error => resolve({ error: error.code ?? error.message }));
                if (options.body) call.write(options.body);
                call.end();
              });
            }
            (async () => {
              const endpoint = ${JSON.stringify(DOCKER_CAPABILITY_ENDPOINT)};
              const exact = await request(endpoint, { method: "POST", body: JSON.stringify({ operation: "search", destination: "api.tavily.com" }) });
              const unknownOperation = await request(endpoint, { method: "POST", body: JSON.stringify({ operation: "write", destination: "api.tavily.com" }) });
              const unknownDestination = await request(endpoint, { method: "POST", body: JSON.stringify({ operation: "search", destination: "example.com" }) });
              const forwarding = await request(endpoint, { method: "POST", body: JSON.stringify({ operation: "search", destination: "api.tavily.com", url: "http://example.com" }) });
              const probes = {};
              for (const [name, url] of Object.entries({
                provider: "http://api.tavily.com",
                internet: "http://1.1.1.1",
                lan: "http://192.168.1.1",
                loopback: "http://127.0.0.1:43128",
                linkLocal: "http://169.254.1.1",
                metadata: "http://169.254.169.254/latest/meta-data/",
              })) probes[name] = await request(url);
              await new Promise(resolve => setTimeout(resolve, 750));
              let brokerConfigReadable = true;
              try { fs.readFileSync("/run/kestrel/config"); } catch { brokerConfigReadable = false; }
              console.log(JSON.stringify({ exact, unknownOperation, unknownDestination, forwarding, probes, envKeys: Object.keys(process.env), brokerConfigReadable }));
            })();
          `,
        },
        policy: policy({ timeoutMs: 10_000 }),
        capability: {
          transport: "docker-shared-loopback-v1",
          lease,
          operation: "search",
          destination: "api.tavily.com",
          response: { answer: "trusted-stub-ok" },
        },
      });

      await waitForContainer(containerName, true);
      await waitForContainer(brokerName, true);
      const [workloadInspect, brokerInspect, workloadTop, brokerTop, deletedBootstrap] = await Promise.all([
        execFileAsync("docker", ["inspect", containerName]),
        execFileAsync("docker", ["inspect", brokerName]),
        execFileAsync("docker", ["top", containerName]),
        execFileAsync("docker", ["top", brokerName]),
        execFileAsync("docker", ["exec", brokerName, "test", "!", "-e", "/run/kestrel/config"]),
      ]);
      const visible = [workloadInspect.stdout, brokerInspect.stdout, workloadTop.stdout, brokerTop.stdout].join("\n");
      assert.equal(visible.includes(lease), false);
      assert.equal(visible.includes(hostCanary), false);
      assert.equal(deletedBootstrap.stdout, "");
      const parsedBroker = JSON.parse(brokerInspect.stdout)[0] as { Id: string; HostConfig: { NetworkMode: string } };
      assert.equal(JSON.parse(workloadInspect.stdout)[0].HostConfig.NetworkMode, `container:${parsedBroker.Id}`);
      assert.equal(parsedBroker.HostConfig.NetworkMode, "none");

      const result = await execution;
      assert.equal(result.status, "ok", result.stderr);
      const evidence = JSON.parse(result.stdout.trim()) as {
        exact: { status: number; body: string };
        unknownOperation: { status: number };
        unknownDestination: { status: number };
        forwarding: { status: number };
        probes: Record<string, { error?: string }>;
        envKeys: string[];
        brokerConfigReadable: boolean;
      };
      assert.equal(evidence.exact.status, 200);
      assert.deepEqual(JSON.parse(evidence.exact.body), { answer: "trusted-stub-ok" });
      assert.equal(evidence.unknownOperation.status, 403);
      assert.equal(evidence.unknownDestination.status, 403);
      assert.equal(evidence.forwarding.status, 403);
      for (const [name, probe] of Object.entries(evidence.probes)) {
        assert.equal(typeof probe.error, "string", name);
      }
      assert.equal(evidence.envKeys.includes(variableName), false);
      assert.equal(evidence.brokerConfigReadable, false);
      const retained = `${result.stdout}\n${result.stderr}\n${JSON.stringify(result.artifacts)}`;
      assert.equal(retained.includes(lease), false);
      assert.equal(retained.includes(hostCanary), false);
      await assertContainerAndProcessesRemoved(containerName);
      await assertContainerAndProcessesRemoved(brokerName);
    } finally {
      delete process.env[variableName];
    }
  },
);

test(
  "Docker sandbox fails before container creation when capability confinement is unavailable",
  async () => {
    await requireDocker();
    const containerName = testContainerName("capability-unavailable");
    const executor = new DockerSandboxExecutor({
      containerNameFactory: () => containerName,
      capabilityConfinementProbe: async () => false,
    });
    await assert.rejects(
      executor.execute({
        request: { language: "javascript", code: "console.log('must not run')" },
        policy: policy(),
        capability: {
          transport: "docker-shared-loopback-v1",
          lease: `opaque-lease-${randomUUID()}`,
          operation: "search",
          destination: "api.tavily.com",
          response: { answer: "must not run" },
        },
      }),
      (error: unknown) => error instanceof DockerUnavailableError,
    );
    assert.equal(await containerExists(containerName), false);
    assert.equal(await containerExists(`${containerName}-broker`), false);
  },
);

test(
  "Docker sandbox cancellation enforces hardening and removes the named workload",
  async () => {
    await requireDocker();
    const containerName = testContainerName("cancel");
    const controller = new AbortController();
    const execution = fixedNameExecutor(containerName).execute({
      request: {
        language: "javascript",
        code: "setInterval(() => {}, 1_000);",
      },
      policy: policy({ memoryMb: 64, pidsLimit: 32, timeoutMs: 10_000 }),
      signal: controller.signal,
    });

    await waitForContainer(containerName, true);
    const hostConfig = await inspectHostConfig(containerName);
    assert.equal(hostConfig.PidsLimit, 32);
    assert.equal(hostConfig.Memory, 64 * 1024 * 1024);
    assert.equal(hostConfig.NetworkMode, "none");
    assert.equal(hostConfig.CapDrop?.includes("ALL"), true);
    assert.equal(
      hostConfig.SecurityOpt?.includes("no-new-privileges"),
      true,
    );

    controller.abort();
    await assert.rejects(
      execution,
      (error: unknown) => error instanceof DockerSandboxCancellationError,
    );
    await assertContainerAndProcessesRemoved(containerName);
  },
);

test(
  "Docker sandbox timeout removes the named container and its child process",
  async () => {
    await requireDocker();
    const containerName = testContainerName("timeout");
    const result = await fixedNameExecutor(containerName).execute({
      request: {
        language: "javascript",
        code: `
          const { spawn } = require("node:child_process");
          spawn("sh", ["-c", "sleep 30"]);
          setInterval(() => {}, 1_000);
        `,
      },
      policy: policy({ timeoutMs: 500 }),
    });

    assert.equal(result.status, "timeout");
    await assertContainerAndProcessesRemoved(containerName);
  },
);

function fixedNameExecutor(containerName: string): DockerSandboxExecutor {
  return new DockerSandboxExecutor({
    containerNameFactory: () => containerName,
  });
}

async function executeWithName(
  label: string,
  request: CodeExecutionRequest,
  appliedPolicy = policy(),
): Promise<SandboxExecutionOutput> {
  const containerName = testContainerName(label);
  const result = await fixedNameExecutor(containerName).execute({
    request,
    policy: appliedPolicy,
  });
  await waitForContainer(containerName, false);
  return result;
}

function policy(
  overrides: Partial<AppliedCodeExecutionPolicy> = {},
): AppliedCodeExecutionPolicy {
  return {
    enabled: true,
    approvalMode: "auto",
    executor: "docker",
    language: "javascript",
    timeoutMs: 5_000,
    memoryMb: 128,
    cpuShares: 128,
    pidsLimit: 64,
    workspaceSizeMb: 32,
    workspaceInodes: 1_024,
    tmpSizeMb: 16,
    tmpInodes: 512,
    network: "off",
    allowDependencyInstall: false,
    maxOutputBytes: 32_000,
    maxArtifacts: 20,
    maxArtifactBytes: 64_000,
    ...overrides,
  };
}

function testContainerName(label: string): string {
  return `kestrel-code-test-${label}-${randomUUID()}`;
}

async function requireDocker(): Promise<void> {
  dockerReady ??= prepareDocker();
  await dockerReady;
}

async function prepareDocker(): Promise<void> {
  try {
    await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 10_000,
    });
    for (const image of ["node:20-alpine", "python:3.12-alpine", "bash:5.2"]) {
      try {
        await execFileAsync("docker", ["image", "inspect", image], {
          timeout: 10_000,
        });
      } catch {
        await execFileAsync("docker", ["pull", image], {
          timeout: 120_000,
        });
      }
    }
  } catch (error) {
    assert.fail(
      `Docker-backed sandbox proof requires Docker and node:20-alpine: ${String(error)}`,
    );
  }
}

async function inspectHostConfig(containerName: string): Promise<{
  PidsLimit?: number;
  Memory?: number;
  NetworkMode?: string;
  CapDrop?: string[];
  SecurityOpt?: string[];
}> {
  const { stdout } = await execFileAsync(
    "docker",
    ["inspect", "--format", "{{json .HostConfig}}", containerName],
    { timeout: 10_000 },
  );
  return JSON.parse(stdout.trim());
}

async function inspectContainer(containerName: string): Promise<{
  Config: { User: string };
  HostConfig: {
    Binds: string[] | null;
    Devices: unknown[];
    NetworkMode: string;
    PidMode: string;
    Privileged: boolean;
    ReadonlyRootfs: boolean;
    Tmpfs: Record<string, string>;
    UsernsMode: string;
  };
  Mounts: Array<{ Type: string }>;
}> {
  const { stdout } = await execFileAsync(
    "docker",
    ["inspect", "--format", "{{json .}}", containerName],
    { timeout: 10_000 },
  );
  return JSON.parse(stdout.trim());
}

async function waitForContainer(
  containerName: string,
  expected: boolean,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await containerExists(containerName) === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(
    `Expected Docker container '${containerName}' existence to become ${expected}.`,
  );
}

async function assertContainerLifecycleEvent(
  containerName: string,
  action: string,
  since: string,
): Promise<void> {
  const { stdout } = await execFileAsync(
    "docker",
    [
      "events",
      "--since",
      since,
      "--until",
      new Date().toISOString(),
      "--filter",
      `container=${containerName}`,
      "--filter",
      `event=${action}`,
      "--format",
      "{{.Action}}",
    ],
    { timeout: 10_000 },
  );
  assert.equal(
    stdout.trim().split("\n").includes(action),
    true,
    `Expected Docker container '${containerName}' to emit '${action}'.`,
  );
}

async function containerExists(containerName: string): Promise<boolean> {
  try {
    await execFileAsync("docker", ["inspect", containerName], {
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function assertContainerAndProcessesRemoved(
  containerName: string,
): Promise<void> {
  await waitForContainer(containerName, false);
  await assert.rejects(
    execFileAsync("docker", ["top", containerName], { timeout: 5_000 }),
  );
}
