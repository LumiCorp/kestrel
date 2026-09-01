import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { createDurableThreadTurnInTransaction } from "@/lib/turns/store";
import {
  type WorkflowDefinition,
  type WorkflowNode,
  validateWorkflowDefinition,
} from "./contracts";
import { resolveWorkflowActionInput } from "./action-inputs";
import { workflowStepEvidence } from "./evidence";
import { validateExplicitToolCallEvidence } from "./execution-policy";

type Transaction = Parameters<Parameters<typeof knowledgeDb.transaction>[0]>[0];
type Step = typeof schema.projectWorkflowStepRuns.$inferSelect;

function predecessors(definition: WorkflowDefinition, nodeId: string) {
  const sourceIds = definition.edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => edge.source);
  return definition.nodes.filter((node) => sourceIds.includes(node.id));
}

function aggregateInput(
  definition: WorkflowDefinition,
  node: WorkflowNode,
  steps: Map<string, Step>,
) {
  return Object.fromEntries(
    predecessors(definition, node.id).map((source) => [
      source.id,
      steps.get(source.id)?.output ?? null,
    ]),
  );
}

function readPath(value: unknown, path: string) {
  if (!path.trim()) return value;
  let current = value;
  for (const segment of path.split(".")) {
    if (!(current && typeof current === "object" && !Array.isArray(current))) {
      return;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function valuesEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function gatePasses(node: Extract<WorkflowNode, { kind: "gate" }>, input: unknown) {
  const actual = readPath(input, node.config.path);
  if (node.config.operator === "exists") return actual !== undefined;
  if (node.config.operator === "equals") return valuesEqual(actual, node.config.value);
  return !valuesEqual(actual, node.config.value);
}

function stepPrompt(input: {
  workflowTitle: string;
  node: Extract<WorkflowNode, { kind: "kestrel" | "tool" }>;
  upstream: Record<string, unknown>;
  resolvedActionInput?: Record<string, unknown>;
}) {
  const context = JSON.stringify(input.upstream, null, 2);
  if (input.node.kind === "tool") {
    return [
      `You are executing the explicit tool step "${input.node.label}" in the Kestrel workflow "${input.workflowTitle}".`,
      `Call exactly this tool once: ${input.node.config.toolName}`,
      `Use exactly this JSON input: ${JSON.stringify(input.resolvedActionInput ?? input.node.config.input)}`,
      "Do not call any other tool and do not change the input. After the tool returns, summarize its result.",
      `Upstream workflow data is provided only as context:\n${context}`,
    ].join("\n\n");
  }
  return [
    `You are executing the Kestrel workflow step "${input.node.label}" in "${input.workflowTitle}".`,
    input.node.config.instructions,
    `Upstream workflow data:\n${context}`,
    "Complete only this step. Your final response becomes this step's output for downstream nodes.",
  ].join("\n\n");
}

async function failRun(
  tx: Transaction,
  runId: string,
  code: string,
  message: string,
  now: Date,
) {
  const attentionRequired = new Set([
    "WORKFLOW_ACTOR_UNAVAILABLE",
    "WORKFLOW_INTERACTION_REQUIRED",
    "WORKFLOW_RUN_AUTHORITY_EXCEEDED",
    "WORKFLOW_TOOL_CONTRACT_VIOLATION",
    "WORKFLOW_ACTION_INPUT_INVALID",
  ]).has(code);
  const run = attentionRequired
    ? await tx.query.projectWorkflowRuns.findFirst({
        where: eq(schema.projectWorkflowRuns.id, runId),
        columns: { workflowId: true },
      })
    : null;
  await tx
    .update(schema.projectWorkflowRuns)
    .set({
      status: "failed",
      failureCode: code.slice(0, 120),
      failureMessage: message.slice(0, 1000),
      ...(attentionRequired
        ? {
            attentionCode: code.slice(0, 120),
            attentionMessage: message.slice(0, 1000),
          }
        : {}),
      finishedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.projectWorkflowRuns.id, runId));
  await tx
    .update(schema.projectWorkflowStepRuns)
    .set({ status: "cancelled", finishedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.projectWorkflowStepRuns.workflowRunId, runId),
        eq(schema.projectWorkflowStepRuns.status, "pending"),
      ),
    );
  if (run) {
    await tx
      .update(schema.projectWorkflows)
      .set({
        enabled: false,
        nextRunAt: null,
        attentionCode: code.slice(0, 120),
        attentionMessage: message.slice(0, 1000),
        updatedAt: now,
      })
      .where(eq(schema.projectWorkflows.id, run.workflowId));
  }
}

export async function advanceProjectWorkflowRun(runId: string) {
  return knowledgeDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`workflow-run:${runId}`}, 0))`,
    );
    const [row] = await tx
      .select({
        run: schema.projectWorkflowRuns,
        workflow: schema.projectWorkflows,
        definition: schema.projectWorkflowVersions.definition,
        activation: schema.projectWorkflowVersionActivations,
        projectName: schema.projects.name,
      })
      .from(schema.projectWorkflowRuns)
      .innerJoin(schema.projectWorkflows, eq(schema.projectWorkflows.id, schema.projectWorkflowRuns.workflowId))
      .innerJoin(schema.projectWorkflowVersions, eq(schema.projectWorkflowVersions.id, schema.projectWorkflowRuns.workflowVersionId))
      .innerJoin(schema.projectWorkflowVersionActivations, eq(schema.projectWorkflowVersionActivations.workflowVersionId, schema.projectWorkflowVersions.id))
      .innerJoin(schema.projects, eq(schema.projects.id, schema.projectWorkflows.projectId))
      .where(eq(schema.projectWorkflowRuns.id, runId))
      .limit(1);
    if (!row || ["completed", "failed", "cancelled"].includes(row.run.status)) {
      return { turnIds: [] as string[], terminal: true };
    }
    const definition = validateWorkflowDefinition(row.definition);
    const now = new Date();
    const stepRows = await tx
      .select({ step: schema.projectWorkflowStepRuns, turn: schema.threadTurns })
      .from(schema.projectWorkflowStepRuns)
      .leftJoin(schema.threadTurns, eq(schema.threadTurns.id, schema.projectWorkflowStepRuns.turnId))
      .where(eq(schema.projectWorkflowStepRuns.workflowRunId, runId));
    const steps = new Map(stepRows.map(({ step }) => [step.nodeId, step]));

    for (const { step, turn } of stepRows) {
      if (!(step.turnId && turn && (step.status === "running" || step.status === "waiting_for_input"))) continue;
      if (turn.status === "waiting_for_input") {
        const code = "WORKFLOW_INTERACTION_REQUIRED";
        const message = "This workflow requested input that was not included in its activated design.";
        step.status = "failed";
        await tx.update(schema.projectWorkflowStepRuns).set({
          status: "failed",
          failureCode: code,
          failureMessage: message,
          finishedAt: now,
          updatedAt: now,
        }).where(eq(schema.projectWorkflowStepRuns.id, step.id));
        await failRun(tx, runId, code, message, now);
        return { turnIds: [] as string[], terminal: true };
      } else if (turn.status === "failed" || turn.status === "cancelled") {
        step.status = "failed";
        await tx.update(schema.projectWorkflowStepRuns).set({
          status: "failed",
          failureCode: turn.failureCode ?? "WORKFLOW_STEP_FAILED",
          failureMessage: turn.failureMessage ?? "The Kestrel step did not complete.",
          finishedAt: turn.finishedAt ?? now,
          updatedAt: now,
        }).where(eq(schema.projectWorkflowStepRuns.id, step.id));
        await failRun(tx, runId, turn.failureCode ?? "WORKFLOW_STEP_FAILED", turn.failureMessage ?? "A workflow step failed.", now);
        return { turnIds: [] as string[], terminal: true };
      } else if (turn.status === "completed") {
        const message = turn.outputMessageId
          ? await tx.query.threadMessages.findFirst({ where: eq(schema.threadMessages.id, turn.outputMessageId) })
          : null;
        const evidence = workflowStepEvidence({ model: message?.model, parts: message?.parts });
        const node = definition.nodes.find((candidate) => candidate.id === step.nodeId);
        if (node?.kind === "tool") {
          const storedInput = step.input && typeof step.input === "object" && !Array.isArray(step.input) ? step.input as Record<string, unknown> : {};
          const expectedInput = storedInput.resolvedInput && typeof storedInput.resolvedInput === "object" && !Array.isArray(storedInput.resolvedInput) ? storedInput.resolvedInput as Record<string, unknown> : node.config.input;
          const contract = validateExplicitToolCallEvidence({
            toolName: node.config.toolName,
            expectedInput,
            evidence,
          });
          if (!contract.valid) {
            await tx.update(schema.projectWorkflowStepRuns).set({
              status: "failed",
              failureCode: "WORKFLOW_TOOL_CONTRACT_VIOLATION",
              failureMessage: contract.message,
              finishedAt: now,
              updatedAt: now,
            }).where(eq(schema.projectWorkflowStepRuns.id, step.id));
            await failRun(
              tx,
              runId,
              "WORKFLOW_TOOL_CONTRACT_VIOLATION",
              contract.message,
              now,
            );
            return { turnIds: [] as string[], terminal: true };
          }
        }
        const output = { text: evidence.text, model: evidence.model, toolCalls: evidence.toolCalls };
        step.status = "completed";
        step.output = output;
        await tx.update(schema.projectWorkflowStepRuns).set({ status: "completed", output, finishedAt: turn.finishedAt ?? now, updatedAt: now }).where(eq(schema.projectWorkflowStepRuns.id, step.id));
      }
    }

    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const node of definition.nodes) {
        const step = steps.get(node.id);
        if (!step || step.status !== "pending") continue;
        const prior = predecessors(definition, node.id).map((source) => steps.get(source.id));
        if (!prior.every((candidate) => candidate?.status === "completed")) continue;
        const upstream = aggregateInput(definition, node, steps);
        if (node.kind === "gate") {
          if (!gatePasses(node, upstream)) {
            await tx.update(schema.projectWorkflowStepRuns).set({
              status: "failed",
              input: upstream,
              failureCode: "WORKFLOW_GATE_REJECTED",
              failureMessage: `Gate "${node.label}" rejected the run.`,
              startedAt: now,
              finishedAt: now,
              updatedAt: now,
            }).where(eq(schema.projectWorkflowStepRuns.id, step.id));
            await failRun(tx, runId, "WORKFLOW_GATE_REJECTED", `Gate "${node.label}" rejected the run.`, now);
            return { turnIds: [] as string[], terminal: true };
          }
          const output = { passed: true, value: readPath(upstream, node.config.path) };
          Object.assign(step, { status: "completed", input: upstream, output });
          await tx.update(schema.projectWorkflowStepRuns).set({ status: "completed", input: upstream, output, startedAt: now, finishedAt: now, updatedAt: now }).where(eq(schema.projectWorkflowStepRuns.id, step.id));
          progressed = true;
        } else if (node.kind === "join") {
          Object.assign(step, { status: "completed", input: upstream, output: upstream });
          await tx.update(schema.projectWorkflowStepRuns).set({ status: "completed", input: upstream, output: upstream, startedAt: now, finishedAt: now, updatedAt: now }).where(eq(schema.projectWorkflowStepRuns.id, step.id));
          progressed = true;
        } else if (node.kind === "output") {
          Object.assign(step, { status: "completed", input: upstream, output: upstream });
          await tx.update(schema.projectWorkflowStepRuns).set({ status: "completed", input: upstream, output: upstream, startedAt: now, finishedAt: now, updatedAt: now }).where(eq(schema.projectWorkflowStepRuns.id, step.id));
          await tx.update(schema.projectWorkflowRuns).set({ status: "completed", output: upstream, finishedAt: now, updatedAt: now }).where(eq(schema.projectWorkflowRuns.id, runId));
          return { turnIds: [] as string[], terminal: true };
        }
      }
    }

    const turnIds: string[] = [];
    for (const node of definition.nodes) {
      if (!(node.kind === "kestrel" || node.kind === "tool")) continue;
      const step = steps.get(node.id);
      if (!step || step.status !== "pending") continue;
      const prior = predecessors(definition, node.id).map((source) => steps.get(source.id));
      if (!prior.every((candidate) => candidate?.status === "completed")) continue;
      const upstream = aggregateInput(definition, node, steps);
      let resolvedActionInput: Record<string, unknown> | undefined;
      if (node.kind === "tool") {
        try {
          resolvedActionInput = resolveWorkflowActionInput(
            node,
            new Map([...steps].map(([nodeId, step]) => [nodeId, step.output])),
            definition,
          );
        }
        catch (error) { const message = error instanceof Error ? error.message : "Action input could not be resolved."; await failRun(tx, runId, "WORKFLOW_ACTION_INPUT_INVALID", message, now); return { turnIds: [] as string[], terminal: true }; }
      }
      if (!row.run.actorUserId) {
        await failRun(tx, runId, "WORKFLOW_ACTOR_UNAVAILABLE", "The workflow creator is no longer available.", now);
        return { turnIds: [] as string[], terminal: true };
      }
      const threadId = crypto.randomUUID();
      await tx.insert(schema.threads).values({
        id: threadId,
        createdByUserId: row.run.actorUserId,
        organizationId: row.workflow.organizationId,
        projectId: row.workflow.projectId,
        mode: "chat",
        origin: "web",
        interactionMode: "build",
        workspaceMode: "isolated",
        title: `${row.workflow.title} · ${node.label}`,
        isPublic: false,
        createdAt: now,
        updatedAt: now,
      });
      const durable = await createDurableThreadTurnInTransaction(tx, {
        threadId,
        organizationId: row.workflow.organizationId,
        authorUserId: row.run.actorUserId,
        messageId: crypto.randomUUID(),
        messageParts: [{ type: "text", text: stepPrompt({ workflowTitle: row.workflow.title, node, upstream, resolvedActionInput }) }],
        idempotencyKey: `workflow:${runId}:node:${node.id}:attempt:1`,
        requestedEnvironmentId: row.run.environmentIdSnapshot,
        projectContextRevisionId: row.run.projectContextRevisionIdSnapshot,
        requestedModelId: row.run.modelIdSnapshot,
        requestedInteractionMode: "build",
        noninteractive: true,
        workflowRunAuthority: {
          version: "runner_workflow_run_authority_v2",
          organizationId: row.workflow.organizationId,
          environmentId: row.run.environmentIdSnapshot,
          projectId: row.workflow.projectId,
          workflowId: row.workflow.id,
          workflowVersionId: row.run.workflowVersionId,
          workflowRunId: row.run.id,
          activationActorId: row.activation.activatedByUserId,
          manifestDigest: row.activation.manifestDigest,
          manifest: row.activation.manifest,
          activeStep: node.kind === "tool" ? { kind: "action", nodeId: node.id, resolvedInput: resolvedActionInput! } : { kind: "kestrel", nodeId: node.id },
        },
        source: "web",
      });
      step.status = "running";
      const durableInput = node.kind === "tool" ? { upstream, resolvedInput: resolvedActionInput } : upstream;
      step.input = durableInput;
      step.threadId = threadId;
      step.turnId = durable.turn.id;
      await tx.update(schema.projectWorkflowStepRuns).set({
        status: "running",
        input: durableInput,
        threadId,
        turnId: durable.turn.id,
        startedAt: now,
        updatedAt: now,
      }).where(eq(schema.projectWorkflowStepRuns.id, step.id));
      if (durable.shouldDispatch) turnIds.push(durable.dispatchTurnId ?? durable.turn.id);
    }
    await tx.update(schema.projectWorkflowRuns).set({
      status: "running",
      startedAt: row.run.startedAt ?? now,
      updatedAt: now,
    }).where(eq(schema.projectWorkflowRuns.id, runId));
    return { turnIds, terminal: false };
  });
}
