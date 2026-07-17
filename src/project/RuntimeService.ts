import { randomUUID } from "node:crypto";

import type {
  RuntimeTurnCoordinator,
  RuntimeTurnInput,
  RuntimeTurnResult,
} from "../runtime/RuntimeTurn.js";
import type { ProductTaskGraphStore } from "../taskGraph/store.js";
import type { ProductProjectStateStore } from "./store.js";
import type {
  ProductBoardCard,
  ProductProjectAction,
  ProductProjectSnapshot,
  ProductReviewAction,
  ProductReviewDetail,
  ProductReviewTarget,
} from "./contracts.js";
import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import { createEmptyProjectSnapshot } from "./state.js";

export class ProductProjectRuntimeService {
  private readonly taskGraphStore: Pick<ProductTaskGraphStore, "getGraph">;
  private readonly projectStore: ProductProjectStateStore;
  private readonly turnRunner: RuntimeTurnCoordinator;
  private readonly cardRunAbortControllers = new Map<string, AbortController>();

  constructor(options: {
    taskGraphStore: Pick<ProductTaskGraphStore, "getGraph">;
    projectStore: ProductProjectStateStore;
    turnRunner: RuntimeTurnCoordinator;
  }) {
    this.taskGraphStore = options.taskGraphStore;
    this.projectStore = options.projectStore;
    this.turnRunner = options.turnRunner;
  }

  async getProjectSnapshot(input: { sessionId: string }): Promise<{ sessionId: string; snapshot: ProductProjectSnapshot }> {
    const graph = await this.taskGraphStore.getGraph({ sessionId: input.sessionId });
    return {
      sessionId: input.sessionId,
      snapshot: await this.projectStore.getSnapshot({
        sessionId: input.sessionId,
        graph,
      }),
    };
  }

  async updateProjectSnapshot(input: { sessionId: string; snapshot: ProductProjectSnapshot }): Promise<{ sessionId: string; snapshot: ProductProjectSnapshot }> {
    const snapshot = await this.projectStore.saveSnapshot(input.sessionId, input.snapshot);
    return {
      sessionId: input.sessionId,
      snapshot,
    };
  }

  async performProjectAction(input: ProductProjectAction): Promise<{ sessionId: string; snapshot: ProductProjectSnapshot }> {
    const graph = await this.taskGraphStore.getGraph({ sessionId: input.sessionId });
    const currentSnapshot = await this.projectStore.getSnapshot({
      sessionId: input.sessionId,
      graph,
    });
    const cancelSessionId = resolveAssignedCardRunCancelSessionId(currentSnapshot, input);
    const snapshot = await this.projectStore.applyAction({
      sessionId: input.sessionId,
      graph,
      action: input,
    });
    if (cancelSessionId !== undefined) {
      this.cardRunAbortControllers.get(cancelSessionId)?.abort();
    }
    if (isCardThreadStartAction(input.type)) {
      this.startAssignedCardThreadInBackground({
        projectSessionId: input.sessionId,
        snapshot,
        action: input,
      });
    }
    return {
      sessionId: input.sessionId,
      snapshot,
    };
  }

  async getProjectReviewDetail(input: { sessionId: string; target: ProductReviewTarget }): Promise<{ sessionId: string; detail: ProductReviewDetail }> {
    const graph = await this.taskGraphStore.getGraph({ sessionId: input.sessionId });
    return {
      sessionId: input.sessionId,
      detail: await this.projectStore.getReviewDetail({
        sessionId: input.sessionId,
        graph,
        target: input.target,
      }),
    };
  }

  async performProjectReviewAction(input: { sessionId: string; action: ProductReviewAction }): Promise<{ sessionId: string; detail: ProductReviewDetail }> {
    const graph = await this.taskGraphStore.getGraph({ sessionId: input.sessionId });
    return {
      sessionId: input.sessionId,
      detail: await this.projectStore.applyReviewAction({
        sessionId: input.sessionId,
        graph,
        action: input.action,
      }),
    };
  }

  private startAssignedCardThreadInBackground(input: {
    projectSessionId: string;
    snapshot: ProductProjectSnapshot;
    action: ProductProjectAction;
  }): void {
    void this.runAssignedCardThread(input).catch(() => {});
  }

  private async runAssignedCardThread(input: {
    projectSessionId: string;
    snapshot: ProductProjectSnapshot;
    action: ProductProjectAction;
  }): Promise<ProductProjectSnapshot> {
    const card = findClaimedActionCard(input.snapshot, input.action);
    if (card?.activeClaim === undefined) {
      return input.snapshot;
    }
    const kind = card.activeClaim.kind;
    const abortController = new AbortController();
    this.cardRunAbortControllers.set(card.activeClaim.sessionId, abortController);
    let result: RuntimeTurnResult;
    try {
      result = await this.turnRunner.runTurn({
        sessionId: card.activeClaim.sessionId,
        message: kind === "testing"
          ? buildTestingThreadPrompt(card)
          : buildImplementationThreadPrompt(card),
        eventType: kind === "testing" ? "project.card.testing" : "project.card.implementation",
        interactionMode: "build",
        actSubmode: "full_auto",
        executionPolicy: {
          toolClassPolicy: buildAssignedCardToolClassPolicy(input.snapshot),
          approvalPolicy: {
            strictApprovalPerCall: false,
          },
        },
        metadata: {
          projectSessionId: input.projectSessionId,
          cardId: card.id,
          cardThreadKind: kind,
        },
        ...(buildAssignedCardWorkspace(input.snapshot) !== undefined
          ? { workspace: buildAssignedCardWorkspace(input.snapshot) }
          : {}),
        actor: {
          actorType: "service",
          actorId: "project-autopilot",
        },
      }, { signal: abortController.signal });
    } catch (error) {
      const graph = await this.taskGraphStore.getGraph({ sessionId: input.projectSessionId });
      return this.projectStore.applyAction({
        sessionId: input.projectSessionId,
        graph,
        action: {
          type: abortController.signal.aborted
            ? "board.card.thread_stopped"
            : "board.card.thread_failed",
          actionId: randomUUID(),
          actionTs: new Date().toISOString(),
          sessionId: input.projectSessionId,
          cardId: card.id,
          summary: abortController.signal.aborted
            ? "Assigned card thread stopped."
            : summarizeUnknownRunFailure(error),
        },
      });
    } finally {
      this.cardRunAbortControllers.delete(card.activeClaim.sessionId);
    }
    const graph = await this.taskGraphStore.getGraph({ sessionId: input.projectSessionId });
    if (kind === "implementation") {
      const nextSnapshot = await this.projectStore.applyAction({
        sessionId: input.projectSessionId,
        graph,
        action: {
          type: result.output.status === "COMPLETED"
            ? "board.card.thread_completed"
            : "board.card.thread_failed",
          actionId: randomUUID(),
          actionTs: new Date().toISOString(),
          sessionId: input.projectSessionId,
          cardId: card.id,
          summary: result.output.status === "COMPLETED"
            ? "Implementation thread completed."
            : summarizeRunFailure(result.output.errors),
        },
      });
      return this.continueAutopilotTestingAfterImplementation({
        projectSessionId: input.projectSessionId,
        snapshot: nextSnapshot,
        cardId: card.id,
        implementationCompleted: result.output.status === "COMPLETED",
      });
    }
    return this.projectStore.applyAction({
      sessionId: input.projectSessionId,
      graph,
      action: {
        type: "board.card.testing_verdict",
        actionId: randomUUID(),
        actionTs: new Date().toISOString(),
        sessionId: input.projectSessionId,
        cardId: card.id,
        testingVerdict: readTestingVerdict(result.finalizedPayload) === "pass" &&
          result.output.status === "COMPLETED"
          ? "pass"
          : "fail",
        summary: result.output.status === "COMPLETED"
          ? summarizeTestingPayload(result.finalizedPayload)
          : summarizeRunFailure(result.output.errors),
      },
    });
  }

  private async continueAutopilotTestingAfterImplementation(input: {
    projectSessionId: string;
    snapshot: ProductProjectSnapshot;
    cardId: string;
    implementationCompleted: boolean;
  }): Promise<ProductProjectSnapshot> {
    if (
      input.implementationCompleted === false ||
      input.snapshot.board.settings.autopilotEnabled !== true
    ) {
      return input.snapshot;
    }
    const card = input.snapshot.board.cards[input.cardId];
    if (card === undefined || card.lane !== "testing" || card.activeClaim !== undefined) {
      return input.snapshot;
    }
    const graph = await this.taskGraphStore.getGraph({ sessionId: input.projectSessionId });
    const action: ProductProjectAction = {
      type: "board.card.start_testing",
      actionId: randomUUID(),
      actionTs: new Date().toISOString(),
      sessionId: input.projectSessionId,
      cardId: card.id,
      source: "autopilot",
      summary: "Autopilot started testing after implementation completed.",
    };
    const claimed = await this.projectStore.applyAction({
      sessionId: input.projectSessionId,
      graph,
      action,
    });
    return this.runAssignedCardThread({
      projectSessionId: input.projectSessionId,
      snapshot: claimed,
      action,
    });
  }

}

export interface ProductProjectActionToolAdapter {
  apply(action: ProductProjectAction): Promise<{
    sessionId: string;
    snapshot: ProductProjectSnapshot;
  }>;
}

export function createProductProjectActionToolAdapter(input: {
  taskGraphStore: Pick<ProductTaskGraphStore, "getGraph">;
  projectStore: Pick<ProductProjectStateStore, "applyAction">;
}): ProductProjectActionToolAdapter {
  return {
    apply: (action) => applyProductProjectToolAction({
      taskGraphStore: input.taskGraphStore,
      projectStore: input.projectStore,
      action,
    }),
  };
}

export async function applyProductProjectToolAction(input: {
  taskGraphStore: Pick<ProductTaskGraphStore, "getGraph">;
  projectStore: Pick<ProductProjectStateStore, "applyAction">;
  action: ProductProjectAction;
}): Promise<{
  sessionId: string;
  snapshot: ProductProjectSnapshot;
}> {
  const graph = await input.taskGraphStore.getGraph({ sessionId: input.action.sessionId });
  const snapshot = await input.projectStore.applyAction({
    sessionId: input.action.sessionId,
    graph,
    action: input.action,
  });
  return {
    sessionId: input.action.sessionId,
    snapshot,
  };
}

export function requireProductProjectRuntimeService(
  service: ProductProjectRuntimeService | undefined,
): ProductProjectRuntimeService {
  if (service === undefined) {
    throw createRuntimeFailure("PROJECT_ACTION_UNAVAILABLE", "Project runtime is unavailable.");
  }
  return service;
}

function isCardThreadStartAction(type: ProductProjectAction["type"]): boolean {
  return type === "board.card.start_implementation" ||
    type === "board.card.start_testing" ||
    type === "board.autopilot.tick";
}

function findClaimedActionCard(
  snapshot: ProductProjectSnapshot,
  action: ProductProjectAction,
): ProductBoardCard | undefined {
  if ("cardId" in action && typeof action.cardId === "string") {
    return snapshot.board.cards[action.cardId];
  }
  if (action.type === "board.autopilot.tick") {
    return Object.values(snapshot.board.cards).find((card) =>
      card.activeClaim?.sessionId.endsWith(`:${action.actionId}:start-testing:${card.id}`) === true ||
      card.activeClaim?.sessionId.endsWith(`:${action.actionId}:start-implementation:${card.id}`) === true,
    );
  }
  return ;
}

function resolveAssignedCardRunCancelSessionId(
  snapshot: ProductProjectSnapshot,
  action: ProductProjectAction,
): string | undefined {
  if (action.type !== "board.card.move" && action.type !== "board.card.manual_done") {
    return ;
  }
  const card = action.cardId !== undefined ? snapshot.board.cards[action.cardId] : undefined;
  if (action.type === "board.card.manual_done") {
    return card?.activeClaim?.sessionId;
  }
  const targetLane = action.targetLane ?? action.lane;
  if (
    card?.activeClaim === undefined ||
    (card.lane !== "wip" && card.lane !== "testing")
  ) {
    return ;
  }
  return targetLane === "planned" || targetLane === "idea" || targetLane === "done"
    ? card.activeClaim.sessionId
    : undefined;
}

function buildImplementationThreadPrompt(card: ProductBoardCard): string {
  return [
    `You are working on Kestrel project card ${card.id}: ${card.title}.`,
    "",
    "Card prompt:",
    card.prompt,
    "",
    "Use build mode within the project scope. Keep the work scoped to this card.",
    "When the implementation is complete, finish normally. Do not mark the card done; the board will move it to testing.",
    buildCardEvidencePrompt(card),
  ].filter((line) => line.length > 0).join("\n");
}

function buildTestingThreadPrompt(card: ProductBoardCard): string {
  return [
    `You are validating Kestrel project card ${card.id}: ${card.title}.`,
    "",
    "Original card prompt:",
    card.prompt,
    "",
    "Validate the current output. Do not repair failures in this testing thread.",
    "Your final response must include a structured testing verdict as JSON with this shape:",
    "{\"testingVerdict\":\"pass\",\"summary\":\"short evidence summary\"}",
    "Use testingVerdict \"fail\" if validation does not pass.",
    buildCardEvidencePrompt(card),
  ].filter((line) => line.length > 0).join("\n");
}

function buildCardEvidencePrompt(card: ProductBoardCard): string {
  if (card.evidence.length === 0) {
    return "";
  }
  const recent = card.evidence.slice(-8).map((entry) =>
    `- ${entry.timestamp} ${entry.source}/${entry.outcome}: ${entry.summary}`,
  );
  return ["", "Recent card evidence:", ...recent].join("\n");
}

function readTestingVerdict(value: unknown): "pass" | "fail" {
  const record = asRecord(value);
  const direct = record?.testingVerdict ?? record?.verdict;
  if (direct === "pass" || direct === "fail") {
    return direct;
  }
  const output = asRecord(record?.output);
  const nested = output?.testingVerdict ?? output?.verdict;
  return nested === "pass" ? "pass" : "fail";
}

function summarizeTestingPayload(value: unknown): string {
  const record = asRecord(value);
  const summary = record?.summary ?? asRecord(record?.output)?.summary;
  return typeof summary === "string" && summary.trim().length > 0
    ? summary.trim()
    : `Testing verdict: ${readTestingVerdict(value)}.`;
}

function summarizeRunFailure(errors: RuntimeTurnResult["output"]["errors"]): string {
  const first = errors[0];
  return first !== undefined
    ? `${first.code}: ${first.message}`
    : "Assigned card thread failed.";
}

function summarizeUnknownRunFailure(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

function buildAssignedCardToolClassPolicy(
  snapshot: ProductProjectSnapshot,
): Record<"read_only" | "sandboxed_only" | "external_side_effect", boolean> {
  return {
    read_only: snapshot.policy.toolClassPolicy.read_only === true,
    sandboxed_only: snapshot.policy.toolClassPolicy.sandboxed_only === true,
    external_side_effect: snapshot.policy.toolClassPolicy.external_side_effect === true,
  };
}

function buildAssignedCardWorkspace(
  snapshot: ProductProjectSnapshot,
): RuntimeTurnInput["workspace"] | undefined {
  const empty = createEmptyProjectSnapshot();
  const workspaceRoot = snapshot.setup.workspaceRoot.trim();
  if (workspaceRoot.length === 0 || workspaceRoot === empty.setup.workspaceRoot) {
    return ;
  }
  return {
    workspaceId: workspaceRoot,
    workspaceRoot,
    appRoot: ".",
    label: snapshot.setup.repoLabel.trim() || workspaceRoot,
    commands: {},
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}
