// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findComposerController, setProseMirrorText, type ProseMirrorViewLike } from "./chatgpt-main";

beforeEach(() => {
  document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true"><p>Ask</p></div>';
});

describe("ChatGPT main-world composer bridge", () => {
  it("finds a ProseMirror view through a descendant view description", () => {
    const composer = document.querySelector<HTMLElement>("#prompt-textarea")!;
    const paragraph = composer.querySelector<HTMLElement>("p")!;
    const view = createView();
    Object.defineProperty(paragraph, "pmViewDesc", {
      configurable: true,
      value: { parent: { parent: null, view } },
    });
    expect(findComposerController(composer)).toBe(view);
  });

  it("replaces the full ProseMirror document with safe paragraphs", () => {
    const view = createView();
    expect(setProseMirrorText(view, "Task\n\nおはよう")).toBe(true);
    expect(view.state.tr.replaceWith).toHaveBeenCalledWith(0, 2, [
      { text: "Task" },
      { text: undefined },
      { text: "おはよう" },
    ]);
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    expect(view.focus).toHaveBeenCalledTimes(1);
  });
});

function createView(): ProseMirrorViewLike {
  const transaction = {
    replaceWith: vi.fn(function replaceWith() { return transaction; }),
    scrollIntoView: vi.fn(function scrollIntoView() { return transaction; }),
  };
  return {
    state: {
      doc: { content: { size: 2 } },
      schema: {
        nodes: {
          paragraph: {
            create: vi.fn((_attributes, content) => ({ text: content && (content as { text: string }).text })),
          },
        },
        text: vi.fn((text) => ({ text })),
      },
      tr: transaction,
    },
    dispatch: vi.fn(),
    focus: vi.fn(),
  };
}
