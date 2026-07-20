// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHATGPT_PROJECT_PLACEMENT_TIMEOUT_MS,
  MEOI_CHATGPT_PROJECT_NAME,
  currentChatProjectName,
  exactMenuItems,
  findConversationOptionsButton,
  findProjectConversationLink,
  placeCurrentConversationInProject,
  type ProjectPlacementEnvironment,
} from "./chatgpt-project";

let currentUrl = "https://chatgpt.com/c/chat-1";

function environment(): ProjectPlacementEnvironment {
  return {
    root: document,
    currentUrl: () => currentUrl,
    now: () => Date.now(),
    wait: async () => {},
  };
}

function projectBanner(name: string, projectId = "g-p-meoing"): string {
  return `<header role="banner"><a href="/g/${projectId}-${name.toLowerCase()}/project">${name}</a><button aria-label="Open conversation options"></button></header>`;
}

function installVisibleLayout(): void {
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value() { return { width: 120, height: 40, top: 0, right: 120, bottom: 40, left: 0, x: 0, y: 0, toJSON() {} }; },
  });
}

function installMoveMenu(targetExists: boolean, onChoice?: () => void): void {
  const options = document.querySelector<HTMLButtonElement>('[aria-label="Open conversation options"]')!;
  options.addEventListener("click", () => {
    document.body.insertAdjacentHTML("beforeend", '<div role="menu"><div role="menuitem" id="move">Move to project</div></div>');
    document.querySelector<HTMLElement>("#move")!.addEventListener("click", () => {
      const choice = targetExists
        ? `<div role="menuitem" id="target">${MEOI_CHATGPT_PROJECT_NAME}</div>`
        : '<div role="menuitem" id="new-project">New project</div>';
      document.body.insertAdjacentHTML("beforeend", `<div role="menu">${choice}</div>`);
      document.querySelector<HTMLElement>(targetExists ? "#target" : "#new-project")!
        .addEventListener("click", () => onChoice?.(), { once: true });
    }, { once: true });
  }, { once: true });
}

beforeEach(() => {
  document.body.innerHTML = projectBanner("Other");
  currentUrl = "https://chatgpt.com/c/chat-1";
  installVisibleLayout();
});

describe("ChatGPT project placement", () => {
  it("allows enough time for ChatGPT's menu and project-creation transitions", () => {
    expect(CHATGPT_PROJECT_PLACEMENT_TIMEOUT_MS).toBe(30_000);
  });

  it("detects exact project markers and rejects ambiguous menu choices", () => {
    expect(currentChatProjectName()).toBe("Other");
    expect(findConversationOptionsButton()).toBe(document.querySelector("button"));
    document.body.insertAdjacentHTML("beforeend", `<div role="menu"><div role="menuitem">${MEOI_CHATGPT_PROJECT_NAME}</div><div role="menuitem">${MEOI_CHATGPT_PROJECT_NAME}</div></div>`);
    expect(exactMenuItems(MEOI_CHATGPT_PROJECT_NAME)).toHaveLength(2);
  });

  it("does nothing when the conversation is already in Meoing", async () => {
    document.body.innerHTML = projectBanner(MEOI_CHATGPT_PROJECT_NAME);
    currentUrl = "https://chatgpt.com/g/g-p-meoing/c/chat-1";
    await expect(placeCurrentConversationInProject(MEOI_CHATGPT_PROJECT_NAME, Date.now() + 1_000, environment()))
      .resolves.toEqual({ created: false });
  });

  it("moves an existing conversation into the exact project", async () => {
    installMoveMenu(true, () => {
      document.querySelector("header")!.outerHTML = projectBanner(MEOI_CHATGPT_PROJECT_NAME);
      currentUrl = "https://chatgpt.com/g/g-p-meoing/c/chat-1";
    });

    await expect(placeCurrentConversationInProject(MEOI_CHATGPT_PROJECT_NAME, Date.now() + 1_000, environment()))
      .resolves.toEqual({ created: false });
    expect(currentChatProjectName()).toBe(MEOI_CHATGPT_PROJECT_NAME);
  });

  it("creates Meoing from the move menu when it is missing", async () => {
    installMoveMenu(false, () => {
      document.body.insertAdjacentHTML("beforeend", `
        <dialog open style="display:block"><h2>Create project</h2><form><input><button id="create" type="submit" disabled>Create project</button></form></dialog>
      `);
      const input = document.querySelector<HTMLInputElement>('dialog input')!;
      input.addEventListener("input", () => { document.querySelector<HTMLButtonElement>("#create")!.disabled = !input.value; });
      document.querySelector<HTMLFormElement>("dialog form")!.addEventListener("submit", (event) => {
        event.preventDefault();
        document.body.innerHTML = '<a id="project-chat" href="https://chatgpt.com/g/g-p-meoing/c/chat-1">Open chat</a>';
        currentUrl = "https://chatgpt.com/g/g-p-meoing-meoing/project";
        document.querySelector<HTMLAnchorElement>("#project-chat")!.addEventListener("click", (clickEvent) => {
          clickEvent.preventDefault();
          document.body.innerHTML = projectBanner(MEOI_CHATGPT_PROJECT_NAME);
          currentUrl = "https://chatgpt.com/g/g-p-meoing/c/chat-1";
        }, { once: true });
      }, { once: true });
    });

    const setProjectName = vi.fn(async (input: HTMLInputElement, value: string) => {
      input.value = value;
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return true;
    });
    const createProject = vi.fn(async (button: HTMLButtonElement) => {
      button.click();
      return true;
    });
    await expect(placeCurrentConversationInProject(MEOI_CHATGPT_PROJECT_NAME, Date.now() + 1_000, {
      ...environment(),
      setProjectName,
      createProject,
    }))
      .resolves.toEqual({ created: true });
    expect(setProjectName).toHaveBeenCalledOnce();
    expect(createProject).toHaveBeenCalledOnce();
    expect(currentChatProjectName()).toBe(MEOI_CHATGPT_PROJECT_NAME);
  });

  it("finds the original conversation on a project home before reopening it", () => {
    document.body.innerHTML = `
      <a href="https://chatgpt.com/g/g-p-meoing/c/another-chat">Other</a>
      <a href="https://chatgpt.com/g/g-p-meoing/c/chat-1">Original</a>
    `;
    expect(findProjectConversationLink("chat-1")?.textContent).toBe("Original");
  });

  it("fails safely if project placement changes to another conversation", async () => {
    installMoveMenu(true, () => {
      currentUrl = "https://chatgpt.com/g/g-p-meoing/c/chat-2";
    });
    await expect(placeCurrentConversationInProject(MEOI_CHATGPT_PROJECT_NAME, Date.now() + 1_000, environment()))
      .rejects.toThrow("different conversation");
  });
});
