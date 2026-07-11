"use server";

import { auth } from "@/app/(auth)/auth";
import { getArtifactSuggestionsByDocumentId } from "@/lib/artifacts/store";

export async function getSuggestions({ documentId }: { documentId: string }) {
  const session = await auth();

  if (!session?.user?.id) {
    return [];
  }

  const organizationId = (
    session as typeof session & {
      session?: { activeOrganizationId?: string | null };
    }
  ).session?.activeOrganizationId;

  if (!organizationId) {
    return [];
  }

  const suggestions = await getArtifactSuggestionsByDocumentId({
    documentId,
    userId: session.user.id,
    organizationId,
  });
  return suggestions ?? [];
}
