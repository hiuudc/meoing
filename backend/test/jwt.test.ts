import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { describe, expect, it } from "vitest";
import { verifySupabaseJwt } from "../src/auth/jwt";
import { ApiError } from "../src/http/errors";

const ISSUER = "https://test.supabase.co/auth/v1";
const AUDIENCE = "authenticated";
const USER_ID = "101ed68b-c50b-4b35-b44c-45a0ef227f6e";

async function signingContext(kid: string) {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  return {
    keyResolver: createLocalJWKSet({ keys: [{ ...publicJwk, alg: "ES256", kid, use: "sig" }] }),
    kid,
    privateKey,
  };
}

async function token(
  privateKey: CryptoKey,
  kid: string,
  expiresAt: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    email: "cat@example.com",
    session_id: "session-id",
  })
    .setProtectedHeader({ alg: "ES256", kid })
    .setSubject(USER_ID)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now - 5)
    .setExpirationTime(expiresAt)
    .sign(privateKey);
}

function request(jwt: string): Request {
  return new Request("https://api.meoing.test/v1/me", {
    headers: { authorization: `Bearer ${jwt}` },
  });
}

describe("Supabase JWT verification", () => {
  it("accepts a correctly signed, unexpired token with the configured issuer and audience", async () => {
    const context = await signingContext("valid-key");
    const jwt = await token(
      context.privateKey,
      context.kid,
      Math.floor(Date.now() / 1_000) + 60,
    );
    const actor = await verifySupabaseJwt(request(jwt), {
      audience: AUDIENCE,
      keyResolver: context.keyResolver,
      supabaseUrl: "https://test.supabase.co",
    });

    expect(actor).toMatchObject({
      email: "cat@example.com",
      sessionId: "session-id",
      userId: USER_ID,
    });
  });

  it("rejects expired and forged tokens", async () => {
    const trusted = await signingContext("trusted-key");
    const expired = await token(
      trusted.privateKey,
      trusted.kid,
      Math.floor(Date.now() / 1_000) - 1,
    );
    await expect(verifySupabaseJwt(request(expired), {
      audience: AUDIENCE,
      keyResolver: trusted.keyResolver,
      supabaseUrl: "https://test.supabase.co",
    })).rejects.toMatchObject({ code: "AUTH_REQUIRED", status: 401 } satisfies Partial<ApiError>);

    const attacker = await signingContext("attacker-key");
    const forged = await token(
      attacker.privateKey,
      attacker.kid,
      Math.floor(Date.now() / 1_000) + 60,
    );
    await expect(verifySupabaseJwt(request(forged), {
      audience: AUDIENCE,
      keyResolver: trusted.keyResolver,
      supabaseUrl: "https://test.supabase.co",
    })).rejects.toMatchObject({ code: "AUTH_REQUIRED", status: 401 } satisfies Partial<ApiError>);
  });
});
