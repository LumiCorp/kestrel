import { asArray, asRecord, asString } from "../../shared/valueAccess.js";
import { buildEvidenceCompletionSummary } from "./evidenceLedger.js";

export interface BlockingArtifactVerification {
  status: "failed" | "inconclusive";
  target?: string | undefined;
  failures: string[];
}

export function readLatestArtifactVerificationFacts(
  evidenceLedger: unknown,
): Record<string, unknown> | undefined {
  const entries = asArray(evidenceLedger);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = asRecord(entries[index]);
    if (asString(entry?.kind) !== "artifact_verification") {
      continue;
    }
    const facts = asRecord(entry?.facts);
    if (facts !== undefined) {
      return facts;
    }
  }
  return undefined;
}

export function readLatestActiveArtifactVerificationFacts(
  evidenceLedger: unknown,
): Record<string, unknown> | undefined {
  const entries = asArray(evidenceLedger);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = asRecord(entries[index]);
    if (asString(entry?.kind) !== "artifact_verification") {
      continue;
    }
    const facts = asRecord(entry?.facts);
    if (facts === undefined) {
      continue;
    }
    const blocking = readBlockingArtifactVerification(facts);
    if (blocking === undefined) {
      return facts;
    }
    const laterCompletion = buildEvidenceCompletionSummary({
      ledger: entries.slice(index + 1),
    });
    const hasLaterConcreteSupport = laterCompletion.supportedTokens.some((token) =>
      token.startsWith("check:") ||
      token.startsWith("file:") ||
      token.startsWith("verify:")
    );
    if (hasLaterConcreteSupport) {
      return undefined;
    }
    return facts;
  }
  return undefined;
}

export function readBlockingArtifactVerification(
  artifactVerification: unknown,
): BlockingArtifactVerification | undefined {
  const record = asRecord(artifactVerification);
  const status = asString(record?.status);
  if (status !== "failed" && status !== "inconclusive") {
    return undefined;
  }
  if (record === undefined) {
    return undefined;
  }
  const target = asString(record.target);
  return {
    status,
    ...(target !== undefined ? { target } : {}),
    failures: asArray(record.failures)
      .map((item) => asString(item)?.trim())
      .filter((item): item is string => item !== undefined && item.length > 0),
  };
}
