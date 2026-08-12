import { rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedPaths = ["dist", "dist-pages"];

for (const relativePath of generatedPaths) {
  const target = resolve(projectRoot, relativePath);
  if (!target.startsWith(`${projectRoot}${sep}`)) {
    throw new Error(`Refusing to remove a path outside the project: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
}

console.log("Removed generated website build directories.");
