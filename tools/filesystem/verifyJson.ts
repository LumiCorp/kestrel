import type { SharedToolModule } from "../contracts.js";
import { parseObjectInput, parseOptionalStringArray, readString } from "../helpers.js";
import {
  createFileSystemCapability,
  createFileSystemPresentation,
  DEFAULT_FILE_READ_MAX_BYTES,
  MAX_FILE_READ_BYTES,
  MAX_JSON_VERIFICATION_FAILURES,
  MAX_JSON_VERIFICATION_REQUIREMENTS,
  clampPositiveInt,
  readOptionalPositiveInt,
  readRequiredPath,
  readUtf8TextFile,
} from "./shared.js";

type VerificationStatus = "passed" | "failed";

interface VerificationRequirement {
  id: string;
  expectation: string;
  observed: string;
  status: VerificationStatus;
}

export const fsVerifyJsonTool: SharedToolModule = {
  definition: {
    name: "fs.verify_json",
    description: "Verify a JSON artifact against an explicit structured contract.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        arrayPath: { type: "string" },
        minLength: { type: "number" },
        requiredStringFields: {
          type: "array",
          items: { type: "string" },
        },
        requiredAbsoluteUrlFields: {
          type: "array",
          items: { type: "string" },
        },
        forbiddenStringLiterals: {
          type: "array",
          items: { type: "string" },
        },
        maxBytes: { type: "number" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    capability: createFileSystemCapability("fs.verify", "read_only"),
    presentation: createFileSystemPresentation({
      displayName: "Verify JSON Artifact",
      aliases: ["verify json", "json verifier", "artifact verification"],
      keywords: ["verify", "json", "artifact", "validation", "filesystem"],
    }),
  },
  createHandler(context) {
    return async (input: unknown) => {
      const body = parseObjectInput("fs.verify_json", input);
      const targetPath = readRequiredPath(body, "path", "fs.verify_json");
      const maxBytes = clampPositiveInt(
        readOptionalPositiveInt(body, "maxBytes") ?? DEFAULT_FILE_READ_MAX_BYTES,
        MAX_FILE_READ_BYTES,
      );
      const fileResult = await readUtf8TextFile({
        absolutePath: targetPath,
        config: context.fileSystem,
        maxBytes,
      });
      const arrayPath = readOptionalTrimmedString(body, "arrayPath");
      const minLength = readOptionalNonNegativeInteger(body.minLength);
      const requiredStringFields = parseOptionalStringArray(body, "requiredStringFields");
      const requiredAbsoluteUrlFields = parseOptionalStringArray(body, "requiredAbsoluteUrlFields");
      const forbiddenStringLiterals = parseOptionalStringArray(body, "forbiddenStringLiterals")
        .map((value) => value.toLowerCase());

      const target = arrayPath === undefined
        ? fileResult.displayPath
        : `${fileResult.displayPath}::${arrayPath}`;

      if (fileResult.truncated) {
        return buildVerificationResult({
          path: fileResult.displayPath,
          target,
          status: "failed",
          requirements: [
            {
              id: "json_size",
              expectation: `File fits within the JSON verification read budget of ${fileResult.maxBytes} byte(s).`,
              observed: `File exceeded the JSON verification read budget; read ${fileResult.bytesRead} byte(s).`,
              status: "failed",
            },
          ],
          failures: [`File exceeds JSON verification read budget of ${fileResult.maxBytes} byte(s).`],
          truncated: fileResult.truncated,
          bytesRead: fileResult.bytesRead,
          maxBytes: fileResult.maxBytes,
        });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(fileResult.content);
      } catch {
        return buildVerificationResult({
          path: fileResult.displayPath,
          target,
          status: "failed",
          requirements: [
            {
              id: "json_parse",
              expectation: "File contains valid JSON.",
              observed: "File could not be parsed as JSON.",
              status: "failed",
            },
          ],
          failures: ["File does not contain valid JSON."],
          truncated: fileResult.truncated,
          bytesRead: fileResult.bytesRead,
          maxBytes: fileResult.maxBytes,
        });
      }

      const sink = createVerificationSink();
      sink.addRequirement({
        id: "json_parse",
        expectation: "File contains valid JSON.",
        observed: "JSON parsed successfully.",
        status: "passed",
      });

      let arrayValue: unknown[] | undefined;
      if (arrayPath !== undefined) {
        const resolvedArray = resolveJsonPathValue(parsed, arrayPath);
        if (Array.isArray(resolvedArray)) {
          arrayValue = resolvedArray;
          sink.addRequirement({
            id: "array_path",
            expectation: `${arrayPath} resolves to an array.`,
            observed: `${arrayPath} resolved to an array with ${resolvedArray.length} item(s).`,
            status: "passed",
          });
        } else {
          sink.addRequirement({
            id: "array_path",
            expectation: `${arrayPath} resolves to an array.`,
            observed: `${arrayPath} did not resolve to an array.`,
            status: "failed",
          });
          sink.addFailure(`${arrayPath} is not an array.`);
        }
      }

      if (minLength !== undefined) {
        if (arrayValue === undefined) {
          sink.addRequirement({
            id: "min_length",
            expectation: `Array contains at least ${minLength} item(s).`,
            observed: "Array length could not be evaluated because the array path was unavailable.",
            status: "failed",
          });
          sink.addFailure(`Array length could not be validated for minimum ${minLength}.`);
        } else if (arrayValue.length >= minLength) {
          sink.addRequirement({
            id: "min_length",
            expectation: `Array contains at least ${minLength} item(s).`,
            observed: `Array contains ${arrayValue.length} item(s).`,
            status: "passed",
          });
        } else {
          sink.addRequirement({
            id: "min_length",
            expectation: `Array contains at least ${minLength} item(s).`,
            observed: `Array contains ${arrayValue.length} item(s).`,
            status: "failed",
          });
          sink.addFailure(`Array length ${arrayValue.length} is below required minimum ${minLength}.`);
        }
      }

      if (
        arrayValue !== undefined &&
        (requiredStringFields.length > 0 || requiredAbsoluteUrlFields.length > 0 || forbiddenStringLiterals.length > 0)
      ) {
        for (let index = 0; index < arrayValue.length; index += 1) {
          const entry = arrayValue[index];
          const record = isRecord(entry) ? entry : undefined;
          if (record === undefined) {
            sink.addRequirement({
              id: `entry:${index}`,
              expectation: `Array entry ${index} is an object.`,
              observed: `Array entry ${index} is not an object.`,
              status: "failed",
            });
            sink.addFailure(`Array entry ${index} is not an object.`);
            continue;
          }

          for (const field of requiredStringFields) {
            const value = readOptionalTrimmedString(record, field);
            if (value !== undefined) {
              sink.addRequirement({
                id: `entry:${index}:field:${field}`,
                expectation: `${arrayPath ?? "root"}[${index}].${field} is present and non-blank.`,
                observed: `${arrayPath ?? "root"}[${index}].${field} is populated.`,
                status: "passed",
              });
            } else {
              sink.addRequirement({
                id: `entry:${index}:field:${field}`,
                expectation: `${arrayPath ?? "root"}[${index}].${field} is present and non-blank.`,
                observed: `${arrayPath ?? "root"}[${index}].${field} is missing or blank.`,
                status: "failed",
              });
              sink.addFailure(`${arrayPath ?? "root"}[${index}].${field} is missing or blank.`);
            }
          }

          for (const field of requiredAbsoluteUrlFields) {
            const value = readOptionalTrimmedString(record, field);
            if (value !== undefined && isAbsoluteHttpUrl(value)) {
              sink.addRequirement({
                id: `entry:${index}:url:${field}`,
                expectation: `${arrayPath ?? "root"}[${index}].${field} is an absolute http(s) URL.`,
                observed: `${arrayPath ?? "root"}[${index}].${field} is an absolute http(s) URL.`,
                status: "passed",
              });
            } else {
              sink.addRequirement({
                id: `entry:${index}:url:${field}`,
                expectation: `${arrayPath ?? "root"}[${index}].${field} is an absolute http(s) URL.`,
                observed: value === undefined
                  ? `${arrayPath ?? "root"}[${index}].${field} is missing or blank.`
                  : `${arrayPath ?? "root"}[${index}].${field} is not an absolute http(s) URL.`,
                status: "failed",
              });
              sink.addFailure(`${arrayPath ?? "root"}[${index}].${field} is not an absolute http(s) URL.`);
            }
          }

          if (forbiddenStringLiterals.length > 0) {
            for (const field of [...new Set([...requiredStringFields, ...requiredAbsoluteUrlFields])]) {
              const value = readOptionalTrimmedString(record, field);
              if (value === undefined) {
                continue;
              }
              const normalizedValue = value.toLowerCase();
              if (forbiddenStringLiterals.includes(normalizedValue)) {
                sink.addRequirement({
                  id: `entry:${index}:forbidden:${field}`,
                  expectation: `${arrayPath ?? "root"}[${index}].${field} does not use a forbidden placeholder literal.`,
                  observed: `${arrayPath ?? "root"}[${index}].${field} used forbidden literal '${value}'.`,
                  status: "failed",
                });
                sink.addFailure(`${arrayPath ?? "root"}[${index}].${field} uses forbidden placeholder '${value}'.`);
              }
            }
          }
        }
      }

      const details = sink.toResult();
      return buildVerificationResult({
        path: fileResult.displayPath,
        target,
        status: details.failureCount === 0 ? "passed" : "failed",
        requirements: details.requirements,
        failures: details.failures,
        truncated: fileResult.truncated,
        bytesRead: fileResult.bytesRead,
        maxBytes: fileResult.maxBytes,
        requirementsOmitted: details.requirementsOmitted,
        failuresOmitted: details.failuresOmitted,
      });
    };
  },
};

function buildVerificationResult(input: {
  path: string;
  target: string;
  status: VerificationStatus;
  requirements: VerificationRequirement[];
  failures: string[];
  truncated: boolean;
  bytesRead?: number | undefined;
  maxBytes?: number | undefined;
  requirementsOmitted?: number | undefined;
  failuresOmitted?: number | undefined;
}) {
  const summary = input.status === "passed"
    ? `Verified JSON artifact '${input.target}'.`
    : `JSON artifact verification failed for '${input.target}'.`;
  return {
    path: input.path,
    target: input.target,
    status: input.status,
    verificationToken: `verify:${input.target}`,
    truncated: input.truncated,
    ...(input.bytesRead !== undefined ? { bytesRead: input.bytesRead } : {}),
    ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
    summary,
    artifactVerification: {
      target: input.target,
      status: input.status,
      evidence: {
        kind: "tool_result",
        toolName: "fs.verify_json",
        truncated: input.truncated,
        summary,
      },
      requirements: input.requirements,
      ...(input.requirementsOmitted !== undefined && input.requirementsOmitted > 0
        ? { requirementsOmitted: input.requirementsOmitted }
        : {}),
      ...(input.failures.length > 0 ? { failures: input.failures } : {}),
      ...(input.failuresOmitted !== undefined && input.failuresOmitted > 0
        ? { failuresOmitted: input.failuresOmitted }
        : {}),
    },
  };
}

function createVerificationSink(): {
  addRequirement: (requirement: VerificationRequirement) => void;
  addFailure: (failure: string) => void;
  toResult: () => {
    requirements: VerificationRequirement[];
    failures: string[];
    failureCount: number;
    requirementsOmitted: number;
    failuresOmitted: number;
  };
} {
  const requirements: VerificationRequirement[] = [];
  const failures: string[] = [];
  let failureCount = 0;
  let requirementsOmitted = 0;
  let failuresOmitted = 0;

  return {
    addRequirement(requirement) {
      const reserveSummarySlot = requirementsOmitted > 0 || requirements.length >= MAX_JSON_VERIFICATION_REQUIREMENTS - 1;
      if (reserveSummarySlot) {
        requirementsOmitted += 1;
        return;
      }
      requirements.push(requirement);
    },
    addFailure(failure) {
      failureCount += 1;
      const reserveSummarySlot = failuresOmitted > 0 || failures.length >= MAX_JSON_VERIFICATION_FAILURES - 1;
      if (reserveSummarySlot) {
        failuresOmitted += 1;
        return;
      }
      failures.push(failure);
    },
    toResult() {
      if (requirementsOmitted > 0) {
        requirements.push({
          id: "details_omitted",
          expectation: "Verification detail output stays within the filesystem tool result budget.",
          observed: `${requirementsOmitted} requirement detail(s) were omitted.`,
          status: failuresOmitted > 0 ? "failed" : "passed",
        });
      }
      if (failuresOmitted > 0) {
        failures.push(`${failuresOmitted} additional verification failure(s) were omitted.`);
      }
      return {
        requirements,
        failures,
        failureCount,
        requirementsOmitted,
        failuresOmitted,
      };
    },
  };
}

function readOptionalTrimmedString(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const candidate = readString(value, key)?.trim();
  return candidate !== undefined && candidate.length > 0 ? candidate : undefined;
}

function readOptionalNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || Number.isFinite(value) === false) {
    return undefined;
  }
  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : undefined;
}

function resolveJsonPathValue(root: unknown, pathValue: string): unknown {
  const segments = pathValue
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (Number.isNaN(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (isRecord(current) === false) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.trim().length > 0;
  } catch {
    return false;
  }
}
