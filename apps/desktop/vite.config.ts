import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";

const desktopDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(desktopDir, "renderer"),
  base: "./",
  esbuild: {
    jsx: "automatic",
  },
  build: {
    outDir: path.join(desktopDir, "static", "renderer"),
    emptyOutDir: true,
  },
});
