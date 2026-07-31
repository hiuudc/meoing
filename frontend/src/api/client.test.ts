import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ApiClient", () => {
  it("adds the Supabase bearer token and idempotency key", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(
      JSON.stringify({ data: { id: "created" }, meta: { requestId: "request-1" } }),
      { status: 201, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("https://api.example.test", async () => "jwt-token");

    const response = await client.post<{ id: string }>("/v1/collections", { name: "Japanese" }, "operation-1");

    expect(response.data.id).toBe("created");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/v1/collections",
      expect.objectContaining({ method: "POST", body: '{"name":"Japanese"}' }),
    );
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer jwt-token");
    expect(headers.get("idempotency-key")).toBe("operation-1");
  });

  it("throws the API error envelope without exposing the token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: "REVISION_CONFLICT",
        message: "The unit changed.",
        requestId: "request-2",
      },
    }), { status: 409, headers: { "content-type": "application/json" } })));
    const client = new ApiClient("https://api.example.test", async () => "secret-token");

    await expect(client.patch("/v1/units/unit-1", { expectedRevision: 1 }))
      .rejects.toMatchObject({
        status: 409,
        code: "REVISION_CONFLICT",
        requestId: "request-2",
      });
  });

  it("turns a detached or unreachable API domain into the static budget-safe message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    const client = new ApiClient("https://api.example.test", async () => "jwt-token");

    await expect(client.get("/v1/me")).rejects.toMatchObject({
      status: 503,
      code: "API_UNAVAILABLE",
    } satisfies Partial<ApiError>);
  });
});
