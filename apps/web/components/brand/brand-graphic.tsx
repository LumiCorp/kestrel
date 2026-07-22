import Image from "next/image";
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

export type BrandTone = "auto" | "black" | "white";

type BrandGraphicProps = {
  blackSrc: string;
  whiteSrc: string;
  width: number;
  height: number;
  tone: BrandTone;
  decorative: boolean;
  className?: string;
};

function BrandAsset({
  className,
  src,
  width,
}: {
  className?: string;
  src: string;
  width: number;
}) {
  return (
    <Image
      alt=""
      aria-hidden="true"
      className={cn("object-contain", className)}
      fill
      priority
      sizes={`${Math.ceil(width)}px`}
      src={src}
      unoptimized
    />
  );
}

export function BrandGraphic({
  blackSrc,
  className,
  decorative,
  height,
  tone,
  whiteSrc,
  width,
}: BrandGraphicProps) {
  const accessibility = decorative
    ? { "aria-hidden": true as const }
    : { "aria-label": "Kestrel One", role: "img" as const };
  const style: CSSProperties = { height, width };

  return (
    <span
      className={cn("relative inline-block shrink-0", className)}
      style={style}
      {...accessibility}
    >
      {tone === "auto" ? (
        <>
          <BrandAsset
            className="dark:hidden"
            src={blackSrc}
            width={width}
          />
          <BrandAsset
            className="hidden dark:block"
            src={whiteSrc}
            width={width}
          />
        </>
      ) : (
        <BrandAsset
          src={tone === "black" ? blackSrc : whiteSrc}
          width={width}
        />
      )}
    </span>
  );
}
