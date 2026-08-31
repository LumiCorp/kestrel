import {
  BROWSER_SERVICE_PORT_VERSION,
  parseBrowserAllowlistAdoptionReceiptV1,
  parseBrowserAuthorizedArtifactV1,
  parseBrowserPolicyResolutionV1,
  parseBrowserUploadPreparedEffectV1,
  type BrowserServicePort,
} from "../../src/browser/contracts.js";
import type { PreparedToolCallV1 } from "../../src/kestrel/contracts/tool-invocation.js";
import { RuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import type { SharedToolContext } from "../contracts.js";
import { resolveKestrelOneBrowserRequest } from "./appTransport.js";

type DispatchReceipt = {
  version: "hosted_browser_dispatch_receipt_v1";
  receiptId: string;
  operationId: string;
  operation: string;
};

type CommitReceipt = {
  version: "hosted_browser_commit_receipt_v1";
  receiptId: string;
  operationId: string;
  operation: string;
};

type UploadStagedReceipt = {
  version: "hosted_browser_upload_staged_receipt_v1";
  receiptId: string;
  operationId: string;
  operation: "browser.upload";
};

export function createKestrelOneBrowserService(
  context: SharedToolContext,
): BrowserServicePort {
  const request = async (capability: string, action: string, body: unknown) => {
    const transport = resolveKestrelOneBrowserRequest(
      context,
      `/api/runtime/apps/built_in.browser/${encodeURIComponent(capability)}/auto/control/${encodeURIComponent(action)}`,
    );
    const response = await (context.fetchImpl ?? fetch)(transport.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${transport.authorization}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = readErrorCode(payload) ?? "BROWSER_SERVICE_UNAVAILABLE";
      const upstreamDetails = readErrorDetails(payload);
      throw new RuntimeFailure(code, code, {
        subsystem: "browser",
        classification: response.status >= 500 ? "runtime" : "policy",
        status: response.status,
        recoverable: response.status >= 500,
        ...upstreamDetails,
      });
    }
    return payload;
  };
  return {
    version: BROWSER_SERVICE_PORT_VERSION,
    async resolvePolicy(input) {
      return parseBrowserPolicyResolutionV1(
        await request("request_grant", "policy", input),
      );
    },
    async prepareUpload(input) {
      return parseBrowserUploadPreparedEffectV1(
        await request("upload", "prepare-upload", input),
      );
    },
    async execute(prepared: PreparedToolCallV1, lifecycle) {
      const capability = prepared.activation.descriptor.toolId.slice(
        "browser.".length,
      );
      const accepted = await request(capability, "accept", {
        prepared,
        authority: lifecycle.authority,
      });
      const preDispatch = readPreDispatchResult(accepted, prepared);
      if (preDispatch) {
        await lifecycle.persistCompletedResult(preDispatch.output);
        await request(capability, "commit", {
          receipt: preDispatch.commitReceipt,
        }).catch(() => undefined);
        return preDispatch.output;
      }
      const receipt = accepted as DispatchReceipt;
      assertDispatchReceipt(receipt, prepared);
      let invokeReceipt: DispatchReceipt | UploadStagedReceipt = receipt;
      if (prepared.activation.descriptor.toolId === "browser.upload") {
        const staged = await request(capability, "invoke", {
          prepared,
          authority: lifecycle.authority,
          receipt,
        }) as UploadStagedReceipt;
        assertUploadStagedReceipt(staged, prepared, receipt);
        invokeReceipt = staged;
      }
      await lifecycle.acknowledgeDispatch();
      const invocation = requireRecord(await request(capability, "invoke", {
        prepared,
        authority: lifecycle.authority,
        receipt: invokeReceipt,
      }));
      if (invocation.version !== "hosted_browser_invocation_result_v1") {
        throw new RuntimeFailure(
          "BROWSER_ENGINE_FAILURE",
          "Hosted Browser invocation result is invalid.",
          { subsystem: "browser", classification: "runtime", recoverable: false },
        );
      }
      const output = invocation.output;
      const commitReceipt = invocation.commitReceipt as CommitReceipt;
      assertCommitReceipt(commitReceipt, prepared, receipt);
      await lifecycle.persistCompletedResult(output);
      await request(capability, "commit", { receipt: commitReceipt }).catch(
        () => undefined,
      );
      return output;
    },
    async authorizeArtifact(input) {
      const payload = await request(
        input.toolName.slice("browser.".length),
        "artifact",
        input,
      );
      return payload === null
        ? undefined
        : parseBrowserAuthorizedArtifactV1(payload, input);
    },
    async adoptAllowlistRevision(input) {
      return parseBrowserAllowlistAdoptionReceiptV1(
        await request("request_grant", "adopt", input),
      );
    },
  };
}

function assertUploadStagedReceipt(
  staged: UploadStagedReceipt,
  prepared: PreparedToolCallV1,
  accepted: DispatchReceipt,
): void {
  if (
    staged?.version !== "hosted_browser_upload_staged_receipt_v1" ||
    staged.receiptId !== accepted.receiptId ||
    staged.operationId !== prepared.callId ||
    staged.operation !== "browser.upload"
  ) {
    throw new RuntimeFailure(
      "BROWSER_ENGINE_FAILURE",
      "Hosted Browser upload staging receipt is invalid.",
      { subsystem: "browser", classification: "runtime", recoverable: false },
    );
  }
}

function readPreDispatchResult(
  value: unknown,
  prepared: PreparedToolCallV1,
): { output: unknown; commitReceipt: CommitReceipt } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (record.version !== "hosted_browser_pre_dispatch_result_v1") return;
  const commitReceipt = record.commitReceipt as CommitReceipt;
  assertCommitReceipt(commitReceipt, prepared, {
    version: "hosted_browser_dispatch_receipt_v1",
    receiptId: commitReceipt?.receiptId,
    operationId: prepared.callId,
    operation: prepared.activation.descriptor.toolId,
  });
  return { output: record.output, commitReceipt };
}

function assertCommitReceipt(
  receipt: CommitReceipt,
  prepared: PreparedToolCallV1,
  accepted: DispatchReceipt,
) {
  if (
    receipt?.version !== "hosted_browser_commit_receipt_v1" ||
    typeof receipt.receiptId !== "string" ||
    receipt.receiptId.length === 0 ||
    receipt.receiptId !== accepted.receiptId ||
    receipt.operationId !== prepared.callId ||
    receipt.operation !== prepared.activation.descriptor.toolId
  ) {
    throw new RuntimeFailure(
      "BROWSER_ENGINE_FAILURE",
      "Hosted Browser commit receipt is invalid.",
      { subsystem: "browser", classification: "runtime", recoverable: false },
    );
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeFailure(
      "BROWSER_ENGINE_FAILURE",
      "Hosted Browser response is invalid.",
      { subsystem: "browser", classification: "runtime", recoverable: false },
    );
  }
  return value as Record<string, unknown>;
}

function readErrorDetails(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const error = (value as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return {};
  const details = (error as Record<string, unknown>).details;
  return details && typeof details === "object" && !Array.isArray(details)
    ? details as Record<string, unknown>
    : {};
}

function assertDispatchReceipt(
  receipt: DispatchReceipt,
  prepared: PreparedToolCallV1,
): void {
  if (
    receipt?.version !== "hosted_browser_dispatch_receipt_v1" ||
    receipt.operationId !== prepared.callId ||
    receipt.operation !== prepared.activation.descriptor.toolId ||
    typeof receipt.receiptId !== "string" ||
    receipt.receiptId.length === 0
  ) {
    throw new RuntimeFailure(
      "BROWSER_ENGINE_FAILURE",
      "Hosted Browser acceptance receipt is invalid.",
      {
        subsystem: "browser",
        classification: "runtime",
        recoverable: false,
      },
    );
  }
}

function readErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return;
  const error = (value as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}
