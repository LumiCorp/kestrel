"use client";

import { useEffect, useMemo, useState } from "react";
import { generateObjAsciiFrames } from "@/lib/ascii-renderer/render";

export function AsciiHeroSolid() {
  const [frames, setFrames] = useState<string[]>([]);
  const [frameIndex, setFrameIndex] = useState(0);

  const fontFamily = useMemo(
    () =>
      'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, monospace',
    []
  );

  useEffect(() => {
    let cancelled = false;

    generateObjAsciiFrames({
      cols: 52,
      rows: 30,
      cellWidth: 12,
      cellHeight: 16,
      fontFamily,
      fontPx: 15,
      frameCount: 72,
      objUrl: "/hawk/SharpShinnedHawk.obj",
      textureUrl: "/hawk/SharpShinnedHawk_BaseColor.jpg",
    }).then((nextFrames) => {
      if (!cancelled) {
        setFrames(nextFrames);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [fontFamily]);

  useEffect(() => {
    if (frames.length === 0) {
      return;
    }

    const interval = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % frames.length);
    }, 96);

    return () => window.clearInterval(interval);
  }, [frames]);

  const isLoading = frames.length === 0;

  return (
    <div className="relative h-full w-full overflow-hidden bg-transparent">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-25"
        style={{
          background:
            "radial-gradient(circle at center, color-mix(in oklab, var(--primary) 7%, transparent) 0%, transparent 54%)",
        }}
      />
      {isLoading ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center">
          <div
            aria-live="polite"
            className="flex min-w-[12rem] flex-col items-center gap-3 border border-border/70 border-dashed bg-background/78 px-5 py-4 font-mono text-[10px] text-foreground/80 uppercase tracking-[0.28em] backdrop-blur-sm"
            role="status"
          >
            <span className="animate-pulse">Rendering hawk</span>
            <span className="h-px w-20 animate-pulse bg-border/80" />
          </div>
        </div>
      ) : null}
      <pre
        aria-label="Animated ASCII platonic solid"
        className={`relative mx-auto flex min-h-full w-full origin-center items-center justify-center overflow-visible bg-transparent text-center font-mono text-[0.56rem] leading-[0.82] tracking-[-0.055em] sm:text-[0.68rem] md:scale-[1.35] md:text-[0.82rem] lg:scale-[1.75] lg:text-[0.94rem] xl:scale-[1.95] ${
          isLoading ? "text-foreground" : "hawk-ascii-sweep"
        }`}
      >
        {frames[frameIndex] ??
          "\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n"}
      </pre>
    </div>
  );
}
