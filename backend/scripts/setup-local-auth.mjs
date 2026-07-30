import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(backendRoot, "supabase", "signing_keys.json");

function validPrivateEs256Key(signingKey) {
  return Boolean(
    signingKey
    && signingKey.kty === "EC"
    && signingKey.crv === "P-256"
    && signingKey.alg === "ES256"
    && typeof signingKey.kid === "string"
    && typeof signingKey.d === "string"
    && typeof signingKey.x === "string"
    && typeof signingKey.y === "string"
  );
}

if (existsSync(destination)) {
  const parsed = JSON.parse(await readFile(destination, "utf8"));
  const existingKey = Array.isArray(parsed) ? parsed[0] : parsed;
  const signingKey = existingKey?.kty === "EC"
    ? { ...existingKey, alg: "ES256" }
    : existingKey;
  if (!validPrivateEs256Key(signingKey)) {
    throw new Error("The existing local Supabase signing key is invalid.");
  }
  if (!Array.isArray(parsed) || existingKey?.alg !== "ES256") {
    await writeFile(destination, `${JSON.stringify([signingKey], null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  console.log("Local Supabase ES256 signing key already exists.");
  process.exit(0);
}

const executable = resolve(
  backendRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "supabase.cmd" : "supabase",
);
const generated = spawnSync(
  executable,
  [
    "gen",
    "signing-key",
    "--algorithm",
    "ES256",
    "--output-format",
    "json",
    "--log-level",
    "error",
  ],
  {
    cwd: backendRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  },
);

let signingKey;
if (generated.status === 0) {
  try {
    const parsed = JSON.parse(generated.stdout);
    signingKey = Array.isArray(parsed)
      ? parsed[0]
      : Array.isArray(parsed?.keys)
        ? parsed.keys[0]
        : parsed;
  } catch {
    signingKey = undefined;
  }
}
if (!signingKey) {
  // `gen signing-key` is offline, but some CLI builds still require a configured global
  // profile. Generate the same standards-compliant private JWK locally in that case.
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  signingKey = {
    ...privateKey.export({ format: "jwk" }),
    alg: "ES256",
    kid: randomUUID(),
  };
  console.log("Supabase CLI key generation was unavailable; used Node.js P-256 generation.");
}
if (signingKey?.kty === "EC" && signingKey.alg !== "ES256") {
  signingKey = { ...signingKey, alg: "ES256" };
}
if (!validPrivateEs256Key(signingKey)) {
  throw new Error("Supabase CLI did not return a complete ES256 private JWK.");
}

await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify([signingKey], null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
console.log("Generated ignored local Supabase ES256 signing key.");
