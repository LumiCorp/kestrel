import type { QualityScorecard } from "./contracts.js";

export interface QualitySignals {
  domain: string;
  architectureCompliance: number;
  testDepth: number;
  incidentRate: number;
  drift: number;
  replayStability: number;
  latency: number;
  previousScore?: number | undefined;
}

export function buildQualityScorecard(signals: QualitySignals[]): QualityScorecard {
  return {
    generated_at: new Date().toISOString(),
    domains: signals.map((item) => {
      const score = Math.max(
        0,
        Math.min(
          100,
          Math.round(
            item.architectureCompliance * 0.2 +
              item.testDepth * 0.2 +
              item.replayStability * 0.2 +
              item.latency * 0.15 +
              (100 - item.incidentRate) * 0.15 +
              (100 - item.drift) * 0.1,
          ),
        ),
      );
      const previous = item.previousScore ?? score;
      return {
        domain: item.domain,
        score,
        trend: score > previous ? "up" : score < previous ? "down" : "flat",
        confidence: 0.8,
        recommended_actions: recommendActions(item),
      };
    }),
  };
}

function recommendActions(item: QualitySignals): string[] {
  const actions: string[] = [];
  if (item.architectureCompliance < 80) {
    actions.push("Fix architecture contract violations in this domain.");
  }
  if (item.testDepth < 75) {
    actions.push("Increase scenario and integration coverage.");
  }
  if (item.drift > 20) {
    actions.push("Run doc and code drift cleanup for this domain.");
  }
  if (item.incidentRate > 30) {
    actions.push("Prioritize reliability hardening and replay regression checks.");
  }
  if (actions.length === 0) {
    actions.push("Maintain baseline and monitor weekly.");
  }
  return actions;
}
