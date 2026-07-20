// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateProjectCreateButton,
  findComposerController,
  findCreateProjectNameInput,
  setNativeInputValue,
  setProseMirrorText,
  type ProseMirrorViewLike,
} from "./chatgpt-main";

beforeEach(() => {
  document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true"><p>Ask</p></div>';
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value() { return { width: 120, height: 40, top: 0, right: 120, bottom: 40, left: 0, x: 0, y: 0, toJSON() {} }; },
  });
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

  it("sets a controlled project-name input through native main-world events", () => {
    document.body.innerHTML = '<input type="text">';
    const input = document.querySelector<HTMLInputElement>("input")!;
    const events: string[] = [];
    input.addEventListener("input", () => events.push("input"));
    input.addEventListener("change", () => events.push("change"));

    expect(setNativeInputValue(input, "Meoing")).toBe(true);
    expect(input.value).toBe("Meoing");
    expect(events).toEqual(["input", "change"]);
  });

  it("finds the project-name field inside ChatGPT's native dialog", () => {
    document.body.innerHTML = `
      <dialog open style="display:block"><h2>Create project</h2><input type="text"></dialog>
      <dialog style="display:none"><h2>Create project</h2><input type="text"></dialog>
    `;
    expect(findCreateProjectNameInput()).toBe(document.querySelector("dialog[open] input"));
  });

  it("activates the project Create button once in the page world", () => {
    document.body.innerHTML = '<button type="button">Create project</button>';
    const button = document.querySelector<HTMLButtonElement>("button")!;
    const onClick = vi.fn();
    button.addEventListener("click", onClick);

    expect(activateProjectCreateButton(button)).toBe(true);
    expect(onClick).toHaveBeenCalledOnce();
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
