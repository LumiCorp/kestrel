"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  applyPalettePreferencesToElement,
  DEFAULT_PALETTE_PREFERENCES,
  type PaletteId,
  type PalettePreferences,
  PALETTE_STORAGE_KEY,
  parseStoredPalettePreferences,
  serializePalettePreferences,
} from "@/lib/palettes";

type PaletteContextValue = PalettePreferences & {
  setLightPalette: (palette: PaletteId) => void;
  setDarkPalette: (palette: PaletteId) => void;
};

const PaletteContext = createContext<PaletteContextValue | null>(null);

function apply(preferences: PalettePreferences) {
  applyPalettePreferencesToElement(document.documentElement, preferences);
}

export function PaletteProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<PalettePreferences>(
    DEFAULT_PALETTE_PREFERENCES
  );
  const preferencesRef = useRef(preferences);

  const replacePreferences = useCallback((next: PalettePreferences) => {
    preferencesRef.current = next;
    setPreferences(next);
    apply(next);
  }, []);

  useEffect(() => {
    let initial = DEFAULT_PALETTE_PREFERENCES;
    try {
      initial = parseStoredPalettePreferences(
        window.localStorage.getItem(PALETTE_STORAGE_KEY)
      );
    } catch {
      // The bootstrap has already installed the defaults. Storage failures are
      // reported only when the user attempts to save a choice.
    }
    replacePreferences(initial);

    const onStorage = (event: StorageEvent) => {
      if (event.key !== PALETTE_STORAGE_KEY) return;
      replacePreferences(parseStoredPalettePreferences(event.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [replacePreferences]);

  const updatePreference = useCallback(
    (mode: "light" | "dark", palette: PaletteId) => {
      const next = { ...preferencesRef.current, [mode]: palette };
      replacePreferences(next);
      try {
        window.localStorage.setItem(
          PALETTE_STORAGE_KEY,
          serializePalettePreferences(next)
        );
      } catch {
        toast.warning(
          "This palette is active, but it could not be saved in this browser."
        );
      }
    },
    [replacePreferences]
  );

  const setLightPalette = useCallback(
    (palette: PaletteId) => updatePreference("light", palette),
    [updatePreference]
  );
  const setDarkPalette = useCallback(
    (palette: PaletteId) => updatePreference("dark", palette),
    [updatePreference]
  );

  return (
    <PaletteContext.Provider
      value={{ ...preferences, setLightPalette, setDarkPalette }}
    >
      {children}
    </PaletteContext.Provider>
  );
}

export function usePalette() {
  const context = useContext(PaletteContext);
  if (!context) {
    throw new Error("usePalette must be used inside PaletteProvider");
  }
  return context;
}
