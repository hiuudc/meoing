import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import test from "node:test";

import {
  normalizePrivateEs256Key,
  normalizePrivateEs256KeyDocument,
  validPrivateEs256Key,
} from "./setup-local-auth.mjs";

function metadataLessPrivateKey() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    ...privateKey.export({ format: "jwk" }),
    kid: randomUUID(),
  };
}

test("normalizes the Node.js fallback to Supabase's signing-key shape", () => {
  const original = metadataLessPrivateKey();
  assert.equal(validPrivateEs256Key(original), false);

  const normalized = normalizePrivateEs256Key(original);

  assert.equal(validPrivateEs256Key(normalized), true);
  assert.equal(normalized.kid, original.kid);
  assert.equal(normalized.d, original.d);
  assert.equal(normalized.use, "sig");
  assert.deepEqual(normalized.key_ops, ["sign", "verify"]);
  assert.equal(normalized.alg, "ES256");
  assert.equal(normalized.ext, true);
});

test("upgrades an existing metadata-less signing-key document", () => {
  const original = metadataLessPrivateKey();

  const normalized = normalizePrivateEs256KeyDocument([{
    ...original,
    alg: "ES256",
  }]);

  assert.equal(normalized.length, 1);
  assert.equal(validPrivateEs256Key(normalized[0]), true);
  assert.equal(normalized[0].kid, original.kid);
  assert.equal(normalized[0].x, original.x);
  assert.equal(normalized[0].y, original.y);
});
