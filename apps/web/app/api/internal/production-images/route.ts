import { ZodError } from "zod";
import {
  applyProductionImage,
  authorizeProductionImageRequest,
  productionImageInputSchema,
  ProductionImageAuthorizationError,
} from "@/lib/deployment/production-images";
import {
  isProductionMigrationApplied,
  isTagCapableEnvironmentLifecycleWorker,
} from "@/lib/deployment/production-image-readiness";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

type ReadinessDependencies = {
  migrationApplied: typeof isProductionMigrationApplied;
  runtimeConsumerReady: typeof isTagCapableEnvironmentLifecycleWorker;
};

const readinessDependencies: ReadinessDependencies = {
  migrationApplied: isProductionMigrationApplied,
  runtimeConsumerReady: isTagCapableEnvironmentLifecycleWorker,
};

export function GET(request: Request) {
  return productionImageReadiness(request, readinessDependencies);
}

export async function productionImageReadiness(
  request: Request,
  dependencies: ReadinessDependencies,
) {
  try {
    authorizeProductionImageRequest(request.headers.get("authorization"));
    const url = new URL(request.url);
    const requiredMigration = url.searchParams.get("requiredMigration") ?? "";
    const kind = url.searchParams.get("kind");
    if (!(await dependencies.migrationApplied(requiredMigration))) {
      return Response.json(
        { ok: false, requiredMigration },
        { status: 503 },
      );
    }
    if (
      kind === "environment-runtime" &&
      !(await dependencies.runtimeConsumerReady())
    ) {
      return Response.json(
        { ok: false, runtimeConsumer: "control-worker" },
        { status: 503 },
      );
    }
    if (kind !== "platform" && kind !== "environment-runtime") {
      return Response.json(
        { ok: false, error: { code: "INVALID_PRODUCTION_IMAGE_KIND" } },
        { status: 400 },
      );
    }
    return Response.json({ ok: true, migration: requiredMigration });
  } catch (error) {
    if (error instanceof ProductionImageAuthorizationError) {
      return unauthorizedResponse();
    }
    console.error("[production-images] readiness failed", error);
    return Response.json(
      { ok: false, error: { code: "PRODUCTION_IMAGE_READINESS_FAILED" } },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    authorizeProductionImageRequest(request.headers.get("authorization"));
    const input = productionImageInputSchema.parse(await request.json());
    const result = await applyProductionImage(input);
    return Response.json(
      { ok: true, result },
      { status: input.kind === "environment-runtime" ? 202 : 200 },
    );
  } catch (error) {
    if (error instanceof ProductionImageAuthorizationError) {
      return unauthorizedResponse();
    }
    if (error instanceof ZodError) {
      return Response.json(
        { ok: false, error: { code: "INVALID_PRODUCTION_IMAGE" } },
        { status: 400 },
      );
    }
    console.error("[production-images] deployment failed", error);
    return Response.json(
      { ok: false, error: { code: "PRODUCTION_IMAGE_DEPLOYMENT_FAILED" } },
      { status: 500 },
    );
  }
}

function unauthorizedResponse() {
  return Response.json(
    { ok: false, error: { code: "UNAUTHORIZED" } },
    { status: 401 },
  );
}
