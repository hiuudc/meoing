import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { strokeDataPlugin } from "./scripts/stroke-data-plugin.mjs";

export default defineConfig({
  plugins: [react(), strokeDataPlugin()],
  build: { outDir: "dist-pages" },
});
