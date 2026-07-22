import Link from "next/link";
import { cn } from "@/lib/utils";
import { BrandLockup } from "./brand-lockup";
import { BrandMark } from "./brand-mark";

export function BrandHomeLink({ className }: { className?: string }) {
  return (
    <Link
      aria-label="Kestrel One home"
      className={cn("flex items-center overflow-hidden", className)}
      href="/"
    >
      <BrandLockup
        className="group-data-[collapsible=icon]:hidden"
        decorative
        height={16}
      />
      <BrandMark
        className="hidden group-data-[collapsible=icon]:block"
        decorative
        size={24}
      />
    </Link>
  );
}
