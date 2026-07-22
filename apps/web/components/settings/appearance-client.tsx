"use client";

import { Check, Laptop, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import type { CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { usePalette } from "@/components/palette-provider";
import { cn } from "@/lib/utils";
import {
  PALETTE_FAMILIES,
  type PaletteId,
  type PaletteMode,
  type PaletteTokens,
} from "@/lib/palettes";

const appearanceModes = [
  {
    id: "system",
    label: "System",
    description: "Follow this device",
    icon: Laptop,
  },
  {
    id: "light",
    label: "Light",
    description: "Always use light mode",
    icon: Sun,
  },
  {
    id: "dark",
    label: "Dark",
    description: "Always use dark mode",
    icon: Moon,
  },
] as const;

function previewStyle(tokens: PaletteTokens): CSSProperties {
  return {
    "--background": tokens.background,
    "--foreground": tokens.foreground,
    "--muted": tokens.muted,
    "--muted-foreground": tokens["muted-foreground"],
    "--primary": tokens.primary,
    "--primary-foreground": tokens["primary-foreground"],
    "--accent": tokens.accent,
    "--accent-foreground": tokens["accent-foreground"],
    "--border": tokens.border,
  } as CSSProperties;
}

function PalettePreview({ tokens }: { tokens: PaletteTokens }) {
  return (
    <div
      aria-hidden="true"
      className="mt-4 overflow-hidden rounded-md border bg-background text-foreground"
      style={previewStyle(tokens)}
    >
      <div className="flex items-center gap-1.5 border-b bg-muted px-3 py-2">
        <span className="size-2 rounded-full bg-primary" />
        <span className="size-2 rounded-full bg-accent" />
        <span className="ml-auto h-1.5 w-10 rounded-full bg-muted-foreground/40" />
      </div>
      <div className="space-y-2.5 p-3">
        <div className="h-2 w-3/5 rounded-full bg-foreground/80" />
        <div className="h-1.5 w-4/5 rounded-full bg-muted-foreground/55" />
        <div className="flex items-center gap-2 pt-1">
          <Button
            className="pointer-events-none h-6 px-2 text-[10px]"
            size="sm"
            tabIndex={-1}
          >
            Continue
          </Button>
          <span className="rounded-sm bg-accent px-2 py-1 font-medium text-[10px] text-accent-foreground">
            Accent
          </span>
        </div>
      </div>
    </div>
  );
}

function PaletteGrid({
  mode,
  value,
  onValueChange,
}: {
  mode: PaletteMode;
  value: PaletteId;
  onValueChange: (value: PaletteId) => void;
}) {
  return (
    <RadioGroup
      aria-label={`${mode === "light" ? "Light" : "Dark"} palette`}
      className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"
      onValueChange={(next) => onValueChange(next as PaletteId)}
      value={value}
    >
      {PALETTE_FAMILIES.map((palette) => {
        const selected = palette.id === value;
        return (
          <label
            className={cn(
              "relative cursor-pointer rounded-lg border bg-background p-3 transition-colors hover:border-ring/70",
              selected && "border-ring ring-2 ring-ring/20"
            )}
            htmlFor={`${mode}-palette-${palette.id}`}
            key={palette.id}
          >
            <div className="flex items-start gap-3">
              <RadioGroupItem
                className="mt-0.5"
                id={`${mode}-palette-${palette.id}`}
                value={palette.id}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-sm">{palette.label}</span>
                  {selected ? (
                    <Check className="size-4 text-primary" aria-hidden="true" />
                  ) : null}
                </div>
                <p className="mt-0.5 text-muted-foreground text-xs/5">
                  {palette.description}
                </p>
              </div>
            </div>
            <PalettePreview tokens={palette[mode]} />
          </label>
        );
      })}
    </RadioGroup>
  );
}

export function AppearanceSettings() {
  const { theme, setTheme } = useTheme();
  const {
    light: lightPalette,
    dark: darkPalette,
    setLightPalette,
    setDarkPalette,
  } = usePalette();

  return (
    <div className="space-y-10">
      <section
        aria-labelledby="appearance-mode-heading"
        className="grid gap-5 border-t py-6 lg:grid-cols-[minmax(12rem,17rem)_minmax(0,1fr)] lg:gap-10"
      >
        <div>
          <h3 className="font-semibold text-base tracking-tight" id="appearance-mode-heading">
            Appearance mode
          </h3>
          <p className="mt-1 max-w-sm text-muted-foreground text-sm/6">
            Choose when Kestrel One uses your light and dark palettes.
          </p>
        </div>
        <RadioGroup
          aria-labelledby="appearance-mode-heading"
          className="grid gap-3 sm:grid-cols-3"
          onValueChange={setTheme}
          value={theme ?? "system"}
        >
          {appearanceModes.map((mode) => {
            const selected = (theme ?? "system") === mode.id;
            return (
              <label
                className={cn(
                  "cursor-pointer rounded-lg border bg-background p-4 transition-colors hover:border-ring/70",
                  selected && "border-ring ring-2 ring-ring/20"
                )}
                htmlFor={`appearance-mode-${mode.id}`}
                key={mode.id}
              >
                <div className="flex items-center gap-3">
                  <RadioGroupItem
                    id={`appearance-mode-${mode.id}`}
                    value={mode.id}
                  />
                  <mode.icon className="size-4" aria-hidden="true" />
                  <span className="font-medium text-sm">{mode.label}</span>
                </div>
                <p className="mt-2 pl-7 text-muted-foreground text-xs/5">
                  {mode.description}
                </p>
              </label>
            );
          })}
        </RadioGroup>
      </section>

      <section
        aria-labelledby="light-palette-heading"
        className="grid gap-5 border-t py-6 lg:grid-cols-[minmax(12rem,17rem)_minmax(0,1fr)] lg:gap-10"
      >
        <div>
          <h3 className="font-semibold text-base tracking-tight" id="light-palette-heading">
            Light palette
          </h3>
          <p className="mt-1 max-w-sm text-muted-foreground text-sm/6">
            Used whenever light mode is active. Choosing it does not change your current mode.
          </p>
        </div>
        <PaletteGrid
          mode="light"
          onValueChange={setLightPalette}
          value={lightPalette}
        />
      </section>

      <section
        aria-labelledby="dark-palette-heading"
        className="grid gap-5 border-t py-6 lg:grid-cols-[minmax(12rem,17rem)_minmax(0,1fr)] lg:gap-10"
      >
        <div>
          <h3 className="font-semibold text-base tracking-tight" id="dark-palette-heading">
            Dark palette
          </h3>
          <p className="mt-1 max-w-sm text-muted-foreground text-sm/6">
            Used whenever dark mode is active. Choosing it does not change your current mode.
          </p>
        </div>
        <PaletteGrid
          mode="dark"
          onValueChange={setDarkPalette}
          value={darkPalette}
        />
      </section>
    </div>
  );
}
