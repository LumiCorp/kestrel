import "server-only";

import {
  completeHostedBrowserDownload,
  getThreadFileForUser,
  initializeThreadFile,
  uploadHostedBrowserDownload,
  readHostedBrowserDownloadPromotion,
  prepareHostedBrowserDownload,
  uploadThreadFile,
} from "@/lib/files/service";
import { HostedBrowserArtifactAuthority } from "./artifact-authority";

export function createHostedBrowserArtifactAuthority(
  privateKeyPem: string,
): HostedBrowserArtifactAuthority {
  return new HostedBrowserArtifactAuthority({
    privateKeyPem,
    files: {
      initialize: async (input) => initializeThreadFile({
        threadId: input.threadId,
        organizationId: input.organizationId,
        userId: input.userId,
        filename: input.filename,
        sizeBytes: input.sizeBytes,
        declaredMediaType: input.declaredMediaType,
        trustedFileId: input.fileId,
      }),
      upload: async (input) => uploadThreadFile({
        fileId: input.fileId,
        threadId: input.threadId,
        organizationId: input.organizationId,
        userId: input.userId,
        body: input.body,
        contentLength: input.contentLength,
        expectedSha256: input.expectedSha256,
        expectedMediaType: "image/png",
        singleUseDraft: true,
      }),
      read: getThreadFileForUser,
      uploadDownload: uploadHostedBrowserDownload,
      prepareDownload: prepareHostedBrowserDownload,
      commitDownload: completeHostedBrowserDownload,
      readDownloadPromotion: readHostedBrowserDownloadPromotion,
    },
  });
}

export function resolveHostedBrowserArtifactAuthority(): HostedBrowserArtifactAuthority {
  const privateKeyPem = process.env.KESTREL_BROWSER_CAPABILITY_PRIVATE_KEY?.trim();
  if (!privateKeyPem) throw new Error("BROWSER_ARTIFACT_UPLOAD_DENIED");
  return createHostedBrowserArtifactAuthority(privateKeyPem);
}
