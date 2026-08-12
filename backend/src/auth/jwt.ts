import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import { ApiError } from "../http/errors";
import type { Actor } from "../types";

export interface JwtConfiguration {
  readonly supabaseUrl: string;
  readonly audience: string;
  readonly keyResolver?: JWTVerifyGetKey;
}

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

function remoteKeySet(issuer: string): JWTVerifyGetKey {
  const existing = remoteKeySets.get(issuer);
  if (existing) {
    return existing;
  }
  const created = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
    cooldownDuration: 30_000,
    timeoutDuration: 3_000,
  });
  remoteKeySets.set(issuer, created);
  return created;
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new ApiError(401, "AUTH_REQUIRED", "A bearer access token is required");
  }

  const token = authorization.slice("Bearer ".length).trim();
  if (!token || token.length > 16_384) {
    throw new ApiError(401, "AUTH_REQUIRED", "The bearer access token is invalid");
  }
  return token;
}

function stringClaim(payload: JWTPayload, name: string): string | null {
  const value = payload[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function verifySupabaseJwt(
  request: Request,
  configuration: JwtConfiguration,
): Promise<Actor> {
  const token = bearerToken(request);
  const issuer = `${configuration.supabaseUrl.replace(/\/+$/, "")}/auth/v1`;
  const jwks = configuration.keyResolver ?? remoteKeySet(issuer);

  try {
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ["ES256", "RS256"],
      audience: configuration.audience,
      issuer,
      requiredClaims: ["sub", "exp", "iat"],
    });

    if (!payload.sub) {
      throw new ApiError(401, "AUTH_REQUIRED", "The bearer access token has no subject");
    }

    return {
      userId: payload.sub,
      email: stringClaim(payload, "email"),
      tokenId: payload.jti ?? null,
      sessionId: stringClaim(payload, "session_id"),
    };
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(401, "AUTH_REQUIRED", "The bearer access token is invalid or expired");
  }
}
