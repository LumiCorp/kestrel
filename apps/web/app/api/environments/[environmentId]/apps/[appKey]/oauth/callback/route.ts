import { NextResponse } from "next/server";
import { z } from "zod";
import { completeOfficialRemoteOauthApp } from "@/lib/apps/official-remote-connection";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { routeIdSchema } from "@/lib/knowledge/validation";

const paramsSchema = z.object({
  environmentId: routeIdSchema,
  appKey: z.string().trim().min(1).max(160),
});

function returnUrl(input: {
  origin: string;
  environmentId?: string;
  appKey?: string;
  status: "connected" | "error";
}) {
  const path =
    input.environmentId && input.appKey
      ? `/settings/environments/${encodeURIComponent(input.environmentId)}/apps/${encodeURIComponent(input.appKey)}`
      : "/settings/environments";
  const url = new URL(path, input.origin);
  url.searchParams.set("app_connection", input.status);
  return url;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ environmentId: string; appKey: string }> }
) {
  const url = new URL(request.url);
  let environmentId: string | undefined;
  let appKey: string | undefined;
  try {
    const params = paramsSchema.parse(await context.params);
    environmentId = params.environmentId;
    appKey = decodeURIComponent(params.appKey);
    if (url.searchParams.has("error")) {
      return NextResponse.redirect(
        returnUrl({ origin: url.origin, environmentId, appKey, status: "error" })
      );
    }
    const query = z
      .object({ state: z.string().min(1), code: z.string().min(1) })
      .parse(Object.fromEntries(url.searchParams));
    const { organizationId, session } = await requireOrganizationAdmin();
    const connection = await completeOfficialRemoteOauthApp({
      organizationId,
      environmentId,
      appKey,
      actorUserId: session.user.id,
      ...query,
    });
    if (!connection) throw new Error("This App could not complete connected sign-in.");
    return NextResponse.redirect(
      returnUrl({
        origin: url.origin,
        environmentId,
        appKey,
        status: "connected",
      })
    );
  } catch {
    return NextResponse.redirect(
      returnUrl({
        origin: url.origin,
        environmentId,
        appKey,
        status: "error",
      })
    );
  }
}
