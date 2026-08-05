import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const minimumNodeMajor = 22;
const localHyperdriveConnection = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export function npmExecutable(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

export function parseNodeMajor(version) {
  return Number.parseInt(version.split(".")[0], 10);
}

export function validatePreflight({
  root = projectRoot,
  nodeVersion = process.versions.node,
} = {}) {
  const failures = [];

  if (!Number.isInteger(parseNodeMajor(nodeVersion)) || parseNodeMajor(nodeVersion) < minimumNodeMajor) {
    failures.push(`Node.js ${minimumNodeMajor} or newer is required (found ${nodeVersion}).`);
  }

  for (const relativePath of ["frontend/.env.local", "backend/.dev.vars"]) {
    if (!existsSync(resolve(root, relativePath))) {
      failures.push(`Missing ${relativePath}.`);
    }
  }

  return failures;
}

export function workerEnvironment(environment = process.env) {
  if (environment.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE) {
    return environment;
  }

  return {
    ...environment,
    CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: localHyperdriveConnection,
  };
}

function runCommand(label, args, environment = process.env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(npmExecutable(), args, {
      cwd: projectRoot,
      env: environment,
      stdio: "inherit",
    });

    child.once("error", (error) => {
      rejectPromise(new Error(`${label} could not start: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`${label} exited with ${signal ?? `code ${code}`}.`));
    });
  });
}

function startDevProcess(label, args, environment) {
  const child = spawn(npmExecutable(), args, {
    cwd: projectRoot,
    env: environment,
    stdio: "inherit",
  });

  child.once("error", (error) => {
    console.error(`${label} could not start: ${error.message}`);
  });

  return child;
}

function waitForExit(child, label) {
  return new Promise((resolvePromise) => {
    child.once("exit", (code, signal) => {
      resolvePromise({ label, code, signal });
    });
  });
}

function terminateProcessTree(child) {
  if (child.exitCode !== null || child.pid === undefined) {
    return Promise.resolve();
  }

  if (process.platform !== "win32") {
    child.kill("SIGTERM");
    return Promise.resolve();
  }

  return new Promise((resolvePromise) => {
    const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
    });
    taskkill.once("error", () => resolvePromise());
    taskkill.once("exit", () => resolvePromise());
  });
}

async function stopDevProcesses(processes) {
  await Promise.all(processes.map(({ child }) => terminateProcessTree(child)));
}

export async function startLocalDevelopment() {
  const failures = validatePreflight();
  if (failures.length > 0) {
    throw new Error([
      "Local development setup is incomplete:",
      ...failures.map((failure) => `- ${failure}`),
      "Copy backend/.dev.vars.example to backend/.dev.vars and configure its local secrets.",
    ].join("\n"));
  }

  console.log("Starting local Supabase (existing database data is preserved)...");
  await runCommand("Local Supabase", ["--prefix", "backend", "run", "db:start"]);

  const processes = [
    {
      label: "API Worker",
      child: startDevProcess(
        "API Worker",
        ["--prefix", "backend", "run", "dev"],
        workerEnvironment(),
      ),
    },
    {
      label: "Frontend",
      child: startDevProcess("Frontend", ["--prefix", "frontend", "run", "dev"], process.env),
    },
  ];

  console.log("\nMeoing local development is starting at http://127.0.0.1:5173");
  console.log("Press Ctrl+C once to stop the API Worker and frontend.\n");

  const stopSignal = new Promise((resolvePromise) => {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => resolvePromise({ label: signal, signal }));
    }
  });
  const childExit = Promise.race(processes.map(({ child, label }) => waitForExit(child, label)));
  const result = await Promise.race([stopSignal, childExit]);

  await stopDevProcesses(processes);

  if (result.signal) {
    return;
  }

  throw new Error(`${result.label} stopped unexpectedly with ${result.signal ?? `code ${result.code}`}.`);
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    await startLocalDevelopment();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
