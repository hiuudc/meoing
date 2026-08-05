import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  npmExecutable,
  parseNodeMajor,
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
  assert.equal(parseNodeMajor("22.15.1"), 22);
});
