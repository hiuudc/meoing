import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const minimumNodeMajor = 22;
const localHyperdriveConnection =
  "postgresql://meoing_api_login:meoing-local-api-password@127.0.0.1:54322/postgres";
const localDevVariableExpectations = {
  APP_ENV: "local",
  SUPABASE_JWT_AUDIENCE: "authenticated",
  SUPABASE_URL: "http://127.0.0.1:54321",
};
const requiredLocalSecrets = [
  "INVITE_TOKEN_SECRET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "TURNSTILE_SECRET_KEY",
];
const localDevServers = [
  {
    label: "Frontend",
    matches: (status, body) => status === 200 && body.includes("<title>Meoi \u00b7 Language Workspace</title>"),
    path: "/",
    port: 5173,
  },
  {
    label: "API Worker",
    matches: (status, body) => {
      try {
        const payload = JSON.parse(body);
        return status === 200 && payload?.data?.environment === "local" && payload?.data?.status === "ok";
      } catch {
        return false;
      }
    },
    path: "/health/live",
    port: 8787,
  },
];

export function npmExecutable(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

export function parseNodeMajor(version) {
  return Number.parseInt(version.split(".")[0], 10);
}

export function npmInvocation(args, platform = process.platform) {
  if (platform !== "win32") {
    return { args, command: npmExecutable(platform), shell: false };
  }

  return {
    args: [],
    command: [npmExecutable(platform), ...args].join(" "),
    shell: true,
  };
}

export function parseWindowsListeningPids(netstatOutput, port) {
  const pids = new Set();
  for (const line of netstatOutput.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (
      columns.length >= 5
      && columns[0].toUpperCase() === "TCP"
      && columns[1].endsWith(`:${port}`)
      && columns[3].toUpperCase() === "LISTENING"
      && /^\d+$/.test(columns[4])
    ) {
      pids.add(Number.parseInt(columns[4], 10));
    }
  }
  return [...pids];
}

export function isMeoingDevRunner(commandLine, label, root = projectRoot) {
  const command = commandLine.replaceAll("\\", "/").toLowerCase();
  const normalizedRoot = root.replaceAll("\\", "/").toLowerCase();
  if (!command.includes(normalizedRoot)) {
    return false;
  }
  if (label === "API Worker") {
    return command.includes("wrangler") && /\bdev\b/.test(command);
  }
  return command.includes("vite") && /(?:\bdev\b|--host\b)/.test(command);
}

export function isKnownLocalServerResponse(label, status, body) {
  const server = localDevServers.find((candidate) => candidate.label === label);
  return server?.matches(status, body) ?? false;
}

export function parseDevVariables(contents) {
  const variables = new Map();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    variables.set(key, value);
  }
  return variables;
}

export function validateLocalDevVariables(contents) {
  if (contents.includes("\\n") || contents.includes("\\r\\n")) {
    return ["backend/.dev.vars contains literal \\n text; replace it with real line breaks."];
  }

  const failures = [];
  const variables = parseDevVariables(contents);
  for (const [key, expected] of Object.entries(localDevVariableExpectations)) {
    if (!variables.has(key)) {
      failures.push(`Missing ${key} in backend/.dev.vars.`);
    } else if (variables.get(key) !== expected) {
      failures.push(`${key} in backend/.dev.vars must be ${expected}.`);
    }
  }
  for (const key of requiredLocalSecrets) {
    if (!variables.get(key)) {
      failures.push(`Missing ${key} in backend/.dev.vars.`);
    }
  }
  return failures;
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

  const devVariablesPath = resolve(root, "backend/.dev.vars");
  if (existsSync(devVariablesPath)) {
    failures.push(...validateLocalDevVariables(readFileSync(devVariablesPath, "utf8")));
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
    const invocation = npmInvocation(args);
    const child = spawn(invocation.command, invocation.args, {
      cwd: projectRoot,
      env: environment,
      shell: invocation.shell,
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

function runBufferedCommand(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      rejectPromise(error);
    });
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      rejectPromise(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function listeningProcessIds(port) {
  const output = await runBufferedCommand("netstat", ["-ano", "-p", "tcp"]);
  return parseWindowsListeningPids(output, port);
}

export function windowsProcessQuery(pid) {
  return [
    `$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';`,
    "if ($null -ne $process) {",
    "  [PSCustomObject]@{",
    "    commandLine = $process.CommandLine;",
    "    parentProcessId = $process.ParentProcessId;",
    "    processId = $process.ProcessId;",
    "  } | ConvertTo-Json -Compress",
    "}",
  ].join(" ");
}

async function windowsProcessInfo(pid) {
  const script = windowsProcessQuery(pid);
  const output = await runBufferedCommand("powershell.exe", ["-NoProfile", "-Command", script]);
  const trimmed = output.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export async function developmentProcessRoot(
  listenerPid,
  server,
  {
    getProcessInfo = windowsProcessInfo,
    root = projectRoot,
  } = {},
) {
  let currentPid = listenerPid;
  for (let depth = 0; depth < 8; depth += 1) {
    const process = await getProcessInfo(currentPid);
    if (!process) {
      return null;
    }
    if (isMeoingDevRunner(process.commandLine ?? "", server.label, root)) {
      return process.processId;
    }
    if (!Number.isInteger(process.parentProcessId) || process.parentProcessId <= 0) {
      return null;
    }
    currentPid = process.parentProcessId;
  }
  return null;
}

async function localServerResponse(server) {
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}${server.path}`, {
      signal: AbortSignal.timeout(1_000),
    });
    return { body: await response.text(), status: response.status };
  } catch {
    return null;
  }
}

async function waitForPortToClose(port) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if ((await listeningProcessIds(port)).length === 0) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`Port ${port} is still in use after stopping the previous Meoing development server.`);
}

export async function releaseExistingMeoingDevServers({ platform = process.platform } = {}) {
  if (platform !== "win32") {
    return;
  }

  for (const server of localDevServers) {
    const pids = await listeningProcessIds(server.port);
    if (pids.length === 0) {
      continue;
    }

    const response = await localServerResponse(server);
    if (!response) {
      try {
        await waitForPortToClose(server.port);
        continue;
      } catch {
        throw new Error(
          `Port ${server.port} is already in use by an unverified process. Stop that process manually before running npm run dev:local.`,
        );
      }
    }
    if (!isKnownLocalServerResponse(server.label, response.status, response.body)) {
      throw new Error(
        `Port ${server.port} is already in use by an unverified process. Stop that process manually before running npm run dev:local.`,
      );
    }

    const roots = await Promise.all(pids.map((pid) => developmentProcessRoot(pid, server)));
    if (roots.some((pid) => pid === null)) {
      try {
        await waitForPortToClose(server.port);
        continue;
      } catch {
        throw new Error(
          `Port ${server.port} responded as Meoing, but its process tree could not be verified for this repository. Stop that process manually before running npm run dev:local.`,
        );
      }
    }

    console.log(`Stopping existing local Meoing ${server.label} on port ${server.port}...`);
    await Promise.all(
      [...new Set(roots)].map(async (pid) => {
        try {
          await runBufferedCommand("taskkill", ["/pid", String(pid), "/t", "/f"]);
        } catch {
          // The process may have already stopped between detection and taskkill.
        }
      }),
    );
    await waitForPortToClose(server.port);
  }
}

function startDevProcess(label, args, environment) {
  const invocation = npmInvocation(args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: projectRoot,
    env: environment,
    shell: invocation.shell,
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

  await releaseExistingMeoingDevServers();

  console.log("Starting local Supabase (existing database data is preserved)...");
  await runCommand("Local Supabase", ["--prefix", "backend", "run", "db:start"]);

  console.log("Provisioning the local API database login...");
  await runCommand("Local API database login", [
    "--prefix",
    "backend",
    "run",
    "db:local:provision",
  ]);

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
