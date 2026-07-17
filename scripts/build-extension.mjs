import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const outdir = "dist-extension";
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await Promise.all([
  build({ entryPoints: ["extension/service-worker.ts"], outfile: `${outdir}/service-worker.js`, bundle: true, format: "esm", platform: "browser", target: "chrome120", sourcemap: false, minify: true }),
  build({ entryPoints: ["extension/meoi-content.ts"], outfile: `${outdir}/meoi-content.js`, bundle: true, format: "iife", platform: "browser", target: "chrome120", sourcemap: false, minify: true }),
  build({ entryPoints: ["extension/chatgpt-content.ts"], outfile: `${outdir}/chatgpt-content.js`, bundle: true, format: "iife", platform: "browser", target: "chrome120", sourcemap: false, minify: true }),
  build({ entryPoints: ["extension/popup.ts"], outfile: `${outdir}/popup.js`, bundle: true, format: "iife", platform: "browser", target: "chrome120", sourcemap: false, minify: true }),
]);

await Promise.all([
  cp("extension/manifest.json", `${outdir}/manifest.json`),
  cp("extension/popup.html", `${outdir}/popup.html`),
  cp("extension/popup.css", `${outdir}/popup.css`),
]);
