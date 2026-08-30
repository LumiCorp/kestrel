import { resolveHostedBrowserArtifactAuthority } from "@/lib/browser/artifact-composition";
import { handleHostedBrowserArtifactUpload } from "@/lib/browser/artifact-upload-route";

export async function PUT(
  request: Request,
  context: { params: Promise<{ fileId: string }> },
) {
  const { fileId } = await context.params;
  return handleHostedBrowserArtifactUpload({
    request,
    fileId,
    authority: resolveHostedBrowserArtifactAuthority(),
  });
}
