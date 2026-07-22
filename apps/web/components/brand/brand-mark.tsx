import { BrandGraphic, type BrandTone } from "./brand-graphic";

export function BrandMark({
  className,
  decorative = false,
  size = 24,
  tone = "auto",
}: {
  className?: string;
  decorative?: boolean;
  size?: number;
  tone?: BrandTone;
}) {
  return (
    <BrandGraphic
      blackSrc="/brand/kestrel-mark-black.svg"
      className={className}
      decorative={decorative}
      height={size}
      tone={tone}
      whiteSrc="/brand/kestrel-mark-white.svg"
      width={size}
    />
  );
}
