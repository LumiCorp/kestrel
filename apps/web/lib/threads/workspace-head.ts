import "server-only";
import { z } from "zod";
import { resolveEnvironmentExecutionRoute } from "@/lib/environments/execution-route";
import { getThreadExecutionBindingState } from "@/lib/environments/store";

const responseSchema = z.object({
  head: z.string().regex(/^[a-f0-9]{40,64}$/u),
});

export async function readThreadWorkspaceHead(input: {
  organizationId: string;
  threadId: string;
  actorUserId: string;
  unprovisionedBaseRef: string | null;
}) {
  const binding = await getThreadExecutionBindingState({
    organizationId: input.organizationId,
    threadId: input.threadId,
  });
  if (!binding) {
    return input.unprovisionedBaseRef;
  }
  const route = await resolveEnvironmentExecutionRoute({
    organizationId: input.organizationId,
    threadId: input.threadId,
    actorUserId: input.actorUserId,
  });
  const response = await fetch(
    new URL("/v1/worktrees/current-head", route.baseUrl),
    {
      headers: { authorization: `Bearer ${route.authToken}` },
      cache: "no-store",
    },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error("The source Thread worktree HEAD is unavailable.");
  }
  return responseSchema.parse(body).head;
}
