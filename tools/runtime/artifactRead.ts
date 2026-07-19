import type { SharedToolModule } from "../contracts.js";
import { createToolInputError, parseObjectInput, readNumber, readString } from "../helpers.js";
import { readTextArtifact } from "./artifactStore.js";

const DEFAULT_ARTIFACT_PAGE_BYTES = 8 * 1024;
const MAX_ARTIFACT_PAGE_BYTES = 8 * 1024;

export const artifactReadTool: SharedToolModule = {
  definition: {
    name: "artifact.read",
    description: "Read an immutable tool-output, transcript, or patch artifact by reference. Continue with nextOffsetBytes until complete is true.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", minLength: 1 },
        offsetBytes: { type: "number", minimum: 0 },
        maxBytes: { type: "number", minimum: 1, maximum: MAX_ARTIFACT_PAGE_BYTES },
      },
      required: ["ref"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "runtime",
      latencyClass: "low",
      costClass: "free",
      executionClass: "read_only",
      capabilityClasses: ["runtime.artifact.read"],
    },
    presentation: {
      displayName: "Read Artifact",
      aliases: ["read artifact", "continue output", "read raw output"],
      keywords: ["artifact", "output", "transcript", "patch", "continue"],
      provider: "kestrel",
      toolFamily: "runtime",
    },
  },
  createHandler() {
    return async (input: unknown) => {
      const body = parseObjectInput("artifact.read", input);
      const ref = readString(body, "ref")?.trim();
      if (ref === undefined || ref.length === 0) {
        throw createToolInputError("artifact.read", "artifact.read requires input.ref.", { field: "ref" });
      }
      const artifact = readTextArtifact(ref);
      if (artifact === undefined) {
        throw createToolInputError("artifact.read", `Artifact is unavailable: ${ref}`, {
          ref,
          recoverable: false,
        });
      }
      const requestedOffset = Math.max(0, Math.trunc(readNumber(body, "offsetBytes") ?? 0));
      if (requestedOffset > artifact.byteLength) {
        throw createToolInputError("artifact.read", "offsetBytes is beyond the end of the artifact.", {
          ref,
          offsetBytes: requestedOffset,
          totalBytes: artifact.byteLength,
        });
      }
      const completeBuffer = Buffer.from(artifact.content, "utf8");
      if (requestedOffset > 0 && requestedOffset < completeBuffer.length && (completeBuffer[requestedOffset]! & 0xc0) === 0x80) {
        throw createToolInputError("artifact.read", "offsetBytes must use a nextOffsetBytes value returned by artifact.read.", {
          ref,
          offsetBytes: requestedOffset,
        });
      }
      const maxBytes = Math.min(
        MAX_ARTIFACT_PAGE_BYTES,
        Math.max(1, Math.trunc(readNumber(body, "maxBytes") ?? DEFAULT_ARTIFACT_PAGE_BYTES)),
      );
      const buffer = completeBuffer;
      const end = utf8SafeEnd(buffer, requestedOffset, Math.min(buffer.length, requestedOffset + maxBytes));
      const content = buffer.subarray(requestedOffset, end).toString("utf8");
      const complete = end >= buffer.length;
      return {
        ref,
        content,
        contentType: artifact.contentType,
        sha256: artifact.sha256,
        range: { startByte: requestedOffset, endByte: end },
        totalBytes: buffer.length,
        complete,
        ...(complete ? {} : { nextOffsetBytes: end }),
      };
    };
  },
};

function utf8SafeEnd(buffer: Buffer, start: number, requestedEnd: number): number {
  let end = requestedEnd;
  while (end > start && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return end === start && requestedEnd < buffer.length ? requestedEnd : end;
}
