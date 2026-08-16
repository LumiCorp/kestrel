import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  FlyMachinesClient,
  type FlyMachineHealthCheck,
} from "@/lib/environments/providers/fly-machines";
import { selectDesiredEnvironmentRuntime } from "@/lib/environments/runtime-channel";

const BUILD_TAG = "production-[1-9][0-9]*-[1-9][0-9]*";

const PLATFORM_ROLES = {
  "preview-edge": {
    app: "kestrel-preview-edge",
    repository: "registry.fly.io/kestrel-preview-edge",
    healthCheck: {
      name: "preview_edge",
      port: 8081,
      path: "/health",
      timeoutSeconds: 2,
      gracePeriodSeconds: 5,
    },
  },
  "turn-worker": {
    app: "kestrel-one-turn-worker",
    repository: "registry.fly.io/kestrel-one-turn-worker",
    healthCheck: {
      name: "worker",
      port: 8081,
      path: "/healthz",
      timeoutSeconds: 5,
      gracePeriodSeconds: 30,
    },
  },
  "control-worker": {
    app: "kestrel-one-control-worker",
    repository: "registry.fly.io/kestrel-one-control-worker",
    healthCheck: {
      name: "worker",
      port: 8081,
      path: "/healthz",
      timeoutSeconds: 5,
      gracePeriodSeconds: 30,
    },
  },
  "runpod-worker": {
    app: "kestrel-one-runpod-worker",
    repository: "registry.fly.io/kestrel-one-runpod-worker",
    healthCheck: {
      name: "worker",
      port: 8081,
      path: "/healthz",
      timeoutSeconds: 5,
      gracePeriodSeconds: 30,
    },
  },
} as const;

const platformRoleSchema = z.enum([
  "preview-edge",
  "turn-worker",
  "control-worker",
  "runpod-worker",
]);

const platformInputSchema = z
  .object({
    kind: z.literal("platform"),
    role: platformRoleSchema,
    image: z.string().min(1),
  })
  .strict()
  .superRefine((input, context) => {
    const repository = PLATFORM_ROLES[input.role].repository.replace(
      /[.*+?^${}()|[\]\\]/gu,
      "\\$&",
    );
    if (!new RegExp(`^${repository}:${BUILD_TAG}$`, "u").test(input.image)) {
      context.addIssue({
        code: "custom",
        path: ["image"],
        message: `Image must be an immutable production build for ${input.role}.`,
      });
    }
  });

const runtimeInputSchema = z
  .object({
    kind: z.literal("environment-runtime"),
    workspaceImage: z
      .string()
      .regex(
        new RegExp(
          `^ghcr\\.io/lumicorp/kestrel-workspace-runtime:${BUILD_TAG}$`,
          "u",
        ),
      ),
    routerImage: z
      .string()
      .regex(
        new RegExp(
          `^ghcr\\.io/lumicorp/kestrel-environment-router:${BUILD_TAG}$`,
          "u",
        ),
      ),
    sourceRevision: z.string().regex(/^[0-9a-f]{40}$/u),
    githubRunId: z.string().regex(/^[1-9][0-9]*$/u),
    githubRunAttempt: z.number().int().positive(),
  })
  .strict()
  .superRefine((input, context) => {
    const workspaceBuild = productionBuildId(input.workspaceImage);
    const routerBuild = productionBuildId(input.routerImage);
    if (!(workspaceBuild && workspaceBuild === routerBuild)) {
      context.addIssue({
        code: "custom",
        path: ["routerImage"],
        message:
          "Workspace Runtime and Environment Router must use one production build.",
      });
    }
  });

export const productionImageInputSchema = z.discriminatedUnion("kind", [
  platformInputSchema,
  runtimeInputSchema,
]);

export type ProductionImageInput = z.infer<typeof productionImageInputSchema>;

type PlatformFlyClient = Pick<
  FlyMachinesClient,
  | "listAppMachines"
  | "cloneMachineAsStoppedStandby"
  | "updateMachineImage"
  | "startMachine"
  | "stopMachine"
  | "waitForMachine"
  | "waitForMachineHealth"
>;

export function authorizeProductionImageRequest(
  authorization: string | null,
  expectedToken = process.env.PRODUCTION_IMAGE_DEPLOY_TOKEN,
) {
  const supplied = authorization?.match(/^Bearer (.+)$/u)?.[1];
  if (!(supplied && expectedToken))
    throw new ProductionImageAuthorizationError();
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expectedToken);
  if (
    suppliedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    throw new ProductionImageAuthorizationError();
  }
}

export class ProductionImageAuthorizationError extends Error {}

export async function applyProductionImage(
  input: ProductionImageInput,
  dependencies?: { fly?: PlatformFlyClient },
) {
  if (input.kind === "environment-runtime") {
    return {
      kind: input.kind,
      ...(await selectDesiredEnvironmentRuntime({
        runtimeImage: input.workspaceImage,
        runtimeSourceRevision: input.sourceRevision,
        routerImage: input.routerImage,
        routerSourceRevision: input.sourceRevision,
        githubRunId: input.githubRunId,
        githubRunAttempt: input.githubRunAttempt,
        rejectStaleBuild: true,
      })),
    };
  }
  const target = PLATFORM_ROLES[input.role];
  const fly = dependencies?.fly ?? createPlatformFlyClient();
  return {
    kind: input.kind,
    role: input.role,
    ...(await deployPlatformImage({
      fly,
      appName: target.app,
      healthCheck: target.healthCheck,
      image: input.image,
    })),
  };
}

function productionBuildId(image: string) {
  return (
    image.match(/:((?:production-)[1-9][0-9]*-[1-9][0-9]*)$/u)?.[1] ?? null
  );
}

export async function deployPlatformImage(input: {
  fly: PlatformFlyClient;
  appName: string;
  healthCheck: FlyMachineHealthCheck;
  image: string;
}) {
  const machines = await input.fly.listAppMachines({ appName: input.appName });
  const transitional = machines.find(
    (machine) => machine.state !== "started" && machine.state !== "stopped",
  );
  if (transitional) {
    throw new Error(
      `${input.appName} Machine ${transitional.id} is ${transitional.state}; retry after the app reaches a stable state.`,
    );
  }
  if (
    machines.some(
      (machine) =>
        machine.image && isNewerProductionImage(machine.image, input.image),
    )
  ) {
    return { image: input.image, stale: true };
  }
  let deployable = machines;
  if (!deployable.length) {
    throw new Error(`${input.appName} has no usable Machine.`);
  }
  if (deployable.length === 1) {
    const source = deployable[0]!;
    const standby = await input.fly.cloneMachineAsStoppedStandby({
      appName: input.appName,
      machineId: source.id,
      runtimeImage: input.image,
      healthCheck: input.healthCheck,
    });
    deployable = [...deployable, { ...standby, state: "stopped" }];
  }

  let active = deployable.filter((machine) => machine.state === "started");
  let stopped = deployable.filter((machine) => machine.state === "stopped");
  let bootstrapId: string | null = null;
  if (!active.length) {
    const bootstrap = stopped.shift();
    if (!bootstrap) {
      throw new Error(`${input.appName} has no recoverable Machine.`);
    }
    await startAndVerifyMachine(input, bootstrap.id);
    bootstrapId = bootstrap.id;
    active = [{ ...bootstrap, state: "started" }];
  }

  if (!stopped.length) {
    const standby = active.pop();
    if (!standby || !active.length) {
      throw new Error(`${input.appName} cannot establish a stopped standby.`);
    }
    await stopAndWait(input, standby.id);
    stopped = [{ ...standby, state: "stopped" }];
  }

  const standby = stopped[0]!;
  await startAndVerifyMachine(input, standby.id);
  for (const machine of active) {
    if (machine.id === bootstrapId) continue;
    try {
      await updateAndVerifyRunningMachine(input, machine.id);
    } catch (error) {
      await stopAndWait(input, machine.id).catch(() => undefined);
      throw error;
    }
  }
  for (const machine of stopped.slice(1)) {
    await input.fly.updateMachineImage({
      appName: input.appName,
      machineId: machine.id,
      runtimeImage: input.image,
      healthCheck: input.healthCheck,
    });
  }
  await stopAndWait(input, standby.id);
  const finalMachines = await input.fly.listAppMachines({ appName: input.appName });
  const unconverged = finalMachines.find(
    (machine) =>
      (machine.state !== "started" && machine.state !== "stopped") ||
      !machine.image ||
      !sameProductionImage(machine.image, input.image),
  );
  if (unconverged) {
    throw new Error(
      `${input.appName} Machine ${unconverged.id} did not converge to ${input.image}.`,
    );
  }
  if (!finalMachines.some((machine) => machine.state === "started")) {
    throw new Error(`${input.appName} has no running Machine after deployment.`);
  }
  const missingResolvedDigest = finalMachines.find(
    (machine) => !machine.resolvedImageDigest,
  );
  if (missingResolvedDigest) {
    throw new Error(
      `${input.appName} Machine ${missingResolvedDigest.id} has no resolved image digest.`,
    );
  }
  const resolvedImageDigests = new Set(
    finalMachines.map((machine) => machine.resolvedImageDigest),
  );
  if (resolvedImageDigests.size !== 1) {
    throw new Error(
      `${input.appName} Machines resolved ${input.image} to different image digests.`,
    );
  }
  return {
    image: input.image,
    resolvedImageDigest: finalMachines[0]!.resolvedImageDigest!,
    stale: false,
  };
}

export function isNewerProductionImage(current: string, requested: string) {
  const currentBuild = productionBuildOrdinal(current);
  const requestedBuild = productionBuildOrdinal(requested);
  if (
    !(currentBuild && requestedBuild) ||
    currentBuild.repository !== requestedBuild.repository
  ) {
    return false;
  }
  return (
    currentBuild.runNumber > requestedBuild.runNumber ||
    (currentBuild.runNumber === requestedBuild.runNumber &&
      currentBuild.runAttempt > requestedBuild.runAttempt)
  );
}

function sameProductionImage(current: string, requested: string) {
  return current === requested;
}

function productionBuildOrdinal(image: string) {
  const match = image.match(
    /^(.+):production-([1-9][0-9]*)-([1-9][0-9]*)$/u,
  );
  if (!match) return null;
  return {
    repository: match[1]!,
    runNumber: Number(match[2]),
    runAttempt: Number(match[3]),
  };
}

async function startAndVerifyMachine(
  input: {
    fly: PlatformFlyClient;
    appName: string;
    healthCheck: FlyMachineHealthCheck;
    image: string;
  },
  machineId: string,
) {
  try {
    await input.fly.updateMachineImage({
      appName: input.appName,
      machineId,
      runtimeImage: input.image,
      healthCheck: input.healthCheck,
    });
    await input.fly.startMachine({ appName: input.appName, machineId });
    await verifyRunningMachine(input, machineId);
  } catch (error) {
    await stopAndWait(input, machineId).catch(() => undefined);
    throw error;
  }
}

async function updateAndVerifyRunningMachine(
  input: {
    fly: PlatformFlyClient;
    appName: string;
    healthCheck: FlyMachineHealthCheck;
    image: string;
  },
  machineId: string,
) {
  await input.fly.updateMachineImage({
    appName: input.appName,
    machineId,
    runtimeImage: input.image,
    healthCheck: input.healthCheck,
  });
  await verifyRunningMachine(input, machineId);
}

async function verifyRunningMachine(
  input: {
    fly: PlatformFlyClient;
    appName: string;
    healthCheck: FlyMachineHealthCheck;
  },
  machineId: string,
) {
  await input.fly.waitForMachine({
    appName: input.appName,
    machineId,
    state: "started",
  });
  await input.fly.waitForMachineHealth({
    appName: input.appName,
    machineId,
    checkName: input.healthCheck.name,
  });
}

async function stopAndWait(
  input: Pick<Parameters<typeof deployPlatformImage>[0], "fly" | "appName">,
  machineId: string,
) {
  await input.fly.stopMachine({ appName: input.appName, machineId });
  await input.fly.waitForMachine({
    appName: input.appName,
    machineId,
    state: "stopped",
  });
}

function createPlatformFlyClient() {
  return new FlyMachinesClient({
    token: process.env.FLY_API_TOKEN ?? "",
    organizationSlug: process.env.KESTREL_FLY_ORGANIZATION_SLUG ?? "",
  });
}
