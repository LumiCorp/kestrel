import { handleAppRuntimeRequest } from "@/lib/apps/runtime-route";

type LegacyTavilyRouteContext = {
  params: Promise<{
    capability: string;
    approval: string;
    path: string[];
  }>;
};

async function handle(request: Request, context: LegacyTavilyRouteContext) {
  const params = await context.params;
  return handleAppRuntimeRequest({
    request,
    appKey: "tavily",
    capabilityKey: params.capability,
    approval: params.approval,
    path: params.path,
  });
}

export const GET = handle;
export const POST = handle;
