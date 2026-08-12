import { describe, expect, it, vi } from "vitest";
import type { MaintenanceRepository } from "../src/db/maintenance-repository";
import { runMaintenance } from "../src/maintenance";
import type { JsonObject } from "../src/types";

function maintenanceEnv(
  deleteObjects: (keys: string[]) => Promise<void>,
): MaintenanceEnv {
  return {
    APP_ENV: "test",
    FILES: { delete: deleteObjects },
    SUPABASE_SECRET_KEY: "sb_secret_test",
    SUPABASE_URL: "https://test.supabase.co",
  } as unknown as MaintenanceEnv;
}

describe("two-phase maintenance", () => {
  it("cleans expired idempotent AI operation results without reading their content", async () => {
    const cleanupAiOperations = vi.fn(async () => ({ expiredAiOperations: 3 }));
    const repository: MaintenanceRepository = {
      cleanup: async () => ({ r2Keys: [], dueCollectionIds: [], dueAssetIds: [], authUserIds: [] }),
      cleanupAiOperations,
      finalize: async () => ({}),
    };

    const result = await runMaintenance(
      maintenanceEnv(async () => undefined),
      repository,
      async () => new Response(null, { status: 204 }),
    );

    expect(cleanupAiOperations).toHaveBeenCalledWith({ batchSize: 500 });
    expect(result.aiOperationCleanup).toEqual({ expiredAiOperations: 3 });
  });

  it("emits sampled stats and lock indicators without logging row contents", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const repository: MaintenanceRepository = {
      cleanup: async () => ({
        r2Keys: [],
        dueCollectionIds: [],
        dueAssetIds: [],
        authUserIds: [],
      }),
      finalize: async () => ({}),
      observe: async () => ({
        statsSamplePercent: 5,
        sampledGlobalStatsRows: 25,
        sampledCollectionStatsRows: 30,
        globalStatsP95Bytes: 12_000,
        collectionStatsP95Bytes: 18_000,
        maxSampledStatsRowBytes: 24_000,
        sampledStatsRowsOver256KiB: 0,
        waitingLockCount: 2,
        oldestWaitingQueryAgeMs: 750,
        apiConnectionCount: 8,
        maintenanceConnectionCount: 1,
      }),
    };

    const result = await runMaintenance(
      maintenanceEnv(async () => undefined),
      repository,
      async () => new Response(null, { status: 204 }),
    );

    const entries = consoleLog.mock.calls
      .map(([entry]) => entry as Record<string, unknown>);
    expect(entries).toContainEqual(expect.objectContaining({
      event: "maintenance_observation",
      globalStatsP95Bytes: 12_000,
      waitingLockCount: 2,
      apiConnectionCount: 8,
    }));
    expect(JSON.stringify(entries)).not.toContain("answer");
    expect(result.observation).toMatchObject({ maxSampledStatsRowBytes: 24_000 });
    consoleLog.mockRestore();
  });

  it("deletes R2 and Auth users before finalizing DB tombstones", async () => {
    const events: string[] = [];
    const finalize = vi.fn(async (_input: JsonObject) => {
      events.push("finalize");
      return {
        authUserIds: ["101ed68b-c50b-4b35-b44c-45a0ef227f6e"],
        deletedCollections: 1,
        purgedAssets: 1,
      };
    });
    const repository: MaintenanceRepository = {
      cleanup: async () => {
        events.push("cleanup");
        return {
          r2Keys: ["collections/one/asset"],
          dueCollectionIds: ["25112aab-e87b-4cb6-8bd2-74ee8274fb83"],
          dueAssetIds: ["1b26fe98-1f4d-4306-a620-454059304cf5"],
          authUserIds: ["101ed68b-c50b-4b35-b44c-45a0ef227f6e"],
        };
      },
      finalize,
    };
    const fetcher = vi.fn(async (
      input: RequestInfo | URL,
      _init?: RequestInit,
    ) => {
      events.push(String(input).includes("?page=1") ? "auth-canary" : "auth-delete");
      return new Response(null, { status: 204 });
    });
    const env = maintenanceEnv(async () => {
      events.push("r2");
    });

    await runMaintenance(env, repository, fetcher);

    expect(events).toEqual(["auth-canary", "cleanup", "r2", "auth-delete", "finalize"]);
    const authRequestHeaders = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
    expect(authRequestHeaders.get("apikey")).toBe("sb_secret_test");
    expect(authRequestHeaders.has("authorization")).toBe(false);
    expect(finalize).toHaveBeenCalledWith({
      collectionIds: ["25112aab-e87b-4cb6-8bd2-74ee8274fb83"],
      assetIds: ["1b26fe98-1f4d-4306-a620-454059304cf5"],
      authUserIds: ["101ed68b-c50b-4b35-b44c-45a0ef227f6e"],
    });
  });

  it("treats an Auth user that is already absent as successfully deleted", async () => {
    const finalize = vi.fn(async () => ({
      authUserIds: ["101ed68b-c50b-4b35-b44c-45a0ef227f6e"],
    }));
    const repository: MaintenanceRepository = {
      cleanup: async () => ({
        r2Keys: [],
        dueCollectionIds: [],
        dueAssetIds: [],
        authUserIds: ["101ed68b-c50b-4b35-b44c-45a0ef227f6e"],
      }),
      finalize,
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    await runMaintenance(maintenanceEnv(async () => undefined), repository, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toContain(
      "/auth/v1/admin/users/101ed68b-c50b-4b35-b44c-45a0ef227f6e",
    );
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("does not finalize or delete Auth users when R2 deletion fails", async () => {
    const finalize = vi.fn(async () => ({}));
    const repository: MaintenanceRepository = {
      cleanup: async () => ({
        r2Keys: ["collections/one/asset"],
        dueCollectionIds: ["25112aab-e87b-4cb6-8bd2-74ee8274fb83"],
        dueAssetIds: [],
        authUserIds: ["101ed68b-c50b-4b35-b44c-45a0ef227f6e"],
      }),
      finalize,
    };
    const fetcher = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => new Response(null, { status: 204 }));
    const env = maintenanceEnv(async () => {
      throw new Error("R2 unavailable");
    });

    await expect(runMaintenance(env, repository, fetcher)).rejects.toThrow("R2 unavailable");
    expect(finalize).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toContain(
      "/auth/v1/admin/users?page=1&per_page=1",
    );
  });

  it("keeps staged candidates eligible when Auth deletion fails and retries next run", async () => {
    const userId = "101ed68b-c50b-4b35-b44c-45a0ef227f6e";
    const collectionId = "25112aab-e87b-4cb6-8bd2-74ee8274fb83";
    const assetId = "1b26fe98-1f4d-4306-a620-454059304cf5";
    const cleanup = vi.fn(async () => ({
      r2Keys: ["collections/one/asset"],
      dueCollectionIds: [collectionId],
      dueAssetIds: [assetId],
      authUserIds: [userId],
    }));
    const finalize = vi.fn(async () => ({
      authUserIds: [userId],
      deletedCollections: 1,
      purgedAssets: 1,
    }));
    const repository: MaintenanceRepository = { cleanup, finalize };
    const deleteObjects = vi.fn(async () => undefined);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const env = maintenanceEnv(deleteObjects);

    await expect(runMaintenance(env, repository, fetcher)).rejects.toThrow(
      "One or more Supabase Auth deletions failed",
    );
    expect(finalize).not.toHaveBeenCalled();

    await expect(runMaintenance(env, repository, fetcher)).resolves.toMatchObject({
      authUserIds: [userId],
    });

    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(deleteObjects).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith({
      collectionIds: [collectionId],
      assetIds: [assetId],
      authUserIds: [userId],
    });
  });

  it("fails closed before cleanup when the hosted Auth Admin secret is invalid", async () => {
    const cleanup = vi.fn(async () => ({}));
    const repository: MaintenanceRepository = {
      cleanup,
      finalize: async () => ({}),
    };
    const env = maintenanceEnv(async () => undefined);
    env.APP_ENV = "staging";
    env.SUPABASE_SECRET_KEY = "legacy-service-role-key";
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));

    await expect(runMaintenance(env, repository, fetcher)).rejects.toThrow(
      "Supabase Auth Admin secret is not a dedicated secret key",
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("fails closed before cleanup when the Auth Admin canary is rejected", async () => {
    const cleanup = vi.fn(async () => ({}));
    const repository: MaintenanceRepository = {
      cleanup,
      finalize: async () => ({}),
    };
    const fetcher = vi.fn(async () => new Response(null, { status: 401 }));

    await expect(
      runMaintenance(maintenanceEnv(async () => undefined), repository, fetcher),
    ).rejects.toThrow("Supabase Auth Admin canary failed");
    expect(cleanup).not.toHaveBeenCalled();
  });
});
