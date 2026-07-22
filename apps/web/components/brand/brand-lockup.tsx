import { BrandGraphic, type BrandTone } from "./brand-graphic";

const LOCKUP_ASPECT_RATIO = 6.8;

export function BrandLockup({
  className,
  decorative = false,
  height = 24,
  tone = "auto",
}: {
  className?: string;
  decorative?: boolean;
  height?: number;
  tone?: BrandTone;
}) {
  return (
    <BrandGraphic
      blackSrc="/brand/kestrel-one-lockup-black.svg"
      className={className}
      decorative={decorative}
      height={height}
      tone={tone}
      whiteSrc="/brand/kestrel-one-lockup-white.svg"
      width={height * LOCKUP_ASPECT_RATIO}
    />
  );
}
