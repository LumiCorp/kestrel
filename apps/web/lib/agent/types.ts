export interface AgentConfigData {
  id: string;
  name: string;
  additionalPrompt: string | null;
  responseStyle: "concise" | "detailed" | "technical" | "friendly";
  language: string;
  defaultModel: string | null;
  maxStepsMultiplier: number;
  temperature: number;
  searchInstructions: string | null;
  citationFormat: "inline" | "footnote" | "none";
  isActive: boolean;
}

export interface RouterDecision {
  complexity: "trivial" | "simple" | "moderate" | "complex";
  maxSteps: number;
  model: string;
  reasoning: string;
}

export interface RoutingResult {
  routerConfig: RouterDecision;
  agentConfig: AgentConfigData;
  effectiveModel: string;
  effectiveMaxSteps: number;
}

export interface AgentExecutionContext {
  mode: "admin" | "chat";
  effectiveModel: string;
  maxSteps: number;
  routerConfig?: RouterDecision;
  agentConfig?: AgentConfigData;
}
