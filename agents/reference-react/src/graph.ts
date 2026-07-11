import { AGENT_STEP_IDS } from "./constants.js";

export interface StateGraphEdge {
  from: string;
  to: string;
  label: string;
}

export function engineGraphEdges(): StateGraphEdge[] {
  return [
    { from: "RUN_BOOT", to: "RESUME_PENDING_EFFECTS", label: "ensureSession + startRun" },
    { from: "RUN_BOOT", to: "RUN_FAILED", label: "session_busy | startup_error | cancel" },
    { from: "RESUME_PENDING_EFFECTS", to: "STEP_SELECTION", label: "resume ok" },
    { from: "RESUME_PENDING_EFFECTS", to: "RUN_WAITING", label: "effect WAIT" },
    { from: "RESUME_PENDING_EFFECTS", to: "RUN_FAILED", label: "effect STOP" },
    { from: "STEP_SELECTION", to: "STEP_EXECUTION", label: "use current step" },
    { from: "STEP_SELECTION", to: "STEP_EXECUTION", label: "claim region work" },
    { from: "STEP_SELECTION", to: "RUN_WAITING", label: "wait_for_merge" },
    { from: "STEP_EXECUTION", to: "STEP_COMMIT", label: "transition returned" },
    { from: "STEP_EXECUTION", to: "RUN_FAILED", label: "error | guardrail | cancel" },
    { from: "STEP_EXECUTION", to: "RUN_WAITING", label: "region merge conflict" },
    { from: "STEP_COMMIT", to: "EFFECT_EXECUTION", label: "persist state/effects/events" },
    { from: "EFFECT_EXECUTION", to: "OUTBOX_DISPATCH", label: "effects complete" },
    { from: "EFFECT_EXECUTION", to: "RUN_WAITING", label: "effect WAIT" },
    { from: "EFFECT_EXECUTION", to: "RUN_FAILED", label: "effect STOP" },
    { from: "OUTBOX_DISPATCH", to: "TERMINAL_CHECK", label: "dispatch inline" },
    { from: "TERMINAL_CHECK", to: "STEP_SELECTION", label: "RUNNING" },
    { from: "TERMINAL_CHECK", to: "RUN_WAITING", label: "WAITING" },
    { from: "TERMINAL_CHECK", to: "RUN_COMPLETED", label: "COMPLETED" },
    { from: "TERMINAL_CHECK", to: "RUN_FAILED", label: "FAILED" },
  ];
}

export function agentGraphEdges(): StateGraphEdge[] {
  return [
    { from: AGENT_STEP_IDS.loop, to: AGENT_STEP_IDS.execDispatch, label: "valid action" },
    { from: AGENT_STEP_IDS.loop, to: AGENT_STEP_IDS.loop, label: "validation feedback" },
    { from: AGENT_STEP_IDS.execDispatch, to: AGENT_STEP_IDS.execWaitEffect, label: "durable tool/effect" },
    { from: AGENT_STEP_IDS.execDispatch, to: AGENT_STEP_IDS.execWaitApproval, label: "approval required" },
    { from: AGENT_STEP_IDS.execDispatch, to: AGENT_STEP_IDS.execWaitUser, label: "ask_user" },
    { from: AGENT_STEP_IDS.execDispatch, to: AGENT_STEP_IDS.execCollect, label: "tool/effect result" },
    { from: AGENT_STEP_IDS.execDispatch, to: AGENT_STEP_IDS.execFinalize, label: "finalize" },
    { from: AGENT_STEP_IDS.execDispatch, to: AGENT_STEP_IDS.loop, label: "validation/policy/tool feedback" },
    { from: AGENT_STEP_IDS.execWaitEffect, to: AGENT_STEP_IDS.execWaitEffect, label: "waiting" },
    { from: AGENT_STEP_IDS.execWaitEffect, to: AGENT_STEP_IDS.execCollect, label: "effect available" },
    { from: AGENT_STEP_IDS.execWaitApproval, to: AGENT_STEP_IDS.execWaitApproval, label: "waiting" },
    { from: AGENT_STEP_IDS.execWaitApproval, to: AGENT_STEP_IDS.execDispatch, label: "approved" },
    { from: AGENT_STEP_IDS.execWaitApproval, to: AGENT_STEP_IDS.loop, label: "denied/replan" },
    { from: AGENT_STEP_IDS.execWaitUser, to: AGENT_STEP_IDS.execWaitUser, label: "waiting" },
    { from: AGENT_STEP_IDS.execWaitUser, to: AGENT_STEP_IDS.loop, label: "reply" },
    { from: AGENT_STEP_IDS.execCollect, to: AGENT_STEP_IDS.execDispatch, label: "batch continues" },
    { from: AGENT_STEP_IDS.execCollect, to: AGENT_STEP_IDS.loop, label: "result feedback" },
    { from: AGENT_STEP_IDS.execFinalize, to: AGENT_STEP_IDS.execWaitUser, label: "plan handoff confirmation" },
  ];
}

export function renderRuntimeStateGraphMermaid(): string {
  const lines = [
    "stateDiagram-v2",
    "",
    "state Engine {",
    "  [*] --> RUN_BOOT",
  ];
  for (const edge of engineGraphEdges()) {
    lines.push(`  ${edge.from} --> ${edge.to} : ${edge.label}`);
  }
  lines.push("}");
  lines.push("");
  lines.push("state Agent {");
  lines.push(`  [*] --> ${AGENT_STEP_IDS.loop}`);
  for (const edge of agentGraphEdges()) {
    lines.push(`  ${edge.from} --> ${edge.to} : ${edge.label}`);
  }
  lines.push(`  ${AGENT_STEP_IDS.execFinalize} --> [*]`);
  lines.push("}");
  lines.push("");
  lines.push("RUN_COMPLETED --> [*]");
  lines.push("RUN_FAILED --> [*]");
  lines.push("RUN_WAITING --> [*]");
  return lines.join("\n");
}

export function renderRuntimeStateGraphDot(): string {
  const lines = [
    "digraph RuntimeStateGraph {",
    "  rankdir=LR;",
    "  subgraph cluster_engine {",
    "    label=\"Engine\";",
  ];
  for (const edge of engineGraphEdges()) {
    lines.push(`    "${edge.from}" -> "${edge.to}" [label="${edge.label}"];`);
  }
  lines.push("  }");
  lines.push("  subgraph cluster_agent {");
  lines.push("    label=\"Agent\";");
  for (const edge of agentGraphEdges()) {
    lines.push(`    "${edge.from}" -> "${edge.to}" [label="${edge.label}"];`);
  }
  lines.push(`    "${AGENT_STEP_IDS.execFinalize}" [shape=doublecircle];`);
  lines.push("  }");
  lines.push("  \"RUN_COMPLETED\" [shape=doublecircle];");
  lines.push("  \"RUN_FAILED\" [shape=doublecircle];");
  lines.push("  \"RUN_WAITING\" [shape=doublecircle];");
  lines.push("}");
  return lines.join("\n");
}

export function renderAgentGraphMermaid(): string {
  const lines = ["stateDiagram-v2", "", `[*] --> ${AGENT_STEP_IDS.loop}`];
  for (const edge of agentGraphEdges()) {
    lines.push(`${edge.from} --> ${edge.to} : ${edge.label}`);
  }
  lines.push(`${AGENT_STEP_IDS.execFinalize} --> [*]`);
  return lines.join("\n");
}

export function renderAgentGraphDot(): string {
  const lines = ["digraph AgentGraph {", "  rankdir=LR;"];
  for (const edge of agentGraphEdges()) {
    lines.push(`  "${edge.from}" -> "${edge.to}" [label="${edge.label}"];`);
  }
  lines.push(`  "${AGENT_STEP_IDS.execFinalize}" [shape=doublecircle];`);
  lines.push("}");
  return lines.join("\n");
}
