import type { Attachment } from "@/lib/types";

export type KnowledgePromotionSingleFlight = { current: boolean };

export function beginKnowledgePromotion(
  singleFlight: KnowledgePromotionSingleFlight,
): boolean {
  if (singleFlight.current) return false;
  singleFlight.current = true;
  return true;
}

export function finishKnowledgePromotion(
  singleFlight: KnowledgePromotionSingleFlight,
): void {
  singleFlight.current = false;
}

export function selectKnowledgePromotionCandidates(
  attachments: Attachment[],
): Attachment[] {
  return attachments.filter((attachment) => attachment.knowledgeEligible === true);
}
