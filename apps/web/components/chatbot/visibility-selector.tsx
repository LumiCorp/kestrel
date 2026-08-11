"use client";

import { type ReactNode, useState } from "react";
import { Button } from "@/components/chatbot/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/chatbot/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  CheckCircleFillIcon,
  ChevronDownIcon,
  GlobeIcon,
  LockIcon,
} from "./icons";

export type VisibilityType = "private" | "public";

const visibilities: Array<{
  id: VisibilityType;
  label: string;
  description: string;
  icon: ReactNode;
}> = [
  {
    id: "private",
    label: "Private",
    description: "Only authorized workspace members can access this Thread",
    icon: <LockIcon />,
  },
  {
    id: "public",
    label: "Public",
    description: "Anyone with the link can access this Thread",
    icon: <GlobeIcon />,
  },
];

export function VisibilitySelector({
  className,
  onVisibilityTypeChange,
  visibilityType,
}: {
  onVisibilityTypeChange: (visibilityType: VisibilityType) => void;
  visibilityType: VisibilityType;
} & React.ComponentProps<typeof Button>) {
  const [open, setOpen] = useState(false);

  const selectedVisibility = visibilities.find(
    (visibility) => visibility.id === visibilityType
  );

  return (
    <DropdownMenu onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger
        asChild
        className={cn(
          "w-fit data-[state=open]:bg-accent data-[state=open]:text-accent-foreground",
          className
        )}
      >
        <Button
          className="hidden h-8 md:flex md:h-fit md:px-2"
          data-testid="visibility-selector"
          variant="outline"
        >
          {selectedVisibility?.icon}
          <span className="md:sr-only">{selectedVisibility?.label}</span>
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-[300px]">
        {visibilities.map((visibility) => (
          <DropdownMenuItem
            className="group/item flex flex-row items-center justify-between gap-4"
            data-active={visibility.id === visibilityType}
            data-testid={`visibility-selector-item-${visibility.id}`}
            key={visibility.id}
            onSelect={() => {
              onVisibilityTypeChange(visibility.id);
              setOpen(false);
            }}
          >
            <div className="flex flex-col items-start gap-1">
              {visibility.label}
              {visibility.description && (
                <div className="text-muted-foreground text-xs">
                  {visibility.description}
                </div>
              )}
            </div>
            <div className="text-foreground opacity-0 group-data-[active=true]/item:opacity-100 dark:text-foreground">
              <CheckCircleFillIcon />
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function VisibilityMenuSub({
  onVisibilityTypeChange,
  visibilityType,
}: {
  onVisibilityTypeChange: (visibilityType: VisibilityType) => void;
  visibilityType: VisibilityType;
}) {
  const selectedVisibility = visibilities.find(
    (visibility) => visibility.id === visibilityType
  );

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="min-h-11">
        {selectedVisibility?.icon}
        Visibility: {selectedVisibility?.label}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup
          onValueChange={(value) =>
            onVisibilityTypeChange(value as VisibilityType)
          }
          value={visibilityType}
        >
          {visibilities.map((visibility) => (
            <DropdownMenuRadioItem
              className="min-h-11"
              key={visibility.id}
              value={visibility.id}
            >
              {visibility.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
