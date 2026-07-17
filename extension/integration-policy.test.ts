import { describe, expect, it } from "vitest";
import { isAllowedMeoiOrigin } from "./integration-policy";

describe("extension integration policy", () => {
  it("accepts only the two local Meoi ports", () => {
    expect(isAllowedMeoiOrigin("http://127.0.0.1:5173")).toBe(true);
    expect(isAllowedMeoiOrigin("http://127.0.0.1:4173")).toBe(true);
    expect(isAllowedMeoiOrigin("http://localhost:5173")).toBe(false);
    expect(isAllowedMeoiOrigin("http://127.0.0.1:9999")).toBe(false);
    expect(isAllowedMeoiOrigin("https://example.com")).toBe(false);
  });
});
