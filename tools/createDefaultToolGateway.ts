import { AllowlistedToolGateway } from "../src/io/ToolGateway.js";
import { BALANCED_STARTER_TOOL_NAMES, defaultToolCatalog } from "./catalog.js";
import type { SharedToolContext } from "./contracts.js";
import { withDefaultFileSystemPolicy } from "./filesystem/shared.js";

export interface CreateDefaultToolGatewayOptions {
  allowlist: string[];
  context?: SharedToolContext | undefined;
}

export function createDefaultToolGateway(options: CreateDefaultToolGatewayOptions): AllowlistedToolGateway {
  const handlers = defaultToolCatalog.createHandlers(
    options.allowlist,
    withDefaultFileSystemPolicy(options.context),
  );
  return new AllowlistedToolGateway(handlers);
}

export const DEFAULT_BALANCED_TOOL_ALLOWLIST: string[] = [...BALANCED_STARTER_TOOL_NAMES];
