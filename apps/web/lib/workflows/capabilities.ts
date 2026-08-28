import type { ToolAccessMode } from "@/lib/tools/types";

export const WORKFLOW_NATIVE_WORKSPACE_TOOL_IDS = Object.freeze([
  "fs.list", "fs.read_text", "fs.read_text_page", "fs.create_text",
  "fs.edit_text", "fs.verify_json", "fs.search_text", "fs.write_text",
  "fs.replace_text", "fs.mkdir",
]);

const nativeWorkspaceTools = new Set(WORKFLOW_NATIVE_WORKSPACE_TOOL_IDS);

export type WorkflowCapabilityUse = "native" | "action" | "hidden";

export function classifyWorkflowCapability(input: {
  accessMode: ToolAccessMode;
  runtimeName: string | null;
}): WorkflowCapabilityUse {
  if (!input.runtimeName || input.accessMode === "internal") return "hidden";
  if (nativeWorkspaceTools.has(input.runtimeName)) return "native";
  return input.accessMode === "write" ? "action" : "native";
}
