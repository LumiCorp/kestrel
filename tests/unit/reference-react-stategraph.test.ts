import assert from "node:assert/strict";

import {
  renderAgentGraphDot,
  renderAgentGraphMermaid,
  renderRuntimeStateGraphDot,
  renderRuntimeStateGraphMermaid,
  agentGraphEdges,
} from "../../agents/reference-react/src/graph.js";
import { AGENT_STEP_IDS } from "../../agents/reference-react/src/constants.js";
import { contractTest } from "../helpers/contract-test.js";


const LIVE_STEP_IDS = Object.values(AGENT_STEP_IDS) as string[];

contractTest("runtime.hermetic", "agent graph renders the single-loop runtime path", () => {
  const agentMermaid = renderAgentGraphMermaid();
  const agentDot = renderAgentGraphDot();
  const runtimeMermaid = renderRuntimeStateGraphMermaid();
  const runtimeDot = renderRuntimeStateGraphDot();

  for (const rendered of [agentMermaid, agentDot, runtimeMermaid, runtimeDot]) {
    assert.equal(rendered.includes("agent.loop"), true);
    assert.equal(rendered.includes("agent.exec.dispatch"), true);
    assert.equal(rendered.includes("react.route"), false);
    assert.equal(rendered.includes("react.extractor"), false);
    assert.equal(rendered.includes("react.resolve"), false);
  }
});

contractTest("runtime.hermetic", "agent graph keeps all live steps reachable from the loop", () => {
  const edges = agentGraphEdges();
  assert.deepEqual(
    edges
      .filter((edge) => edge.from === AGENT_STEP_IDS.loop)
      .map((edge) => edge.to),
    [AGENT_STEP_IDS.execDispatch, AGENT_STEP_IDS.loop],
  );

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  }

  const visited = new Set<string>();
  const stack: string[] = [AGENT_STEP_IDS.loop];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) {
      stack.push(next);
    }
  }

  for (const stepId of LIVE_STEP_IDS) {
    assert.equal(visited.has(stepId), true, `expected ${stepId} to be reachable`);
  }
});
