import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { requireProjectRole } from "@/lib/projects/access";
import { getLastActiveProjectCookieName } from "@/lib/projects/last-active";

const activeProjectSchema = z.object({
  projectId: routeIdSchema,
});

export async function POST(request: Request) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { projectId } = activeProjectSchema.parse(await request.json());
    await requireProjectRole({
      projectId,
      organizationId,
      userId: session.user.id,
    });
    const cookieStore = await cookies();
    cookieStore.set(getLastActiveProjectCookieName(organizationId), projectId, {
      httpOnly: true,
      maxAge: 31_536_000,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
