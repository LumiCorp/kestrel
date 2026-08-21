import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("DOKS preflight emits bounded facts from the read-only kubectl surface", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kestrel-doks-preflight-"));
  const kubectlPath = path.join(directory, "kubectl");
  const outputPath = path.join(directory, "facts.json");
  const fakeKubectl = `#!/usr/bin/env node
const args = process.argv.slice(2);
const command = args.filter((arg, index) => arg !== "--context" && args[index - 1] !== "--context").join(" ");
const responses = {
  "config current-context": "doks-test\\n",
  "version -o json": { serverVersion: { gitVersion: "v1.33.2-do.0" } },
  "get nodes -o json": { items: [{ status: { conditions: [{ type: "Ready", status: "True" }] } }] },
  "get storageclass -o json": { items: [{ metadata: { name: "do-block-storage" }, spec: { provisioner: "dobs.csi.digitalocean.com", volumeBindingMode: "WaitForFirstConsumer", reclaimPolicy: "Delete" } }] },
  "get volumesnapshotclass.snapshot.storage.k8s.io -o json": { items: [{ metadata: { name: "dobs-snapshots" }, spec: { driver: "dobs.csi.digitalocean.com" } }] },
  "get gatewayclass.gateway.networking.k8s.io -o json": { items: [{ metadata: { name: "istio" }, spec: { controllerName: "istio.io/gateway-controller" }, status: { conditions: [{ type: "Accepted", status: "True" }] } }, { metadata: { name: "cilium" }, spec: { controllerName: "io.cilium/gateway-controller" }, status: { conditions: [{ type: "Accepted", status: "True" }] } }] },
  "get daemonset --all-namespaces -o json": { items: [{ metadata: { name: "cilium", namespace: "kube-system", labels: { "k8s-app": "cilium" } } }] },
  "get networkpolicy --all-namespaces -o json": { items: [] }
};
const response = responses[command];
if (response === undefined) throw new Error("unexpected kubectl command: " + command);
process.stdout.write(typeof response === "string" ? response : JSON.stringify(response));
`;

  try {
    await writeFile(kubectlPath, fakeKubectl, "utf8");
    await chmod(kubectlPath, 0o755);
    await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/kubernetes-doks-preflight.ts", "--", "--context", "doks-test", "--output", outputPath],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` },
      },
    );
    const facts = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, any>;
    assert.equal(facts.contract, "kubernetes-byoc-doks-preflight-v1");
    assert.equal(facts.platform.distribution, "other");
    assert.equal(facts.platform.edgeMode, "gateway_api");
    assert.equal(facts.platform.edgeController, "io.cilium/gateway-controller");
    assert.equal(facts.platform.storageCsi, "dobs.csi.digitalocean.com");
    assert.equal(facts.storage.snapshotClassName, "dobs-snapshots");
    assert.deepEqual(
      facts.checks.map((check: { id: string }) => check.id),
      [
        "cluster.version",
        "storage.csi_class",
        "storage.snapshots",
        "edge.gateway_api",
        "cluster.nodes",
        "network.cilium",
      ],
    );
    assert.equal(facts.cluster.nodeCount, 1);
    assert.equal(facts.cluster.readyNodeCount, 1);
    assert.match(facts.contextHash, /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(facts), /kubeconfig|token|secret|password/iu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("DOKS preflight fails closed when multiple Cilium GatewayClasses exist", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kestrel-doks-preflight-ambiguous-"));
  const kubectlPath = path.join(directory, "kubectl");
  const outputPath = path.join(directory, "facts.json");
  const fakeKubectl = `#!/usr/bin/env node
const args = process.argv.slice(2);
const command = args.filter((arg, index) => arg !== "--context" && args[index - 1] !== "--context").join(" ");
const responses = {
  "config current-context": "doks-test\\n",
  "version -o json": { serverVersion: { gitVersion: "v1.33.2-do.0" } },
  "get nodes -o json": { items: [{ status: { conditions: [{ type: "Ready", status: "True" }] } }] },
  "get storageclass -o json": { items: [{ metadata: { name: "do-block-storage" }, spec: { provisioner: "dobs.csi.digitalocean.com" } }] },
  "get volumesnapshotclass.snapshot.storage.k8s.io -o json": { items: [{ metadata: { name: "dobs-snapshots" }, spec: { driver: "dobs.csi.digitalocean.com" } }] },
  "get gatewayclass.gateway.networking.k8s.io -o json": { items: [
    { metadata: { name: "cilium-a" }, spec: { controllerName: "io.cilium/gateway-controller" }, status: { conditions: [{ type: "Accepted", status: "True" }] } },
    { metadata: { name: "cilium-b" }, spec: { controllerName: "io.cilium/gateway-controller" }, status: { conditions: [{ type: "Accepted", status: "True" }] } }
  ] },
  "get daemonset --all-namespaces -o json": { items: [{ metadata: { name: "cilium", namespace: "kube-system", labels: { "k8s-app": "cilium" } } }] },
  "get networkpolicy --all-namespaces -o json": { items: [] }
};
const response = responses[command];
if (response === undefined) throw new Error("unexpected kubectl command: " + command);
process.stdout.write(typeof response === "string" ? response : JSON.stringify(response));
`;

  try {
    await writeFile(kubectlPath, fakeKubectl, "utf8");
    await chmod(kubectlPath, 0o755);
    await assert.rejects(
      execFileAsync(
        process.execPath,
        ["--import", "tsx", "scripts/kubernetes-doks-preflight.ts", "--", "--context", "doks-test", "--output", outputPath],
        {
          cwd: path.resolve(import.meta.dirname, ".."),
          env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` },
        },
      ),
      /Expected exactly one Cilium GatewayClass/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
