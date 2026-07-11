import {
  buildKestrelAgentContext,
  type KestrelAgentContextBuildInput,
  type KestrelAgentContextBuildOutput,
} from "../../../../src/runtime/KestrelAgentContextBuilder.js";

export type ContextRequestBuildInput = KestrelAgentContextBuildInput;
export type ContextRequestBuildOutput = KestrelAgentContextBuildOutput;

export function buildContextRequest(input: ContextRequestBuildInput): ContextRequestBuildOutput {
  return buildKestrelAgentContext(input);
}
