// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  CHAT_RESULT_MAX_BYTES,
  assistantTurnText,
  findAssistantTurns,
  findComposer,
  findSendButton,
  parseChatOperationResult,
  quotaReached,
  responseGenerationActive,
} from "./chatgpt-adapter";

beforeEach(() => {
  document.body.innerHTML = "";
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value() { return { width: 120, height: 40, top: 0, right: 120, bottom: 40, left: 0, x: 0, y: 0, toJSON() {} }; },
  });
});

describe("ChatGPT selector adapter", () => {
  it("prefers data-testid and refuses an ambiguous fallback", () => {
    document.body.innerHTML = '<form><div contenteditable="true"></div><textarea data-testid="prompt-textarea"></textarea></form>';
    expect(findComposer()).toBe(document.querySelector("textarea"));
    document.body.innerHTML = '<form><div contenteditable="true"></div><textarea></textarea></form>';
    expect(findComposer()).toBeNull();
  });

  it("uses accessible composer and enabled Send prompt control", () => {
    document.body.innerHTML = '<form><div id="composer" role="textbox" contenteditable="true" aria-label="Message ChatGPT"></div><button aria-label="Send prompt">Send</button></form>';
    const composer = findComposer();
    expect(composer?.id).toBe("composer");
    expect(findSendButton(composer!)).toBe(document.querySelector("button"));
    document.querySelector("button")!.setAttribute("aria-disabled", "true");
    expect(findSendButton(composer!)).toBeNull();
  });

  it("detects quota only from error controls, not conversation content", () => {
    document.body.innerHTML = '<article class="assistant-message">You reached the quota in this example sentence.</article>';
    expect(quotaReached()).toBe(false);
    document.body.insertAdjacentHTML("beforeend", '<div role="alert">You have reached your Free plan limit. Try again later.</div>');
    expect(quotaReached()).toBe(true);
  });

  it("finds only explicitly marked assistant turns and ignores history-like user content", () => {
    document.body.innerHTML = `
      <article data-message-author-role="user">old user text</article>
      <article data-message-author-role="assistant" id="old">old assistant</article>
      <article data-message-author-role="assistant" id="new"><pre><code>{"ok":true}</code></pre></article>
    `;
    const turns = findAssistantTurns();
    expect(turns.map((turn) => turn.id)).toEqual(["old", "new"]);
    expect(assistantTurnText(turns[1])).toContain('{"ok":true}');
  });

  it("uses an explicit conversation-turn fallback and detects active generation", () => {
    document.body.innerHTML = `
      <article data-testid="conversation-turn-4" data-turn="assistant">result</article>
      <button data-testid="stop-button">Stop</button>
    `;
    expect(findAssistantTurns()).toHaveLength(1);
    expect(responseGenerationActive()).toBe(true);
    document.querySelector("button")!.setAttribute("style", "display:none");
    expect(responseGenerationActive()).toBe(false);
  });

  it("parses an exact raw or single fenced direct result", () => {
    const raw = '{"type":"meoi.operation.result","protocolVersion":3,"operationId":"op-1","kind":"coaching","outcome":"completed","result":{"coachingReply":"Try again."}}';
    expect(parseChatOperationResult(raw, "op-1", "coaching")).toEqual({
      ok: true,
      result: {
        type: "meoi.operation.result",
        protocolVersion: 3,
        operationId: "op-1",
        kind: "coaching",
        outcome: "completed",
        result: { coachingReply: "Try again." },
      },
    });
    expect(parseChatOperationResult(`Done\n\`\`\`json\n${raw}\n\`\`\``, "op-1", "coaching").ok).toBe(true);
    document.body.innerHTML = `<div data-message-author-role="assistant"><pre><code>${raw}</code></pre></div>`;
    expect(parseChatOperationResult(assistantTurnText(findAssistantTurns()[0]), "op-1", "coaching").ok).toBe(true);
  });

  it("accepts needs_source and structured failure outcomes", () => {
    const needsSource = '{"type":"meoi.operation.result","protocolVersion":3,"operationId":"op-1","kind":"create_lesson","outcome":"needs_source","result":{"sourceRequest":"Paste a transcript."}}';
    const failed = '{"type":"meoi.operation.result","protocolVersion":3,"operationId":"op-2","kind":"evaluate_answer","outcome":"failed","error":{"code":"NO_ANSWER","message":"No answer was supplied."}}';
    expect(parseChatOperationResult(needsSource, "op-1", "create_lesson").ok).toBe(true);
    expect(parseChatOperationResult(failed, "op-2", "evaluate_answer").ok).toBe(true);
  });

  it("rejects wrong IDs/kinds, extra fields, multiple blocks, and oversized responses", () => {
    const wrong = '{"type":"meoi.operation.result","protocolVersion":3,"operationId":"op-2","kind":"coaching","outcome":"completed","result":{"coachingReply":"ok"}}';
    expect(parseChatOperationResult(wrong, "op-1", "coaching")).toEqual({ ok: false, code: "WRONG_OPERATION_ID" });
    expect(parseChatOperationResult(wrong, "op-2", "create_lesson")).toEqual({ ok: false, code: "WRONG_OPERATION_KIND" });
    expect(parseChatOperationResult('{"type":"meoi.operation.result","protocolVersion":3,"operationId":"op-1","kind":"coaching","outcome":"completed","result":{"coachingReply":"ok"},"extra":true}', "op-1", "coaching"))
      .toEqual({ ok: false, code: "INVALID_RESULT_SCHEMA" });
    expect(parseChatOperationResult('```json\n{}\n```\n```json\n{}\n```', "op-1", "coaching"))
      .toEqual({ ok: false, code: "AMBIGUOUS_JSON_BLOCK" });
    expect(parseChatOperationResult("x".repeat(CHAT_RESULT_MAX_BYTES + 1), "op-1", "coaching"))
      .toEqual({ ok: false, code: "RESPONSE_TOO_LARGE" });
  });
});
