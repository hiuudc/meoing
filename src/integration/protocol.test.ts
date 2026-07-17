import { describe, expect, it } from "vitest";
import { buildOperationPrompt, buildResultRepairPrompt } from "./protocol";

describe("extension protocol v3 prompts", () => {
  it("requests a full browser-local result without MCP or persistence", () => {
    const prompt = buildOperationPrompt({
      operationId: "operation-1",
      kind: "coaching",
      input: { message: "Explain this mistake" },
    });
    expect(prompt).toContain('"protocolVersion":3');
    expect(prompt).toContain('"operationId":"operation-1"');
    expect(prompt).toContain('"coachingReply":"..."');
    expect(prompt).toContain("Do not invoke @Meoi, MCP");
    expect(prompt).toContain("Do not claim that anything was saved");
    expect(prompt).toContain('<meoi_input>{"message":"Explain this mistake"}</meoi_input>');
  });

  it("repairs the full JSON result without invoking storage tools", () => {
    const prompt = buildResultRepairPrompt("operation-1", "evaluate_answer", "INVALID_JSON");
    expect(prompt).toContain("Do not invoke @Meoi, MCP");
    expect(prompt).toContain("INVALID_JSON");
    expect(prompt).toContain("operation-1");
    expect(prompt).toContain("evaluate_answer");
  });
});
