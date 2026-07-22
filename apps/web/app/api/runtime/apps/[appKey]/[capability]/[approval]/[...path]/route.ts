import { handleAppRuntimeRequest } from "@/lib/apps/runtime-route";

type RuntimeRouteContext = {
  params: Promise<{
    appKey: string;
    capability: string;
    approval: string;
    path: string[];
  }>;
};

async function handle(request: Request, context: RuntimeRouteContext) {
  const params = await context.params;
  return handleAppRuntimeRequest({
    request,
    appKey: params.appKey,
    capabilityKey: params.capability,
    approval: params.approval,
    path: params.path,
  });
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
