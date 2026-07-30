import { ApiError } from "../http/errors";

interface TurnstileResponse {
  readonly success: boolean;
}

function isTurnstileResponse(value: unknown): value is TurnstileResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    typeof value.success === "boolean"
  );
}

export async function verifyTurnstile(
  token: string,
  remoteIp: string | null,
  secret: string,
): Promise<void> {
  if (!token || token.length > 2_048) {
    throw new ApiError(403, "FORBIDDEN", "A valid abuse-prevention challenge is required");
  }

  const form = new URLSearchParams({
    response: token,
    secret,
  });
  if (remoteIp) {
    form.set("remoteip", remoteIp);
  }

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const length = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
  if (!response.ok || length > 64 * 1024) {
    throw new ApiError(503, "INTERNAL_ERROR", "Challenge verification is unavailable");
  }
  const result: unknown = await response.json();
  if (!isTurnstileResponse(result) || !result.success) {
    throw new ApiError(403, "FORBIDDEN", "The abuse-prevention challenge was rejected");
  }
}
