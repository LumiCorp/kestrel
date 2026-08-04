import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const gitRevisionSchema = z
  .string()
  .trim()
  .regex(/^[a-f0-9]{40}$/u, "Expected a full Git revision.");

export const flyImagePublicationStateSchema = z.discriminatedUnion(
  "requiresFullBundle",
  [
    z.object({
      requiresFullBundle: z.literal(true),
      stableBundleRevision: z.null(),
    }),
    z.object({
      requiresFullBundle: z.literal(false),
      stableBundleRevision: gitRevisionSchema,
    }),
  ],
);

export type FlyImagePublicationState = z.infer<
  typeof flyImagePublicationStateSchema
>;

export function selectFlyImageDiffBase(state: FlyImagePublicationState) {
  return state.requiresFullBundle ? undefined : state.stableBundleRevision;
}

export const flyImageCatalogSchema = z.object({
  version: z.literal(1),
  images: z
    .array(
      z.object({
        role: z.enum([
          "workspace-runtime",
          "environment-router",
          "preview-edge",
          "turn-worker",
          "runpod-worker",
        ]),
        app: z.string().trim().min(1),
        config: z.string().trim().min(1),
        dockerfile: z.string().trim().min(1),
        smoke: z.string().trim().min(1),
        rollout: z.enum(["environment", "global-app"]),
        inputs: z.array(z.string().trim().min(1)).min(1),
      }),
    )
    .length(5),
});

export type FlyImageCatalog = z.infer<typeof flyImageCatalogSchema>;
export type FlyImageCatalogEntry = FlyImageCatalog["images"][number];

export function impactedFlyImages(input: {
  catalog: FlyImageCatalog;
  changedPaths: string[];
  forceAll: boolean;
}) {
  if (input.forceAll) return input.catalog.images;
  return input.catalog.images.filter((image) =>
    input.changedPaths.some((path) =>
      image.inputs.some((pattern) => matchesCatalogInput(path, pattern)),
    ),
  );
}

export function flyMigrationChanged(changedPaths: string[]) {
  return changedPaths.some(
    (path) =>
      path.startsWith("apps/web/lib/db/migrations/") ||
      path.startsWith("apps/web/drizzle/"),
  );
}

export function matchesCatalogInput(path: string, pattern: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  const expression = escaped
    .replace(/\*\*/gu, "\u0000")
    .replace(/\*/gu, "[^/]*")
    .replace(/\u0000/gu, ".*");
  return new RegExp(`^${expression}$`, "u").test(path);
}

export async function fingerprintImageInputs(input: {
  image: FlyImageCatalogEntry;
  trackedPaths: string[];
  root: string;
}) {
  const paths = input.trackedPaths
    .filter((path) =>
      input.image.inputs.some((pattern) => matchesCatalogInput(path, pattern)),
    )
    .sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(`${input.root}/${path}`));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}
