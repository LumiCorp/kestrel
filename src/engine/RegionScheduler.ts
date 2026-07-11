import type { StateNodeRef } from "../kestrel/contracts/base.js";
import type { RuntimeEvent } from "../kestrel/contracts/events.js";
import type { RegionWorkItem, Transition } from "../kestrel/contracts/execution.js";
import type { EffectStore, SessionRecord } from "../kestrel/contracts/store.js";

import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import { readActiveWaitState } from "../runtime/waitState.js";

export type RegionBeforeStepDecision =
  | {
      kind: "claim_region_work";
      step: string;
      regionItem: RegionWorkItem;
    }
  | {
      kind: "use_current_step";
      step: string;
    }
  | {
      kind: "wait_for_merge";
      step: string;
      waitFor: {
        kind: "region_merge";
        eventType: "system.meta_reasoning";
      };
    };

export type RegionAfterTransitionAction =
  | {
      kind: "spawn_region_work";
      items: Transition["regionOps"] extends infer T
        ? T extends { spawn?: infer U }
          ? U
          : never
        : never;
    }
  | {
      kind: "complete_named_regions";
      regions: string[];
    }
  | {
      kind: "complete_claim";
      regionItem: RegionWorkItem;
      outcome: "DONE" | "FAILED";
      error?: Record<string, unknown>;
    }
  | {
      kind: "sync_primary";
      syncNode: string;
    };

export interface RegionSchedulerDependencies {
  store: Pick<
    EffectStore,
    | "claimNextRegionWorkItem"
    | "listReadyRegionWorkItems"
    | "completeRegionWorkItem"
    | "spawnRegionWorkItems"
  >;
}

export class RegionScheduler {
  private readonly store: RegionSchedulerDependencies["store"];

  constructor(deps: RegionSchedulerDependencies) {
    this.store = deps.store;
  }

  async beforeStep(input: {
    event: RuntimeEvent;
    session: SessionRecord;
    currentStep: string | undefined;
    stepIndex: number;
    laneCursor: string | undefined;
  }): Promise<RegionBeforeStepDecision> {
    const hasExplicitStepOverride = input.stepIndex === 0 && input.event.stepAgent !== undefined;
    if (hasExplicitStepOverride) {
      return {
        kind: "use_current_step",
        step: input.event.stepAgent!,
      };
    }

    if (input.currentStep === undefined) {
      throw createRuntimeFailure(
        "RUN_REGION_STEP_MISSING",
        "No authoritative current step agent configured for session.",
        {
          subsystem: "runtime",
          classification: "determinism",
          sessionId: input.session.sessionId,
          stepIndex: input.stepIndex,
          eventType: input.event.type,
          contractPath: "session.currentStepAgent",
        },
      );
    }

    const wait = readActiveWaitState(asRecord(input.session.state.agent));
    if (wait?.kind === "region_merge" && input.event.type === "user.message") {
      return {
        kind: "wait_for_merge",
        step: input.currentStep,
        waitFor: {
          kind: "region_merge",
          eventType: "system.meta_reasoning",
        },
      };
    }

    const claimed = await this.store.claimNextRegionWorkItem(input.session.sessionId, input.laneCursor);
    if (claimed !== null) {
      return {
        kind: "claim_region_work",
        step: claimed.stepAgent,
        regionItem: claimed,
      };
    }

    return {
      kind: "use_current_step",
      step: input.currentStep,
    };
  }

  detectSyncConflict(
    activeRegionItem: RegionWorkItem | undefined,
    transition: Transition,
  ): string | undefined {
    if (activeRegionItem === undefined || transition.regionOps?.syncNode === undefined) {
      return undefined;
    }

    const patch = transition.statePatch;
    if (patch === undefined) {
      return `syncNode '${transition.regionOps.syncNode}' requires statePatch at regions.${activeRegionItem.region}`;
    }

    const patchKeys = Object.keys(patch);
    const nonRegionKeys = patchKeys.filter((key) => key !== "regions");
    if (nonRegionKeys.length > 0) {
      return `region sync patch must only write to state.regions.<region>; found root keys: ${nonRegionKeys.join(",")}`;
    }

    const regionsPatch = asRecord(patch.regions);
    if (regionsPatch === undefined) {
      return `region sync patch missing state.regions payload for '${activeRegionItem.region}'`;
    }

    const targetRegionPatch = asRecord(regionsPatch[activeRegionItem.region]);
    if (targetRegionPatch === undefined) {
      return `region sync patch missing regions.${activeRegionItem.region}`;
    }

    return undefined;
  }

  afterTransition(input: {
    transition: Transition;
    activeRegionItem?: RegionWorkItem | undefined;
  }): RegionAfterTransitionAction[] {
    const actions: RegionAfterTransitionAction[] = [];

    if ((input.transition.regionOps?.spawn ?? []).length > 0) {
      actions.push({
        kind: "spawn_region_work",
        items: input.transition.regionOps?.spawn ?? [],
      });
    }

    if ((input.transition.regionOps?.complete ?? []).length > 0) {
      actions.push({
        kind: "complete_named_regions",
        regions: input.transition.regionOps?.complete ?? [],
      });
    }

    if (input.activeRegionItem !== undefined) {
      actions.push({
        kind: "complete_claim",
        regionItem: input.activeRegionItem,
        outcome: input.transition.status === "FAILED" ? "FAILED" : "DONE",
        ...(input.transition.status === "FAILED"
          ? {
              error: {
                code: "REGION_STEP_FAILED",
                status: input.transition.status,
              },
            }
          : {}),
      });
    }

    if (input.transition.regionOps?.syncNode !== undefined) {
      actions.push({
        kind: "sync_primary",
        syncNode: input.transition.regionOps.syncNode,
      });
    }

    return actions;
  }

  async completeNamedRegions(
    sessionId: string,
    regions: string[],
  ): Promise<Array<{ id: number; region: string }>> {
    if (regions.length === 0) {
      return [];
    }

    const expected = new Set(regions);
    const pending = await this.store.listReadyRegionWorkItems(sessionId);
    const matching = pending.filter((item) => expected.has(item.region));
    for (const item of matching) {
      await this.store.completeRegionWorkItem(item.id, "DONE");
    }

    return matching.map((item) => ({ id: item.id, region: item.region }));
  }

  async isSyncNodeSettled(sessionId: string): Promise<boolean> {
    const remaining = await this.store.listReadyRegionWorkItems(sessionId);
    return remaining.length === 0;
  }

  async failClaim(item: RegionWorkItem, error: Record<string, unknown>): Promise<void> {
    await this.store.completeRegionWorkItem(item.id, "FAILED", error);
  }

  async completeClaim(
    item: RegionWorkItem,
    outcome: "DONE" | "FAILED",
    error?: Record<string, unknown>,
  ): Promise<void> {
    await this.store.completeRegionWorkItem(item.id, outcome, error);
  }

  async spawnRegionWorkItems(
    sessionId: string,
    items: Array<{ region: string; stepAgent: string; stateNode?: StateNodeRef | undefined }>,
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }
    await this.store.spawnRegionWorkItems(sessionId, items);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : undefined;
}
