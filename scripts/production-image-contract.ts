import { z } from "zod";

export const productionImageTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u, "Invalid container image tag.");

export const flyImageCatalogSchema = z.object({
  version: z.literal(1),
  images: z
    .array(
      z
        .object({
          role: z.enum([
            "workspace-runtime",
            "environment-router",
            "preview-edge",
            "turn-worker",
            "control-worker",
            "runpod-worker",
          ]),
          publisher: z.enum(["fly", "ghcr"]),
          repository: z.string().trim().min(1),
          app: z.string().trim().min(1),
          dockerfile: z.string().trim().min(1),
          smoke: z.string().trim().min(1),
          rollout: z.enum(["environment", "global-app"]),
        })
        .superRefine((image, context) => {
          const expectedRepository =
            image.publisher === "fly"
              ? `registry.fly.io/${image.app}`
              : image.role === "workspace-runtime"
                ? "ghcr.io/lumicorp/kestrel-workspace-runtime"
                : image.role === "environment-router"
                  ? "ghcr.io/lumicorp/kestrel-environment-router"
                  : null;
          if (!expectedRepository || image.repository !== expectedRepository) {
            context.addIssue({
              code: "custom",
              message: `Image '${image.role}' has an invalid publisher repository.`,
              path: ["repository"],
            });
          }
        }),
    )
    .length(6),
});

export type FlyImageCatalog = z.infer<typeof flyImageCatalogSchema>;
