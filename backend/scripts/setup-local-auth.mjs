import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(backendRoot, "supabase", "signing_keys.json");

export function normalizePrivateEs256Key(signingKey) {
  if (
    !signingKey
    || signingKey.kty !== "EC"
    || signingKey.crv !== "P-256"
  ) {
    return signingKey;
  }

  return {
    ...signingKey,
    use: "sig",
    key_ops: ["sign", "verify"],
    alg: "ES256",
    ext: true,
  };
}

export function validPrivateEs256Key(signingKey) {
  return Boolean(
    signingKey
    && signingKey.kty === "EC"
    && signingKey.crv === "P-256"
    && signingKey.alg === "ES256"
    && signingKey.use === "sig"
    && signingKey.ext === true
    && Array.isArray(signingKey.key_ops)
    && signingKey.key_ops.includes("sign")
    && signingKey.key_ops.includes("verify")
    && typeof signingKey.kid === "string"
    && signingKey.kid.length > 0
    && typeof signingKey.d === "string"
    && signingKey.d.length > 0
    && typeof signingKey.x === "string"
    && signingKey.x.length > 0
    && typeof signingKey.y === "string"
    && signingKey.y.length > 0
  );
}

export function normalizePrivateEs256KeyDocument(parsed) {
  const keys = Array.isArray(parsed) ? parsed : [parsed];
  return keys.map(normalizePrivateEs256Key);
}

export async function setupLocalAuthKey() {
  if (existsSync(destination)) {
    const raw = await readFile(destination, "utf8");
    const parsed = JSON.parse(raw);
    const signingKeys = normalizePrivateEs256KeyDocument(parsed);
    if (signingKeys.length === 0 || signingKeys.some((key) => !validPrivateEs256Key(key))) {
      throw new Error("The existing local Supabase signing key is invalid.");
    }
    const normalized = `${JSON.stringify(signingKeys, null, 2)}\n`;
    if (raw !== normalized) {
      await writeFile(destination, normalized, {
        encoding: "utf8",
        mode: 0o600,
      });
      console.log("Normalized the existing local Supabase ES256 signing key.");
    } else {
      console.log("Local Supabase ES256 signing key already exists.");
    }
    return;
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
    // A configured signing_keys_path must already exist before this CLI command can run.
    // Generate the same private JWK shape locally on a clean checkout.
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    signingKey = {
      ...privateKey.export({ format: "jwk" }),
      kid: randomUUID(),
    };
    console.log("Supabase CLI key generation was unavailable; used Node.js P-256 generation.");
  }
  signingKey = normalizePrivateEs256Key(signingKey);
  if (!validPrivateEs256Key(signingKey)) {
    throw new Error("Supabase CLI did not return a complete ES256 private JWK.");
  }

  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify([signingKey], null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log("Generated ignored local Supabase ES256 signing key.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await setupLocalAuthKey();
}
