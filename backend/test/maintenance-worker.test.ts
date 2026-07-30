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
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    SUPABASE_URL: "https://test.supabase.co",
  } as unknown as MaintenanceEnv;
}

describe("two-phase maintenance", () => {
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
      .map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>);
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
    const fetcher = vi.fn(async () => {
      events.push("auth");
      return new Response(null, { status: 204 });
    });
    const env = maintenanceEnv(async () => {
      events.push("r2");
    });

    await runMaintenance(env, repository, fetcher);

    expect(events).toEqual(["cleanup", "r2", "auth", "finalize"]);
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
    const fetcher = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => new Response(null, { status: 404 }));

    await runMaintenance(maintenanceEnv(async () => undefined), repository, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toContain(
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
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const env = maintenanceEnv(async () => {
      throw new Error("R2 unavailable");
    });

    await expect(runMaintenance(env, repository, fetcher)).rejects.toThrow("R2 unavailable");
    expect(finalize).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
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
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
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
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith({
      collectionIds: [collectionId],
      assetIds: [assetId],
      authUserIds: [userId],
    });
  });
});
