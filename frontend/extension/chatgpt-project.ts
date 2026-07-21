import { conversationIdFromUrl, isProjectHomeUrl } from "./chatgpt-url";

export const MEOI_CHATGPT_PROJECT_NAME = "Meoing";
export const CHATGPT_PROJECT_PLACEMENT_TIMEOUT_MS = 30_000;

export interface ProjectPlacementEnvironment {
  root: Document;
  currentUrl(): string;
  now(): number;
  wait(milliseconds: number): Promise<void>;
  setProjectName?(input: HTMLInputElement, value: string, deadline: number): Promise<boolean>;
  createProject?(button: HTMLButtonElement, deadline: number): Promise<boolean>;
}

export interface ProjectPlacementResult {
  created: boolean;
}

function normalizedText(element: Element): string {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

function visibleElement(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
}

function uniqueVisibleElements(root: ParentNode, selector: string): HTMLElement[] {
  return [...new Set(Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(visibleElement))];
}

export function currentChatProjectName(root: ParentNode = document): string | null {
  const links = uniqueVisibleElements(
    root,
    '[role="banner"] a[href*="/g/"][href*="/project"], header a[href*="/g/"][href*="/project"]',
  );
  const names = [...new Set(links.map(normalizedText).filter(Boolean))];
  return names.length === 1 ? names[0] : null;
}

export function findConversationOptionsButton(root: ParentNode = document): HTMLButtonElement | null {
  const buttons = uniqueVisibleElements(
    root,
    '[role="banner"] button[aria-label="Open conversation options"], header button[aria-label="Open conversation options"]',
  ).filter((element): element is HTMLButtonElement => element instanceof HTMLButtonElement);
  return buttons.length === 1 ? buttons[0] : null;
}

export function exactMenuItems(label: string, root: ParentNode = document): HTMLElement[] {
  return uniqueVisibleElements(root, '[role="menuitem"]').filter((element) => normalizedText(element) === label);
}

export function findCreateProjectDialog(root: ParentNode = document): HTMLElement | null {
  const dialogs = uniqueVisibleElements(root, 'dialog, [role="dialog"]').filter((dialog) => (
    Array.from(dialog.querySelectorAll("h1, h2, h3")).some((heading) => normalizedText(heading) === "Create project")
  ));
  return dialogs.length === 1 ? dialogs[0] : null;
}

export function findProjectNameInput(dialog: ParentNode): HTMLInputElement | null {
  const inputs = uniqueVisibleElements(dialog, "input").filter((element): element is HTMLInputElement => element instanceof HTMLInputElement);
  return inputs.length === 1 ? inputs[0] : null;
}

export function findCreateProjectButton(dialog: ParentNode): HTMLButtonElement | null {
  const buttons = uniqueVisibleElements(dialog, "button")
    .filter((element): element is HTMLButtonElement => element instanceof HTMLButtonElement)
    .filter((button) => normalizedText(button) === "Create project" && !button.disabled && button.getAttribute("aria-disabled") !== "true");
  return buttons.length === 1 ? buttons[0] : null;
}

export function findProjectConversationLink(
  conversationId: string,
  root: ParentNode = document,
): HTMLAnchorElement | null {
  const links = uniqueVisibleElements(root, 'a[href*="/g/"][href*="/c/"]')
    .filter((element): element is HTMLAnchorElement => element instanceof HTMLAnchorElement)
    .filter((link) => conversationIdFromUrl(link.href) === conversationId);
  return links[0] ?? null;
}

export function setProjectNameInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
}

async function waitForValue<T>(
  read: () => T | null,
  deadline: number,
  environment: ProjectPlacementEnvironment,
): Promise<T | null> {
  while (environment.now() < deadline) {
    const value = read();
    if (value) return value;
    await environment.wait(Math.min(100, Math.max(0, deadline - environment.now())));
  }
  return null;
}

function placementFailure(message: string): Error {
  return new Error(`ChatGPT project "${MEOI_CHATGPT_PROJECT_NAME}" ${message}`);
}

async function waitForPlacement(
  projectName: string,
  conversationId: string,
  deadline: number,
  environment: ProjectPlacementEnvironment,
): Promise<void> {
  let reopenedConversationUrl: string | null = null;
  const placed = await waitForValue(() => {
    const currentUrl = environment.currentUrl();
    const currentId = conversationIdFromUrl(currentUrl);
    if (currentId && currentId !== conversationId) {
      throw placementFailure("changed to a different conversation while organizing the chat.");
    }
    if (!currentId && !isProjectHomeUrl(currentUrl)) {
      throw placementFailure("left the conversation while organizing the chat.");
    }
    if (!currentId) {
      const conversationLink = findProjectConversationLink(conversationId, environment.root);
      if (conversationLink && conversationLink.href !== reopenedConversationUrl) {
        reopenedConversationUrl = conversationLink.href;
        conversationLink.click();
      }
      return null;
    }
    return currentId === conversationId && currentChatProjectName(environment.root) === projectName ? true : null;
  }, deadline, environment);
  if (!placed) throw placementFailure("did not confirm that the conversation was moved.");
}

export async function placeCurrentConversationInProject(
  projectName: string,
  deadline: number,
  environment: ProjectPlacementEnvironment,
): Promise<ProjectPlacementResult> {
  const conversationId = conversationIdFromUrl(environment.currentUrl());
  if (!conversationId) throw placementFailure("cannot organize a chat before ChatGPT creates its conversation URL.");
  if (currentChatProjectName(environment.root) === projectName) return { created: false };

  const options = await waitForValue(
    () => findConversationOptionsButton(environment.root),
    deadline,
    environment,
  );
  if (!options) throw placementFailure("could not find the conversation options control.");
  options.click();

  const moveItem = await waitForValue(() => {
    const items = exactMenuItems("Move to project", environment.root);
    return items.length === 1 ? items[0] : null;
  }, deadline, environment);
  if (!moveItem) throw placementFailure("could not find the Move to project action.");
  moveItem.click();

  const projectChoice = await waitForValue(() => {
    const projectItems = exactMenuItems(projectName, environment.root);
    if (projectItems.length > 1) throw placementFailure("is ambiguous because more than one project has that name.");
    if (projectItems.length === 1) return { kind: "existing" as const, element: projectItems[0] };
    const newProjectItems = exactMenuItems("New project", environment.root);
    return newProjectItems.length === 1 ? { kind: "new" as const, element: newProjectItems[0] } : null;
  }, deadline, environment);
  if (!projectChoice) throw placementFailure("was not available and the New project action was not found.");

  projectChoice.element.click();
  if (projectChoice.kind === "existing") {
    await waitForPlacement(projectName, conversationId, deadline, environment);
    return { created: false };
  }

  const dialog = await waitForValue(() => findCreateProjectDialog(environment.root), deadline, environment);
  if (!dialog) throw placementFailure("could not open the Create project dialog.");
  const input = findProjectNameInput(dialog);
  if (!input) throw placementFailure("could not find the project name field.");
  input.focus();
  let projectNameSet = environment.setProjectName
    ? await environment.setProjectName(input, projectName, deadline)
    : false;
  if (!projectNameSet) {
    setProjectNameInput(input, projectName);
    projectNameSet = input.value === projectName;
  }
  if (!projectNameSet) throw placementFailure("could not fill the project name field.");

  const createButton = await waitForValue(() => findCreateProjectButton(dialog), deadline, environment);
  if (!createButton) throw placementFailure("could not enable the Create project button.");
  const created = environment.createProject
    ? await environment.createProject(createButton, deadline)
    : false;
  if (!created) createButton.click();
  await waitForPlacement(projectName, conversationId, deadline, environment);
  return { created: true };
}
