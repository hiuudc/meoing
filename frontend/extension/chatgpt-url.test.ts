import { describe, expect, it } from "vitest";
import {
  canonicalConversationUrl,
  chatgptConversationLocation,
  conversationIdFromUrl,
  isChatUrl,
  isConversationUrl,
  isProjectHomeUrl,
  sameConversation,
} from "./chatgpt-url";

describe("ChatGPT conversation URLs", () => {
  it("normalizes direct and project conversation URLs", () => {
    expect(canonicalConversationUrl("https://chatgpt.com/c/chat-1?model=auto#latest"))
      .toBe("https://chatgpt.com/c/chat-1");
    expect(canonicalConversationUrl("https://chatgpt.com/g/g-p-project-1/c/chat-1?model=auto"))
      .toBe("https://chatgpt.com/g/g-p-project-1/c/chat-1");
  });

  it("extracts one stable conversation ID across project moves", () => {
    const direct = "https://chatgpt.com/c/chat-1";
    const project = "https://chatgpt.com/g/g-p-project-1/c/chat-1";
    expect(conversationIdFromUrl(direct)).toBe("chat-1");
    expect(chatgptConversationLocation(project)).toEqual({ projectId: "g-p-project-1", conversationId: "chat-1" });
    expect(sameConversation(direct, project)).toBe(true);
    expect(sameConversation(direct, "https://chatgpt.com/c/chat-2")).toBe(false);
  });

  it("accepts only supported ChatGPT chat pages", () => {
    expect(isChatUrl("https://chatgpt.com/")).toBe(true);
    expect(isConversationUrl("https://chatgpt.com/g/g-p-project-1/c/chat-1")).toBe(true);
    expect(isProjectHomeUrl("https://chatgpt.com/g/g-p-project-1-meoing/project")).toBe(true);
    expect(isChatUrl("https://chatgpt.com/g/g-p-project-1/project")).toBe(false);
    expect(isProjectHomeUrl("https://chatgpt.com/g/g-p-project-1/c/chat-1")).toBe(false);
    expect(canonicalConversationUrl("https://example.com/c/chat-1")).toBeNull();
    expect(canonicalConversationUrl("not a url")).toBeNull();
  });
});
