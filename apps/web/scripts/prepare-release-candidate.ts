import { z } from "zod";
import { deployStoredControlWorkerCandidate } from "./deploy-control-worker-candidate";
import { readControlWorkerInventory } from "./control-worker-machine";
import { runStreamingCommand } from "./streaming-command";

const preparationSchema = z.object({
  preparation: z.object({
    releaseId: z.string().uuid(),
    bundleRevision: z.string().regex(/^[a-f0-9]{40}$/u),
    controller: z.object({
      image: z.string().min(1),
      inputFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
      contractRevision: z.number().int().positive(),
    }),
    runtimeImages: z.object({
      router: z
        .string()
        .regex(
          /^ghcr\.io\/lumicorp\/kestrel-environment-router@sha256:[a-f0-9]{64}$/u,
        ),
      workspace: z
        .string()
        .regex(
          /^ghcr\.io\/lumicorp\/kestrel-workspace-runtime@sha256:[a-f0-9]{64}$/u,
        ),
    }),
  }),
});
const preparationCompletionSchema = z.object({
  release: z.object({
    id: z.string().uuid(),
    status: z.literal("candidate"),
    controllerPreparedAt: z.string().datetime(),
    migrationVerifiedAt: z.string().datetime(),
  }),
});

async function main() {
  const releaseId = z.string().uuid().parse(process.argv[2]);
  const revision = z
    .string()
    .regex(/^[a-f0-9]{40}$/u)
    .parse(process.argv[3]);
  const prepareUrl = required("KESTREL_RELEASE_PREPARE_URL");
  const accessToken = required("FLY_API_TOKEN");
  const preparation = await requestPreparation(prepareUrl, releaseId, revision);
  if (preparation.bundleRevision !== revision) {
    throw new Error(
      "Candidate revision does not match the checked-out revision.",
    );
  }
  await deployStoredControlWorkerCandidate({
    revision,
    image: preparation.controller.image,
    fingerprint: preparation.controller.inputFingerprint,
    routerImage: preparation.runtimeImages.router,
    workspaceImage: preparation.runtimeImages.workspace,
    accessToken,
    dependencies: {
      readInventory: readControlWorkerInventory,
      run: async (command, args, env) => {
        await runStreamingCommand(command, args, {
          cwd: process.cwd(),
          env: env ?? process.env,
        });
      },
      wait: (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)),
      write: (message) => process.stdout.write(message),
    },
  });
  const token = await oidcToken();
  const response = await fetch(prepareUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ releaseId, revision }),
  });
  if (!response.ok) {
    throw new Error(
      `Candidate preparation proof failed (${response.status}${await responseErrorSuffix(response)}).`,
    );
  }
  const completion = preparationCompletionSchema.parse(await response.json());
  if (completion.release.id !== releaseId) {
    throw new Error("Candidate preparation response returned another release.");
  }
  process.stdout.write(`Prepared release candidate ${releaseId}.\n`);
}

async function requestPreparation(
  prepareUrl: string,
  releaseId: string,
  revision: string,
) {
  const url = new URL(prepareUrl);
  url.searchParams.set("releaseId", releaseId);
  url.searchParams.set("revision", revision);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${await oidcToken()}` },
  });
  if (!response.ok) {
    throw new Error(
      `Candidate preparation preflight failed (${response.status}${await responseErrorSuffix(response)}).`,
    );
  }
  return preparationSchema.parse(await response.json()).preparation;
}

async function responseErrorSuffix(response: Response) {
  try {
    const payload = z
      .object({ error: z.object({ code: z.string().min(1) }) })
      .parse(await response.json());
    return `: ${payload.error.code}`;
  } catch {
    return "";
  }
}

async function oidcToken() {
  const url = new URL(required("ACTIONS_ID_TOKEN_REQUEST_URL"));
  url.searchParams.set("audience", "kestrel-one-release-publisher");
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${required("ACTIONS_ID_TOKEN_REQUEST_TOKEN")}`,
    },
  });
  if (!response.ok) throw new Error("GitHub OIDC token request failed.");
  return z.object({ value: z.string().min(1) }).parse(await response.json())
    .value;
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Candidate preparation failed."}\n`,
  );
  process.exitCode = 1;
});
