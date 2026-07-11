import { getDirectRuntimeConfig } from "@/lib/ai/surface-policy";

export function getKnowledgeOcrMode() {
  return getDirectRuntimeConfig("ocr").mode;
}
