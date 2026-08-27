import "server-only";

import { generateText } from "ai";
import { resolveRequiredLanguageModel } from "@/lib/ai/providers";
import { listToolRuntimeNames } from "@/lib/tools/registry";
import {
  type WorkflowDefinition,
  validateWorkflowDefinition,
} from "./contracts";
import { assertWorkflowToolsAvailable } from "./execution-policy";

function parseJson(text: string) {
  const trimmed = text.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "")
    : trimmed;
  return JSON.parse(unfenced) as unknown;
}

function instructions(toolNames: string[]) {
  return [
    "Convert a user's workflow description into one coarse Kestrel workflow graph.",
    "Return only one JSON object. Do not use Markdown.",
    "The object must be {version:1,nodes:[...],edges:[...] }.",
    "Every node is {id,label,kind,position,config}. IDs are stable lowercase slugs. Positions are {x,y} and must flow top to bottom: increase y for each downstream level and use x only to separate parallel branches.",
    "Use exactly one trigger and exactly one output. Every non-trigger has input; every non-output has output. The graph must be acyclic.",
    "Kinds and configs:",
    '- trigger: {mode:"manual"} or {mode:"schedule",cronExpression,timeZone}',
    '- kestrel: {instructions:"specific autonomous work"}',
    '- tool: {toolName:"exact runtime name",input:{...}}',
    '- gate: {path:"predecessor-id.optional.field",operator:"exists"|"equals"|"not_equals",value?:...}',
    '- join: {mode:"all"}; use only when two or more branches converge',
    "- output: {}",
    "Edges are {id,source,target}. Never invent conditional branches or loops.",
    "Use tool nodes only when the user specifies a concrete tool and its complete fixed JSON input. Otherwise use a Kestrel node.",
    `Known runtime tool names include: ${toolNames.slice(0, 160).join(", ")}`,
  ].join("\n");
}

export async function generateProjectWorkflowDefinition(input: {
  description: string;
  organizationId: string;
  environmentId: string;
  modelId: string;
  allowedToolNames: readonly string[];
}): Promise<WorkflowDefinition> {
  const description = input.description.trim();
  if (!description) throw new Error("Describe the workflow to generate.");
  if (description.length > 20_000) throw new Error("Workflow description is too long.");
  const resolved = await resolveRequiredLanguageModel({
    surface: "workflow",
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    modelId: input.modelId,
  });
  const registeredToolNames = new Set(listToolRuntimeNames());
  const allowedToolNames = [...new Set(input.allowedToolNames)].filter((name) =>
    registeredToolNames.has(name),
  );
  const validateCandidate = (candidate: unknown) =>
    assertWorkflowToolsAvailable(
      validateWorkflowDefinition(candidate),
      new Set(allowedToolNames),
    );
  const system = instructions(allowedToolNames);
  const first = await generateText({ model: resolved.model, system, prompt: description });
  try {
    return validateCandidate(parseJson(first.text));
  } catch (error) {
    const repair = await generateText({
      model: resolved.model,
      system,
      prompt: [
        "Repair the candidate so it satisfies the contract. Return only the corrected JSON object.",
        `Validation error: ${error instanceof Error ? error.message : "invalid graph"}`,
        `Candidate: ${first.text}`,
        `Original request: ${description}`,
      ].join("\n\n"),
    });
    return validateCandidate(parseJson(repair.text));
  }
}
