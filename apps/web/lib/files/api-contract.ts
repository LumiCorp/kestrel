import { isKnowledgeDocumentMediaTypeSupported } from "@/lib/knowledge/documents/shared";
import { modelVisibleMetadataOnlyReason } from "./representation";

export function fileApiRepresentationContract(input: {
  filename: string;
  detectedMediaType: string | null | undefined;
  representationStatus: string;
  metadataOnlyReason: string | null | undefined;
}): {
  metadataOnlyReason: string | undefined;
  knowledgeEligible: boolean;
} {
  return {
    metadataOnlyReason: modelVisibleMetadataOnlyReason(
      input.representationStatus,
      input.metadataOnlyReason,
    ),
    knowledgeEligible: input.detectedMediaType
      ? isKnowledgeDocumentMediaTypeSupported(
          input.detectedMediaType,
          input.filename,
        )
      : false,
  };
}
