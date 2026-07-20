const COMPOSER_PAYLOAD_PREFIX = "meoi-composer-payload-";
const COMPOSER_PAYLOAD_SELECTOR = `script[id^="${COMPOSER_PAYLOAD_PREFIX}"][data-meoi-request-id]`;
const COMPOSER_READY_ATTRIBUTE = "data-meoi-main-bridge";
const COMPOSER_RESULT_ATTRIBUTE = "data-meoi-composer-result";
const PROJECT_NAME_PAYLOAD_PREFIX = "meoi-project-name-payload-";
const PROJECT_NAME_PAYLOAD_SELECTOR = `script[id^="${PROJECT_NAME_PAYLOAD_PREFIX}"][data-meoi-request-id]`;
const PROJECT_NAME_RESULT_ATTRIBUTE = "data-meoi-project-name-result";
const MAX_COMPOSER_TEXT_BYTES = 700 * 1024;
const MAX_PROJECT_NAME_BYTES = 1024;

type UnknownRecord = Record<PropertyKey, unknown>;

interface ProseMirrorNodeTypeLike {
  create(attributes?: unknown, content?: unknown): unknown;
}

interface ProseMirrorSchemaLike {
  nodes?: Record<string, ProseMirrorNodeTypeLike>;
  text(value: string): unknown;
  topNodeType?: { contentMatch?: { defaultType?: ProseMirrorNodeTypeLike } };
}

interface ProseMirrorTransactionLike {
  replaceWith(from: number, to: number, content: unknown): ProseMirrorTransactionLike;
  scrollIntoView?: () => ProseMirrorTransactionLike;
}

export interface ProseMirrorViewLike {
  state: {
    doc: { content: { size: number } };
    schema: ProseMirrorSchemaLike;
    tr: ProseMirrorTransactionLike;
  };
  dispatch(transaction: ProseMirrorTransactionLike): void;
  focus?: () => void;
}

interface TiptapEditorLike {
  commands: {
    setContent(content: unknown, options?: unknown): unknown;
    focus?: (position?: unknown) => unknown;
  };
}

interface LexicalEditorLike {
  parseEditorState(serializedState: string): unknown;
  setEditorState(editorState: unknown): void;
  focus?: () => void;
}

function isObject(value: unknown): value is UnknownRecord {
  return Boolean(value) && (typeof value === "object" || typeof value === "function");
}

function isProseMirrorView(value: unknown): value is ProseMirrorViewLike {
  if (!isObject(value) || typeof value.dispatch !== "function" || !isObject(value.state)) return false;
  const state = value.state;
  return isObject(state.doc)
    && isObject(state.doc.content)
    && typeof state.doc.content.size === "number"
    && isObject(state.schema)
    && typeof state.schema.text === "function"
    && isObject(state.tr)
    && typeof state.tr.replaceWith === "function";
}

function isTiptapEditor(value: unknown): value is TiptapEditorLike {
  return isObject(value)
    && isObject(value.commands)
    && typeof value.commands.setContent === "function";
}

function isLexicalEditor(value: unknown): value is LexicalEditorLike {
  return isObject(value)
    && typeof value.parseEditorState === "function"
    && typeof value.setEditorState === "function";
}

function propertyValue(object: UnknownRecord, key: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function viewFromDescription(description: unknown): ProseMirrorViewLike | null {
  if (!isObject(description)) return null;
  let current: UnknownRecord = description;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 30 && !visited.has(current); depth += 1) {
    visited.add(current);
    const direct = propertyValue(current, "view");
    if (isProseMirrorView(direct)) return direct;
    const parent = propertyValue(current, "parent");
    if (!isObject(parent)) break;
    current = parent;
  }
  return null;
}

function controllerSeeds(composer: HTMLElement): unknown[] {
  const ancestors: HTMLElement[] = [];
  let ancestor: HTMLElement | null = composer;
  for (let depth = 0; ancestor && depth < 12; depth += 1) {
    ancestors.push(ancestor);
    ancestor = ancestor.parentElement;
  }
  const nodes = [...new Set([
    ...ancestors,
    ...Array.from(composer.querySelectorAll<HTMLElement>("*")).slice(0, 80),
  ])];
  const seeds: unknown[] = [];
  for (const node of nodes) {
    for (const key of Reflect.ownKeys(node)) {
      const name = String(key);
      if (!/(pmViewDesc|react|editor|prose|view|lexical)/i.test(name)) continue;
      const value = propertyValue(node as unknown as UnknownRecord, key);
      if (name.includes("pmViewDesc")) {
        const view = viewFromDescription(value);
        if (view) seeds.push(view);
      }
      seeds.push(value);
    }
  }
  return seeds;
}

function relatedValues(value: UnknownRecord): unknown[] {
  const keys = [
    "view", "editor", "editorView", "_editor", "_tiptapEditor", "__lexicalEditor", "commands",
    "stateNode", "memoizedProps", "memoizedState", "pendingProps", "return",
    "child", "sibling", "current", "props", "root",
  ];
  const values = keys.map((key) => propertyValue(value, key));
  for (const key of Reflect.ownKeys(value).slice(0, 80)) {
    if (!/(editor|view|commands|lexical)/i.test(String(key))) continue;
    values.push(propertyValue(value, key));
  }
  return values;
}

export function findComposerController(composer: HTMLElement): ProseMirrorViewLike | TiptapEditorLike | LexicalEditorLike | null {
  const queue = controllerSeeds(composer).map((value) => ({ value, depth: 0 }));
  const visited = new Set<unknown>();
  for (let index = 0; index < queue.length && index < 2_000; index += 1) {
    const entry = queue[index];
    if (!isObject(entry.value) || visited.has(entry.value)) continue;
    visited.add(entry.value);
    if (isProseMirrorView(entry.value) || isTiptapEditor(entry.value) || isLexicalEditor(entry.value)) return entry.value;
    if (entry.depth >= 16) continue;
    for (const related of relatedValues(entry.value)) {
      if (isObject(related) && !visited.has(related)) queue.push({ value: related, depth: entry.depth + 1 });
    }
  }
  return null;
}

export function setProseMirrorText(view: ProseMirrorViewLike, value: string): boolean {
  try {
    const { schema } = view.state;
    const paragraphType = schema.nodes?.paragraph ?? schema.topNodeType?.contentMatch?.defaultType;
    if (!paragraphType) return false;
    const paragraphs = value.split("\n").map((line) => paragraphType.create(
      null,
      line ? schema.text(line) : undefined,
    ));
    let transaction = view.state.tr.replaceWith(0, view.state.doc.content.size, paragraphs);
    transaction = transaction.scrollIntoView?.() ?? transaction;
    view.dispatch(transaction);
    view.focus?.();
    return true;
  } catch {
    return false;
  }
}

function setTiptapText(editor: TiptapEditorLike, value: string): boolean {
  const content = {
    type: "doc",
    content: value.split("\n").map((line) => ({
      type: "paragraph",
      ...(line ? { content: [{ type: "text", text: line }] } : {}),
    })),
  };
  try {
    editor.commands.setContent(content, { emitUpdate: true });
    editor.commands.focus?.("end");
    return true;
  } catch {
    try {
      editor.commands.setContent(content, true);
      editor.commands.focus?.("end");
      return true;
    } catch {
      return false;
    }
  }
}

function setLexicalText(editor: LexicalEditorLike, value: string): boolean {
  try {
    const state = {
      root: {
        children: value.split("\n").map((line) => ({
          children: line ? [{ detail: 0, format: 0, mode: "normal", style: "", text: line, type: "text", version: 1 }] : [],
          direction: null,
          format: "",
          indent: 0,
          type: "paragraph",
          version: 1,
          textFormat: 0,
          textStyle: "",
        })),
        direction: null,
        format: "",
        indent: 0,
        type: "root",
        version: 1,
      },
    };
    editor.setEditorState(editor.parseEditorState(JSON.stringify(state)));
    editor.focus?.();
    return true;
  } catch {
    return false;
  }
}

function selectContents(composer: HTMLElement) {
  composer.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function setWithNativeEditing(composer: HTMLElement, value: string) {
  selectContents(composer);
  document.execCommand("delete", false);
  selectContents(composer);
  document.execCommand("insertText", false, value);
  if ((composer.innerText || composer.textContent || "").trim() || !value) return;
  composer.innerText = value;
  composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
}

function setWithFallbackTextarea(composer: HTMLElement, value: string) {
  const root = composer.closest("form") ?? document;
  const textarea = root.querySelector<HTMLTextAreaElement>('textarea[aria-label*="ChatGPT" i], textarea[placeholder*="ChatGPT" i]');
  if (!textarea) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
}

function findComposer(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '#prompt-textarea[contenteditable="true"], [role="textbox"][contenteditable="true"][aria-label*="ChatGPT" i]',
  );
}

function applyComposerText(value: string): string {
  const composer = findComposer();
  if (!composer) return "no-composer";
  const controller = findComposerController(composer);
  if (controller && isProseMirrorView(controller) && setProseMirrorText(controller, value)) return "prosemirror";
  if (controller && isTiptapEditor(controller) && setTiptapText(controller, value)) return "tiptap";
  if (controller && isLexicalEditor(controller) && setLexicalText(controller, value)) return "lexical";
  setWithFallbackTextarea(composer, value);
  setWithNativeEditing(composer, value);
  return controller ? "controller-fallback" : "native-fallback";
}

function normalizedText(element: Element): string {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

function visibleElement(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
}

export function findCreateProjectNameInput(): HTMLInputElement | null {
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('dialog, [role="dialog"]')).filter((dialog) => (
    visibleElement(dialog)
    && Array.from(dialog.querySelectorAll("h1, h2, h3")).some((heading) => normalizedText(heading) === "Create project")
  ));
  if (dialogs.length !== 1) return null;
  const inputs = Array.from(dialogs[0].querySelectorAll<HTMLInputElement>('input[type="text"], input:not([type])'))
    .filter((input) => !input.disabled && input.getAttribute("aria-disabled") !== "true");
  return inputs.length === 1 ? inputs[0] : null;
}

export function setNativeInputValue(input: HTMLInputElement, value: string): boolean {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) return false;
  input.focus();
  setter.call(input, value);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return input.value === value;
}

function applyProjectName(value: string): string {
  const input = findCreateProjectNameInput();
  if (!input) return "no-project-input";
  return setNativeInputValue(input, value) ? "native-input" : "input-mismatch";
}

function handleComposerPayload(payload: Element) {
  const requestId = payload.getAttribute("data-meoi-request-id");
  if (!requestId || !/^[a-f0-9-]{36}$/i.test(requestId)) return;
  if (!(payload instanceof HTMLScriptElement)
    || payload.id !== `${COMPOSER_PAYLOAD_PREFIX}${requestId}`
    || payload.type !== "application/json") return;
  const value = payload.textContent ?? "";
  payload.remove();
  if (new TextEncoder().encode(value).byteLength > MAX_COMPOSER_TEXT_BYTES) return;
  const strategy = applyComposerText(value);
  document.documentElement.setAttribute(COMPOSER_RESULT_ATTRIBUTE, `${requestId}:${strategy}`);
}

function handleProjectNamePayload(payload: Element) {
  const requestId = payload.getAttribute("data-meoi-request-id");
  if (!requestId || !/^[a-f0-9-]{36}$/i.test(requestId)) return;
  if (!(payload instanceof HTMLScriptElement)
    || payload.id !== `${PROJECT_NAME_PAYLOAD_PREFIX}${requestId}`
    || payload.type !== "application/json") return;
  const value = payload.textContent ?? "";
  payload.remove();
  if (!value || new TextEncoder().encode(value).byteLength > MAX_PROJECT_NAME_BYTES) return;
  const strategy = applyProjectName(value);
  document.documentElement.setAttribute(PROJECT_NAME_RESULT_ATTRIBUTE, `${requestId}:${strategy}`);
}

if (typeof document !== "undefined") {
  document.documentElement.setAttribute(COMPOSER_READY_ATTRIBUTE, "ready");
  document.querySelectorAll(COMPOSER_PAYLOAD_SELECTOR).forEach(handleComposerPayload);
  document.querySelectorAll(PROJECT_NAME_PAYLOAD_SELECTOR).forEach(handleProjectNamePayload);
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(COMPOSER_PAYLOAD_SELECTOR)) handleComposerPayload(node);
        node.querySelectorAll(COMPOSER_PAYLOAD_SELECTOR).forEach(handleComposerPayload);
        if (node.matches(PROJECT_NAME_PAYLOAD_SELECTOR)) handleProjectNamePayload(node);
        node.querySelectorAll(PROJECT_NAME_PAYLOAD_SELECTOR).forEach(handleProjectNamePayload);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}
