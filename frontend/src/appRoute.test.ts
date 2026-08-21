import { describe, expect, it } from "vitest";
import { isWorkspaceRoute } from "./appRoute";

describe("isWorkspaceRoute", () => {
  it("keeps authenticated workspace and callback URLs behind AuthGate", () => {
    expect(isWorkspaceRoute("/app")).toBe(true);
    expect(isWorkspaceRoute("/app/library")).toBe(true);
    expect(isWorkspaceRoute("/auth/callback")).toBe(true);
  });

  it("leaves the public landing page and legal pages outside AuthGate", () => {
    expect(isWorkspaceRoute("/")).toBe(false);
    expect(isWorkspaceRoute("/privacy.html")).toBe(false);
  });
});
