import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { contractTest } from "../helpers/contract-test.js";


const RUNTIME_SOURCE = path.join(process.cwd(), "cli/runtime/KestrelChatRuntime.ts");
const CLI_APP_SOURCE = path.join(process.cwd(), "cli/app/App.ts");
const CLI_OPERATOR_AFFORDANCES_SOURCE = path.join(process.cwd(), "cli/runtime/operatorAffordances.ts");
const TURN_COORDINATOR_SOURCE = path.join(process.cwd(), "src/runtime/RuntimeTurnCoordinator.ts");
const THREADED_EXECUTOR_SOURCE = path.join(process.cwd(), "src/runtime/RuntimeThreadedTurnExecutor.ts");
const OPERATOR_AFFORDANCE_SOURCE = path.join(process.cwd(), "src/orchestration/OperatorAffordanceProjection.ts");
const SESSION_STATE_PROJECTION_SOURCE = path.join(process.cwd(), "src/orchestration/RuntimeSessionStateProjection.ts");
const TASK_GRAPH_PROJECTION_SOURCE = path.join(process.cwd(), "src/taskGraph/RuntimeTaskGraphProjection.ts");
const TASK_GRAPH_RUNTIME_INTEGRATION_SOURCE = path.join(process.cwd(), "src/taskGraph/runtimeIntegration.ts");
const COMMAND_ROUTER_SOURCE = path.join(process.cwd(), "cli/runner/CommandRouter.ts");

contractTest("runtime.hermetic", "KestrelChatRuntime.runTurn stays a coordinator delegation seam", async () => {
  const source = await readFile(RUNTIME_SOURCE, "utf8");
  const runTurnBody = sectionBetween(source, "  async runTurn(", "\n  async getToolRuntimeStatus(");

  assert.match(runTurnBody, /requireRunTurnMessage/u);
  assert.match(runTurnBody, /applyActiveTaskRuntimeMetadata/u);
  assert.match(runTurnBody, /this\.turnCoordinator\.runTurn/u);
  assert.doesNotMatch(runTurnBody, /getGraph/u);
  assert.doesNotMatch(runTurnBody, /selectRequestForResume/u);
  assert.doesNotMatch(runTurnBody, /buildReplyToRequestInput/u);
  assert.doesNotMatch(runTurnBody, /readObserverTimeoutResumeStepAgent/u);
  assert.doesNotMatch(runTurnBody, /replyToRequest\s*\(/u);
  assert.doesNotMatch(runTurnBody, /allowedToolClasses/u);
  assert.doesNotMatch(runTurnBody, /allowedCapabilities/u);
  assert.doesNotMatch(runTurnBody, /payload\s*:\s*\{/u);
  assert.doesNotMatch(runTurnBody, /this\.kestrel\.run\s*\(/u);
  assert.doesNotMatch(runTurnBody, /ensureMainThread/u);
});

contractTest("runtime.hermetic", "default turn executor delegates threaded payload preparation to runtime service", async () => {
  const source = await readFile(RUNTIME_SOURCE, "utf8");
  const threadedExecutorSource = await readFile(THREADED_EXECUTOR_SOURCE, "utf8");
  const executorBody = sectionBetween(source, "function createDefaultRuntime(", "\nexport function resolveDevShellServiceForProfile(");
  const compileIndex = threadedExecutorSource.indexOf("compileRuntimeTurn(");
  const runIndex = threadedExecutorSource.search(/this\.runKernel\(\s*\{/u);

  assert.match(executorBody, /new RuntimeThreadedTurnExecutor/u);
  assert.match(executorBody, /threadedTurnExecutor\.executeTurn/u);
  assert.doesNotMatch(executorBody, /compileRuntimeTurn\s*\(/u);
  assert.doesNotMatch(executorBody, /payload:\s*runtimeTurn\.payload/u);
  assert.notEqual(compileIndex, -1);
  assert.notEqual(runIndex, -1);
  assert.ok(compileIndex < runIndex, "compileRuntimeTurn must happen before kernel execution in the runtime executor");
  assert.match(threadedExecutorSource, /payload:\s*runtimeTurn\.payload/u);
});

contractTest("runtime.hermetic", "KestrelChatRuntime delegates operator session projection to orchestration", async () => {
  const source = await readFile(RUNTIME_SOURCE, "utf8");

  assert.match(source, /buildOperatorSessionProjection/u);
  assert.doesNotMatch(source, /function readDescribeWaitFor/u);
  assert.doesNotMatch(source, /function readWaitForFromThread/u);
  assert.doesNotMatch(source, /function readWaitForFromOperatorView/u);
  assert.doesNotMatch(source, /function describeDominantBlocker/u);
  assert.doesNotMatch(source, /function toChildThreadSummaries/u);
  assert.doesNotMatch(source, /function toOperatorInboxSummary/u);
  assert.doesNotMatch(source, /function toCheckpointSummary/u);
});

contractTest("runtime.hermetic", "runner control boundary delegates operator policy field validation", async () => {
  const commandRouterSource = await readFile(COMMAND_ROUTER_SOURCE, "utf8");

  assert.match(commandRouterSource, /parseOperatorControlPolicyFields/u);
  assert.doesNotMatch(commandRouterSource, /allowToolClasses contains an invalid tool class/u);
});

contractTest("runtime.hermetic", "operator affordance payload construction stays source-owned", async () => {
  const runtimeSource = await readFile(RUNTIME_SOURCE, "utf8");
  const cliAppSource = await readFile(CLI_APP_SOURCE, "utf8");
  const cliAffordanceSource = await readFile(CLI_OPERATOR_AFFORDANCES_SOURCE, "utf8");
  const turnCoordinatorSource = await readFile(TURN_COORDINATOR_SOURCE, "utf8");
  const sourceAffordanceSource = await readFile(OPERATOR_AFFORDANCE_SOURCE, "utf8");

  assert.match(turnCoordinatorSource, /buildRuntimeOperatorAffordance/u);
  assert.match(sourceAffordanceSource, /export function buildRuntimeOperatorAffordance/u);
  assert.match(sourceAffordanceSource, /export function buildOperatorAffordanceFromSessionProjection/u);
  assert.match(cliAppSource, /buildOperatorAffordanceFromSessionProjection/u);
  assert.match(cliAffordanceSource, /export \{ buildRuntimeOperatorAffordance \}/u);
  assert.doesNotMatch(cliAffordanceSource, /export function buildRuntimeOperatorAffordance/u);
  assert.doesNotMatch(cliAffordanceSource, /function readRuntimePlanSummary/u);
  assert.doesNotMatch(cliAffordanceSource, /function readContextSummary/u);
  assert.doesNotMatch(runtimeSource, /buildRuntimeOperatorAffordance/u);
  assert.doesNotMatch(runtimeSource, /buildOperatorAffordance:/u);
  assert.doesNotMatch(cliAppSource, /buildRuntimeOperatorAffordance/u);
  assert.doesNotMatch(cliAppSource, /operator_thread_blocker/u);
});

contractTest("runtime.hermetic", "KestrelChatRuntime delegates session state and task graph projection to orchestration", async () => {
  const runtimeSource = await readFile(RUNTIME_SOURCE, "utf8");
  const sessionProjectionSource = await readFile(SESSION_STATE_PROJECTION_SOURCE, "utf8");
  const getSessionStateBody = sectionBetween(runtimeSource, "  async getSessionState(", "\n  private async buildSessionDescription(");

  assert.match(getSessionStateBody, /buildRuntimeSessionStateProjection/u);
  assert.doesNotMatch(getSessionStateBody, /renderGraphFromSession/u);
  assert.doesNotMatch(getSessionStateBody, /getOperatorThreadView/u);
  assert.match(sessionProjectionSource, /renderGraphFromSession/u);
  assert.match(sessionProjectionSource, /buildOperatorSessionProjection/u);
  assert.match(sessionProjectionSource, /readRuntimeTaskGraphProjectionContext/u);
});

contractTest("runtime.hermetic", "KestrelChatRuntime delegates task graph runtime integration to source helpers", async () => {
  const runtimeSource = await readFile(RUNTIME_SOURCE, "utf8");
  const taskGraphIntegrationSource = await readFile(TASK_GRAPH_RUNTIME_INTEGRATION_SOURCE, "utf8");

  assert.match(runtimeSource, /applyActiveTaskRuntimeMetadata/u);
  assert.match(runtimeSource, /persistDelegationTaskUpdateToGraph/u);
  assert.match(taskGraphIntegrationSource, /export async function applyActiveTaskRuntimeMetadata/u);
  assert.match(taskGraphIntegrationSource, /export async function persistDelegationTaskUpdateToGraph/u);
  assert.doesNotMatch(runtimeSource, /private async withActiveTaskRuntimeMetadata/u);
  assert.doesNotMatch(runtimeSource, /taskGraphStore\.applyDelegationUpdate/u);
});

contractTest("runtime.hermetic", "KestrelChatRuntime delegates task graph projection to source helpers", async () => {
  const runtimeSource = await readFile(RUNTIME_SOURCE, "utf8");
  const taskGraphProjectionSource = await readFile(TASK_GRAPH_PROJECTION_SOURCE, "utf8");
  const getTaskGraphBody = sectionBetween(runtimeSource, "  async getTaskGraph(", "\n  async updateTaskGraph(");

  assert.match(getTaskGraphBody, /buildRuntimeTaskGraphProjection/u);
  assert.doesNotMatch(getTaskGraphBody, /getThreadStatus/u);
  assert.doesNotMatch(getTaskGraphBody, /getOperatorThreadView/u);
  assert.doesNotMatch(getTaskGraphBody, /listOperatorInbox/u);
  assert.match(taskGraphProjectionSource, /export async function buildRuntimeTaskGraphProjection/u);
  assert.match(taskGraphProjectionSource, /getOperatorThreadView/u);
});

contractTest("runtime.hermetic", "KestrelChatRuntime delegates project tool actions to source helpers", async () => {
  const runtimeSource = await readFile(RUNTIME_SOURCE, "utf8");
  const defaultRuntimeBody = sectionBetween(runtimeSource, "function createDefaultRuntime(", "\nexport function resolveDevShellServiceForProfile(");

  assert.match(defaultRuntimeBody, /createProductProjectActionToolAdapter/u);
  assert.doesNotMatch(defaultRuntimeBody, /projectStore\.applyAction/u);
});

function sectionBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing source marker '${startMarker}'.`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Missing source marker '${endMarker}'.`);
  return source.slice(start, end);
}
