import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PREFLIGHT_VERSION = "kubernetes-byoc-doks-preflight-v1" as const;
const DEFAULT_STORAGE_CLASS = "do-block-storage";
const DEFAULT_SNAPSHOT_DRIVER = "dobs.csi.digitalocean.com";
const DEFAULT_OUTPUT = "artifacts/doks-cluster-facts.json";

type JsonRecord = Record<string, unknown>;

type CliOptions = {
  context?: string;
  output: string;
  storageClass: string;
  snapshotDriver: string;
  gatewayController?: string;
};

type KubectlResource = {
  metadata?: {
    name?: unknown;
    namespace?: unknown;
    labels?: unknown;
  };
  spec?: JsonRecord;
  status?: JsonRecord;
};

type KubectlList = {
  items?: unknown;
};

type Check = {
  id: string;
  status: "passed";
  detail: string;
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const kubectl = createKubectl(options.context);
  const checks: Check[] = [];

  const context = await kubectl.text(["config", "current-context"]);
  const version = await kubectl.json<JsonRecord>(["version", "-o", "json"]);
  const nodes = await kubectl.json<KubectlList>(["get", "nodes", "-o", "json"]);
  const storageClasses = await kubectl.json<KubectlList>([
    "get",
    "storageclass",
    "-o",
    "json",
  ]);
  const snapshotClasses = await kubectl.json<KubectlList>([
    "get",
    "volumesnapshotclass.snapshot.storage.k8s.io",
    "-o",
    "json",
  ]);
  const gatewayClasses = await kubectl.json<KubectlList>([
    "get",
    "gatewayclass.gateway.networking.k8s.io",
    "-o",
    "json",
  ]);
  const daemonSets = await kubectl.json<KubectlList>([
    "get",
    "daemonset",
    "--all-namespaces",
    "-o",
    "json",
  ]);
  const networkPolicies = await kubectl.json<KubectlList>([
    "get",
    "networkpolicy",
    "--all-namespaces",
    "-o",
    "json",
  ]);
  const serverVersion = nestedString(version, ["serverVersion", "gitVersion"]);
  assertMinimumKubernetesVersion(serverVersion, 1, 33);
  checks.push({
    id: "cluster.version",
    status: "passed",
    detail: `Kubernetes server ${serverVersion} meets the DOKS Gateway API prerequisite.`,
  });

  const storageClass = findNamedResource(storageClasses, options.storageClass);
  if (!storageClass) {
    throw new Error(`Required DOKS storage class '${options.storageClass}' was not found.`);
  }
  const storageDriver = stringField(
    storageClass.spec?.provisioner,
    `storage class '${options.storageClass}' provisioner`,
  );
  if (storageDriver !== DEFAULT_SNAPSHOT_DRIVER) {
    throw new Error(
      `Storage class '${options.storageClass}' uses '${storageDriver}', expected '${DEFAULT_SNAPSHOT_DRIVER}'.`,
    );
  }
  checks.push({
    id: "storage.csi_class",
    status: "passed",
    detail: `Storage class '${options.storageClass}' is provisioned by ${storageDriver}.`,
  });

  const snapshotClass = findResourceByDriver(snapshotClasses, options.snapshotDriver);
  if (!snapshotClass) {
    throw new Error(`Required DOKS snapshot class for '${options.snapshotDriver}' was not found.`);
  }
  checks.push({
    id: "storage.snapshots",
    status: "passed",
    detail: `A VolumeSnapshotClass uses ${options.snapshotDriver}.`,
  });

  const gatewayClassResources = resources(gatewayClasses);
  if (gatewayClassResources.length === 0) {
    throw new Error("Gateway API is not installed: no GatewayClass resources were returned.");
  }
  if (options.gatewayController && !isCiliumGatewayController(options.gatewayController)) {
    throw new Error("DOKS Gateway API preflight requires a Cilium GatewayClass controller.");
  }
  const gatewayClassCandidates = gatewayClassResources.filter((resource) => {
    const controllerName = resource.spec?.controllerName;
    return typeof controllerName === "string" &&
      (options.gatewayController
        ? controllerName === options.gatewayController
        : isCiliumGatewayController(controllerName));
  });
  if (gatewayClassCandidates.length !== 1) {
    throw new Error(
      options.gatewayController
        ? `Expected exactly one GatewayClass for controller '${options.gatewayController}', found ${gatewayClassCandidates.length}.`
        : `Expected exactly one Cilium GatewayClass; found ${gatewayClassCandidates.length}. Pass --gateway-controller when the selected class is ambiguous.`,
    );
  }
  const gatewayClass = gatewayClassCandidates[0]!;
  const gatewayController = stringField(
    gatewayClass.spec?.controllerName,
    "GatewayClass controllerName",
  );
  if (!isGatewayClassAccepted(gatewayClass)) {
    throw new Error(`GatewayClass '${resourceName(gatewayClass)}' is not Accepted by its controller.`);
  }
  checks.push({
    id: "edge.gateway_api",
    status: "passed",
    detail: `GatewayClass '${resourceName(gatewayClass)}' is controlled by ${gatewayController}.`,
  });

  const nodeResources = resources(nodes);
  const readyNodes = nodeResources.filter((node) => isNodeReady(node)).length;
  if (nodeResources.length < 1 || readyNodes !== nodeResources.length) {
    throw new Error(
      `The current context has ${readyNodes}/${nodeResources.length} Ready nodes; at least one Ready node is required.`,
    );
  }
  checks.push({
    id: "cluster.nodes",
    status: "passed",
    detail: `${readyNodes} node(s) are Ready.`,
  });

  const ciliumWorkloads = resources(daemonSets)
    .filter((resource) => isCiliumResource(resource))
    .map((resource) => ({
      kind: "DaemonSet",
      name: resourceName(resource),
      namespace: resourceNamespace(resource),
    }));
  if (ciliumWorkloads.length === 0) {
    throw new Error("No Cilium DaemonSet was observed; verify the DOKS VPC-native cluster profile.");
  }
  checks.push({
    id: "network.cilium",
    status: "passed",
    detail: `Observed ${ciliumWorkloads.length} Cilium DaemonSet resource(s).`,
  });

  const result = {
    contract: PREFLIGHT_VERSION,
    recordedAt: new Date().toISOString(),
    contextHash: hash(context),
    kubernetesVersion: serverVersion,
    platform: {
      distribution: "other",
      edgeMode: "gateway_api",
      edgeController: gatewayController,
      cni: "cilium",
      networkPolicy: "cilium (observed; enforcement is proven by the canary)",
      storageCsi: storageDriver,
      snapshotCsi: options.snapshotDriver,
    },
    storage: {
      storageClassName: resourceName(storageClass),
      volumeBindingMode: storageClass.spec?.volumeBindingMode ?? null,
      reclaimPolicy: storageClass.spec?.reclaimPolicy ?? null,
      snapshotClassName: resourceName(snapshotClass),
    },
    cluster: {
      nodeCount: nodeResources.length,
      readyNodeCount: readyNodes,
      networkPolicyCount: resources(networkPolicies).length,
      ciliumWorkloads,
    },
    checks,
  } as const;

  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(
    `DOKS preflight passed; wrote ${options.output} (${checks.length} checks).\n`,
  );
}

function createKubectl(context: string | undefined) {
  const prefix = context ? ["--context", context] : [];
  return {
    async text(args: string[]) {
      const result = await execFileAsync("kubectl", [...prefix, ...args], {
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
      });
      return result.stdout.trim();
    },
    async json<T>(args: string[]) {
      const raw = await this.text(args);
      try {
        return JSON.parse(raw) as T;
      } catch {
        throw new Error(`kubectl ${args.join(" ")} returned malformed JSON.`);
      }
    },
  };
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    output: DEFAULT_OUTPUT,
    storageClass: DEFAULT_STORAGE_CLASS,
    snapshotDriver: DEFAULT_SNAPSHOT_DRIVER,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--context") options.context = valueAfter(argv, ++index, arg);
    else if (arg === "--output") options.output = valueAfter(argv, ++index, arg);
    else if (arg === "--storage-class") options.storageClass = valueAfter(argv, ++index, arg);
    else if (arg === "--snapshot-driver") options.snapshotDriver = valueAfter(argv, ++index, arg);
    else if (arg === "--gateway-controller") options.gatewayController = valueAfter(argv, ++index, arg);
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: pnpm kubernetes:doks:preflight -- [options]",
          "",
          "  --context <name>               kubectl context to inspect",
          `  --output <path>                output path (default: ${DEFAULT_OUTPUT})`,
          `  --storage-class <name>         storage class (default: ${DEFAULT_STORAGE_CLASS})`,
          `  --snapshot-driver <name>       CSI snapshot driver (default: ${DEFAULT_SNAPSHOT_DRIVER})`,
          "  --gateway-controller <name>    require an exact GatewayClass controller",
        ].join("\n") + "\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument '${arg}'.`);
    }
  }
  return options;
}

function valueAfter(argv: string[], index: number, flag: string): string {
  const value = argv[index]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function resources(value: KubectlList): KubectlResource[] {
  if (!Array.isArray(value.items)) throw new Error("kubectl response omitted items.");
  return value.items.filter(isResource);
}

function isResource(value: unknown): value is KubectlResource {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function findNamedResource(list: KubectlList, name: string): KubectlResource | undefined {
  return resources(list).find((resource) => resourceName(resource) === name);
}

function findResourceByDriver(list: KubectlList, driver: string): KubectlResource | undefined {
  return resources(list).find((resource) => resource.spec?.driver === driver);
}

function resourceName(resource: KubectlResource): string {
  return stringField(resource.metadata?.name, "Kubernetes resource name");
}

function resourceNamespace(resource: KubectlResource): string {
  return stringField(resource.metadata?.namespace, "Kubernetes resource namespace");
}

function nestedString(value: JsonRecord, pathParts: string[]): string {
  let current: unknown = value;
  for (const part of pathParts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      throw new Error(`kubectl response omitted ${pathParts.join(".")}.`);
    }
    current = (current as JsonRecord)[part];
  }
  return stringField(current, pathParts.join("."));
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is missing.`);
  }
  return value.trim();
}

function isNodeReady(resource: KubectlResource): boolean {
  const conditions = resource.status?.conditions;
  if (!Array.isArray(conditions)) return false;
  return conditions.some(
    (condition) =>
      !!condition &&
      typeof condition === "object" &&
      !Array.isArray(condition) &&
      (condition as JsonRecord).type === "Ready" &&
      (condition as JsonRecord).status === "True",
  );
}

function isGatewayClassAccepted(resource: KubectlResource): boolean {
  const conditions = resource.status?.conditions;
  if (!Array.isArray(conditions)) return false;
  return conditions.some(
    (condition) =>
      !!condition &&
      typeof condition === "object" &&
      !Array.isArray(condition) &&
      (condition as JsonRecord).type === "Accepted" &&
      (condition as JsonRecord).status === "True",
  );
}

function isCiliumGatewayController(value: string): boolean {
  return /cilium/iu.test(value);
}

function assertMinimumKubernetesVersion(version: string, minimumMajor: number, minimumMinor: number) {
  const match = /^v(\d+)\.(\d+)(?:\.|-)/u.exec(version);
  if (!match) throw new Error(`Kubernetes server version '${version}' is invalid.`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < minimumMajor || (major === minimumMajor && minor < minimumMinor)) {
    throw new Error(
      `Kubernetes server ${version} is below the required v${minimumMajor}.${minimumMinor} Gateway API profile.`,
    );
  }
}

function isCiliumResource(resource: KubectlResource): boolean {
  const name = typeof resource.metadata?.name === "string" ? resource.metadata.name : "";
  const labels = resource.metadata?.labels;
  const labelText = labels && typeof labels === "object" ? JSON.stringify(labels) : "";
  return /cilium/iu.test(`${name} ${labelText}`);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `DOKS preflight failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
