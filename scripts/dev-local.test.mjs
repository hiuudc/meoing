import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  developmentProcessRoot,
  isKnownLocalServerResponse,
  npmExecutable,
  npmInvocation,
  parseNodeMajor,
  parseWindowsListeningPids,
  isMeoingDevRunner,
  validatePreflight,
  workerEnvironment,
} from "./dev-local.mjs";

test("requires Node 22 or newer", () => {
  const failures = validatePreflight({ root: tmpdir(), nodeVersion: "20.19.0" });

  assert.match(failures[0], /Node\.js 22 or newer/);
});

test("reports every missing local configuration file", () => {
  const failures = validatePreflight({ root: tmpdir(), nodeVersion: "22.0.0" });

  assert.deepEqual(failures, [
    "Missing frontend/.env.local.",
    "Missing backend/.dev.vars.",
  ]);
});

test("accepts configured local files", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "meoing-dev-local-"));
  await mkdir(resolve(root, "frontend"), { recursive: true });
  await mkdir(resolve(root, "backend"), { recursive: true });
  await writeFile(resolve(root, "frontend", ".env.local"), "VITE_MEOI_API_URL=http://127.0.0.1:5173/__meoing_api\n");
  await writeFile(resolve(root, "backend", ".dev.vars"), "INVITE_TOKEN_SECRET=test\n");

  try {
    assert.deepEqual(validatePreflight({ root, nodeVersion: "22.0.0" }), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("keeps an explicit Hyperdrive connection and supplies a local default", () => {
  const supplied = workerEnvironment({
    CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: "postgresql://custom",
  });
  const defaulted = workerEnvironment({});

  assert.equal(supplied.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE, "postgresql://custom");
  assert.equal(
    defaulted.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE,
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  );
});

test("uses the platform appropriate npm executable", () => {
  assert.equal(npmExecutable("win32"), "npm.cmd");
  assert.equal(npmExecutable("linux"), "npm");
  assert.deepEqual(npmInvocation(["--version"], "win32"), {
    args: [],
    command: "npm.cmd --version",
    shell: true,
  });
  assert.deepEqual(npmInvocation(["--version"], "linux"), {
    args: ["--version"],
    command: "npm",
    shell: false,
  });
  assert.equal(parseNodeMajor("22.15.1"), 22);
});

test("finds each listening PID on a Windows development port once", () => {
  const output = [
    "  TCP    127.0.0.1:5173       0.0.0.0:0              LISTENING       13216",
    "  TCP    [::1]:5173           [::]:0                 LISTENING       13216",
    "  TCP    127.0.0.1:8787       0.0.0.0:0              LISTENING       23064",
    "  TCP    127.0.0.1:5173       127.0.0.1:51011        ESTABLISHED     13216",
  ].join("\r\n");

  assert.deepEqual(parseWindowsListeningPids(output, 5173), [13216]);
  assert.deepEqual(parseWindowsListeningPids(output, 8787), [23064]);
});

test("only recognises Meoing Vite and Wrangler development runners", () => {
  const root = "C:\\workspace\\meoing";

  assert.equal(
    isMeoingDevRunner(
      '"node" "C:\\workspace\\meoing\\frontend\\node_modules\\vite\\bin\\vite.js" --host 127.0.0.1',
      "Frontend",
      root,
    ),
    true,
  );
  assert.equal(
    isMeoingDevRunner(
      '"node" "C:\\workspace\\meoing\\backend\\node_modules\\wrangler\\bin\\wrangler.js" dev --config wrangler.api.jsonc',
      "API Worker",
      root,
    ),
    true,
  );
  assert.equal(
    isMeoingDevRunner('"node" "C:\\other-app\\vite.js" --host 127.0.0.1', "Frontend", root), false);
});

test("recognises the actual Meoing frontend title without accepting mojibake", () => {
  const title = "<title>Meoi \u00b7 Language Workspace</title>";

  assert.equal(isKnownLocalServerResponse("Frontend", 200, `<!doctype html>${title}`), true);
  assert.equal(isKnownLocalServerResponse("Frontend", 200, "<title>Meoi Â· Language Workspace</title>"), false);
});

test("requires a verified repository runner before stopping a listening process", async () => {
  const root = "C:\\workspace\\meoing";
  const unavailableProcessInfo = async () => null;
  const unrelatedProcessInfo = async () => ({
    commandLine: '"node" "C:\\other-app\\node_modules\\vite\\bin\\vite.js" --host 127.0.0.1',
    parentProcessId: 0,
    processId: 1234,
  });
  const verifiedProcessInfo = async () => ({
    commandLine: '"node" "C:\\workspace\\meoing\\frontend\\node_modules\\vite\\bin\\vite.js" --host 127.0.0.1',
    parentProcessId: 0,
    processId: 5678,
  });

  assert.equal(
    await developmentProcessRoot(1234, { label: "Frontend" }, { getProcessInfo: unavailableProcessInfo, root }),
    null,
  );
  assert.equal(
    await developmentProcessRoot(1234, { label: "Frontend" }, { getProcessInfo: unrelatedProcessInfo, root }),
    null,
  );
  assert.equal(
    await developmentProcessRoot(5678, { label: "Frontend" }, { getProcessInfo: verifiedProcessInfo, root }),
    5678,
  );
});
