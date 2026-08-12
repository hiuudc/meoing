import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "./client";
import { listUnitRevisions, restoreUnitRevision } from "./unitRevisions";

describe("unit revision API", () => {
  it("encodes cursor pagination", async () => {
    const get = vi.fn().mockResolvedValue({ data: { items: [], nextCursor: null } });
    await listUnitRevisions({ get } as unknown as ApiClient, "unit/id", "rev cursor");
    expect(get).toHaveBeenCalledWith(
      "/v1/units/unit%2Fid/revisions?limit=50&cursor=rev+cursor",
      undefined,
    );
  });

  it("restores through optimistic revision", async () => {
    const post = vi.fn().mockResolvedValue({ data: {} });
    await restoreUnitRevision({ post } as unknown as ApiClient, "unit/id", 7, 11);
    expect(post).toHaveBeenCalledWith(
      "/v1/units/unit%2Fid/revisions/7/restore",
      { expectedRevision: 11 },
    );
  });
});
