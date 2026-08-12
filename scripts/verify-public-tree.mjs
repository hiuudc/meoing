import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const trackedFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean);
const forbiddenPaths = [
  /^frontend\/extension\//,
  /^frontend\/dist-extension\//,
  /^frontend\/scripts\/build-extension\.mjs$/,
  /^frontend\/vitest\.extension\.config\.ts$/,
];
const forbiddenPatterns = [
  { label: "browser extension API", pattern: /\bchrome\.(runtime|storage|tabs|scripting|sidePanel)\b/i },
  { label: "ChatGPT integration", pattern: /chatgpt\.com|chatgpt selector|chatgpt web/i },
  { label: "legacy browser origin", pattern: /MEOI_WEB_ORIGINS/ },
];
const ignoredSources = new Set([
  "scripts/verify-public-tree.mjs",
  "frontend/package-lock.json",
  "backend/package-lock.json",
  "backend/worker-configuration.d.ts",
]);
const failures = [];

for (const file of trackedFiles) {
  if (forbiddenPaths.some((pattern) => pattern.test(file))) {
    failures.push(`forbidden public path: ${file}`);
    continue;
  }
  if (ignoredSources.has(file) || file.startsWith(".git")) continue;
  let contents;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const { label, pattern } of forbiddenPatterns) {
    if (pattern.test(contents)) failures.push(`${label}: ${file}`);
  }
}

if (failures.length) {
  console.error("Public-tree audit failed:\n" + failures.join("\n"));
  process.exit(1);
}

console.log(`Public-tree audit passed for ${trackedFiles.length} tracked files.`);
