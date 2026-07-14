import { SiDiscord, SiGithub, SiYoutube } from "@icons-pack/react-simple-icons";
import { BookOpen, Boxes, CloudSun, FileText, Terminal } from "lucide-react";
import Image from "next/image";
import { cn } from "@/lib/utils";

export function AppIcon({
  appKey,
  icon,
  className,
}: {
  appKey: string;
  icon: string | null;
  className?: string;
}) {
  const frameClass = cn(
    "flex size-12 shrink-0 items-center justify-center rounded-xl border bg-background shadow-sm",
    className
  );
  if (icon?.startsWith("/")) {
    return (
      <span className={frameClass}>
        <Image
          alt=""
          className="size-7 object-contain"
          height={28}
          src={icon}
          width={28}
        />
      </span>
    );
  }
  const iconClass = "size-6";
  const glyph = (() => {
    if (appKey === "github" || appKey === "source.github") {
      return <SiGithub aria-hidden className={iconClass} />;
    }
    if (appKey === "discord") {
      return <SiDiscord aria-hidden className={iconClass} />;
    }
    if (appKey === "source.youtube") {
      return <SiYoutube aria-hidden className={iconClass} />;
    }
    if (appKey === "built_in.weather") {
      return <CloudSun aria-hidden className={iconClass} />;
    }
    if (appKey === "built_in.knowledge_search") {
      return <BookOpen aria-hidden className={iconClass} />;
    }
    if (appKey === "built_in.sandbox") {
      return <Terminal aria-hidden className={iconClass} />;
    }
    if (appKey === "built_in.artifacts") {
      return <FileText aria-hidden className={iconClass} />;
    }
    return <Boxes aria-hidden className={iconClass} />;
  })();
  return <span className={frameClass}>{glyph}</span>;
}
