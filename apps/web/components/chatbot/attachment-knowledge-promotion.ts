import type { Attachment } from "@/lib/types";

export function selectKnowledgePromotionCandidates(
  attachments: Attachment[],
): Attachment[] {
  return attachments.filter((attachment) => attachment.knowledgeEligible === true);
}
