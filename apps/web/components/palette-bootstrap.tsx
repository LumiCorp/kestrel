import {
  DEFAULT_PALETTE_PREFERENCES,
  PALETTE_FAMILIES,
  PALETTE_STORAGE_KEY,
  PALETTE_TOKEN_NAMES,
} from "@/lib/palettes";

const bootstrapPayload = JSON.stringify({
  defaultPreferences: DEFAULT_PALETTE_PREFERENCES,
  storageKey: PALETTE_STORAGE_KEY,
  tokenNames: PALETTE_TOKEN_NAMES,
  palettes: Object.fromEntries(
    PALETTE_FAMILIES.map((palette) => [
      palette.id,
      { light: palette.light, dark: palette.dark },
    ])
  ),
}).replaceAll("<", "\\u003c");

const bootstrapSource = `(()=>{try{const c=${bootstrapPayload};let p=c.defaultPreferences;try{const s=localStorage.getItem(c.storageKey);if(s){const v=JSON.parse(s);p={light:c.palettes[v.light]?v.light:c.defaultPreferences.light,dark:c.palettes[v.dark]?v.dark:c.defaultPreferences.dark}}}catch{}const e=document.documentElement;e.dataset.lightPalette=p.light;e.dataset.darkPalette=p.dark;for(const m of ["light","dark"]){const t=c.palettes[p[m]][m];for(const n of c.tokenNames)e.style.setProperty("--palette-"+m+"-"+n,t[n])}}catch{}})()`;

export function PaletteBootstrap() {
  return (
    <script id="kestrel-palette-bootstrap" suppressHydrationWarning>
      {bootstrapSource}
    </script>
  );
}
