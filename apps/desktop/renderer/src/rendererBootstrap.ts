import type { DesktopRendererBootstrapReport } from "../../src/contracts";

const RENDERER_STYLESHEET_SENTINEL = "--kestrel-renderer-bootstrap-ready";

export function readRendererBootstrapGeneration(): number | undefined {
  const raw = new URLSearchParams(window.location.search).get(
    "bootstrapGeneration",
  );
  if (raw === null) return;
  const generation = Number(raw);
  return Number.isSafeInteger(generation) && generation > 0
    ? generation
    : undefined;
}

export function reportRendererBootstrapFailure(
  reason: Extract<
    DesktopRendererBootstrapReport,
    { status: "failed" }
  >["reason"],
): void {
  const generation = readRendererBootstrapGeneration();
  if (generation === undefined) return;
  void window.kestrelDesktop
    .reportRendererBootstrap({ generation, status: "failed", reason })
    .catch(() => undefined);
}

export function reportRendererBootstrapReadyAfterCommit(): () => void {
  const generation = readRendererBootstrapGeneration();
  if (generation === undefined) return () => undefined;
  const frame = window.requestAnimationFrame(() => {
    const sentinel = window
      .getComputedStyle(document.documentElement)
      .getPropertyValue(RENDERER_STYLESHEET_SENTINEL)
      .trim();
    const report: DesktopRendererBootstrapReport =
      sentinel === "1"
        ? { generation, status: "ready" }
        : { generation, status: "failed", reason: "stylesheet_missing" };
    void window.kestrelDesktop
      .reportRendererBootstrap(report)
      .catch(() => undefined);
  });
  return () => window.cancelAnimationFrame(frame);
}
