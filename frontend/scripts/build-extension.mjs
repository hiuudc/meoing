import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const outdir = "dist-extension";
const localOrigins = ["http://127.0.0.1:5173", "http://127.0.0.1:4173"];
const configuredOrigins = (process.env.MEOI_WEB_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);
if (process.env.MEOI_REQUIRE_WEB_ORIGINS === "true" && configuredOrigins.length === 0) {
  throw new Error("MEOI_WEB_ORIGINS is required for staging and production extension builds.");
}
for (const origin of configuredOrigins) {
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== "https:") {
    throw new Error(`MEOI_WEB_ORIGINS must contain HTTPS origins without paths: ${origin}`);
  }
}
const allowedOrigins = [...new Set(
  configuredOrigins.length > 0 ? configuredOrigins : localOrigins,
)];
const webUrl = `${configuredOrigins[0] ?? localOrigins[0]}/`;
const buildDefines = {
  __MEOI_ALLOWED_ORIGINS__: JSON.stringify(allowedOrigins),
  __MEOI_WEB_URL__: JSON.stringify(webUrl),
};
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await Promise.all([
  build({ entryPoints: ["./extension/service-worker.ts"], outfile: `${outdir}/service-worker.js`, bundle: true, format: "esm", platform: "browser", target: "chrome120", sourcemap: false, minify: true, define: buildDefines }),
  build({ entryPoints: ["./extension/meoi-content.ts"], outfile: `${outdir}/meoi-content.js`, bundle: true, format: "iife", platform: "browser", target: "chrome120", sourcemap: false, minify: true, define: buildDefines }),
  build({ entryPoints: ["./extension/chatgpt-main.ts"], outfile: `${outdir}/chatgpt-main.js`, bundle: true, format: "iife", platform: "browser", target: "chrome120", sourcemap: false, minify: true }),
  build({ entryPoints: ["./extension/chatgpt-content.ts"], outfile: `${outdir}/chatgpt-content.js`, bundle: true, format: "iife", platform: "browser", target: "chrome120", sourcemap: false, minify: true }),
  build({ entryPoints: ["./extension/popup.ts"], outfile: `${outdir}/popup.js`, bundle: true, format: "iife", platform: "browser", target: "chrome120", sourcemap: false, minify: true, define: buildDefines }),
]);

await Promise.all([
  cp("extension/popup.html", `${outdir}/popup.html`),
  cp("extension/popup.css", `${outdir}/popup.css`),
]);

const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
const meoingScript = manifest.content_scripts.find((script) => script.js?.includes("meoi-content.js"));
if (!meoingScript) throw new Error("Meoing content script is missing from the extension manifest.");
// Chrome match patterns do not support ports. The content script may be
// injected on other ports for the same host, but integration-policy.ts still
// rejects messages unless their full origin (including port) is allowlisted.
meoingScript.matches = [...new Set(allowedOrigins.map((origin) => {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}))];
await writeFile(`${outdir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
