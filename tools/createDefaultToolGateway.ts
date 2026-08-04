import { AllowlistedToolGateway } from "../src/io/ToolGateway.js";
import { BALANCED_STARTER_TOOL_NAMES, defaultToolCatalog } from "./catalog.js";
import type { SharedToolContext } from "./contracts.js";
import { withDefaultFileSystemPolicy } from "./filesystem/shared.js";

export interface CreateDefaultToolGatewayOptions {
  allowlist: string[];
  context?: SharedToolContext | undefined;
}

export function createDefaultToolGateway(options: CreateDefaultToolGatewayOptions): AllowlistedToolGateway {
  const handlers = defaultToolCatalog.createRawHandlers(
    options.allowlist,
    withDefaultFileSystemPolicy(options.context),
  );
  const normalizers = defaultToolCatalog.createResultNormalizers(
    options.allowlist,
  );
  return new AllowlistedToolGateway(
    options.allowlist.map((name) => {
      const descriptor = defaultToolCatalog.getDescriptor(name);
      const handler = handlers[name];
      const normalizer = normalizers[name];
      if (descriptor === undefined || handler === undefined || normalizer === undefined) {
        throw new Error(`Tool '${name}' is missing its compiled registration.`);
      }
      return { descriptor, handler, normalizer };
    }),
  );
}

export const DEFAULT_BALANCED_TOOL_ALLOWLIST: string[] = [...BALANCED_STARTER_TOOL_NAMES];
