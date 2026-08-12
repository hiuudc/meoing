import {
  IS_APPLE,
  isExactShortcutMatch,
} from "lexical";

export type DocumentShortcutAction =
  | "paragraph"
  | "h1"
  | "h2"
  | "h3"
  | "number"
  | "bullet"
  | "check"
  | "code-block"
  | "quote"
  | "font-increase"
  | "font-decrease"
  | "inline-code"
  | "strikethrough"
  | "lowercase"
  | "uppercase"
  | "capitalize"
  | "center"
  | "justify"
  | "left"
  | "right"
  | "subscript"
  | "superscript"
  | "indent"
  | "outdent"
  | "clear-formatting"
  | "link";

export interface ShortcutEntry {
  action: DocumentShortcutAction | "undo" | "redo" | "bold" | "italic" | "underline";
  keys: string;
  label: string;
}

const controlOrMeta = { ctrlKey: !IS_APPLE, metaKey: IS_APPLE };
const command = IS_APPLE ? "\u2318" : "Ctrl";
const control = IS_APPLE ? "\u2303" : "Ctrl";
const option = IS_APPLE ? "Opt" : "Alt";

export const SHORTCUT_ENTRIES: ShortcutEntry[] = [
  { action: "undo", label: "Undo", keys: `${command}+Z` },
  { action: "redo", label: "Redo", keys: IS_APPLE ? "\u2318+Shift+Z" : "Ctrl+Y" },
  { action: "bold", label: "Bold", keys: `${command}+B` },
  { action: "italic", label: "Italic", keys: `${command}+I` },
  { action: "underline", label: "Underline", keys: `${command}+U` },
  { action: "link", label: "Insert or edit link", keys: `${command}+K` },
  { action: "paragraph", label: "Paragraph", keys: `${command}+${option}+0` },
  { action: "h1", label: "Heading 1", keys: `${command}+${option}+1` },
  { action: "h2", label: "Heading 2", keys: `${command}+${option}+2` },
  { action: "h3", label: "Heading 3", keys: `${command}+${option}+3` },
  { action: "number", label: "Numbered list", keys: `${command}+Shift+7` },
  { action: "bullet", label: "Bulleted list", keys: `${command}+Shift+8` },
  { action: "check", label: "Checklist", keys: `${command}+Shift+9` },
  { action: "code-block", label: "Code block", keys: `${command}+${option}+C` },
  { action: "quote", label: "Quote", keys: `${control}+Shift+Q` },
  { action: "font-increase", label: "Increase font size", keys: `${command}+Shift+.` },
  { action: "font-decrease", label: "Decrease font size", keys: `${command}+Shift+,` },
  { action: "inline-code", label: "Inline code", keys: `${command}+Shift+C` },
  { action: "strikethrough", label: "Strikethrough", keys: `${command}+Shift+X` },
  { action: "lowercase", label: "Lowercase", keys: `${control}+Shift+1` },
  { action: "uppercase", label: "Uppercase", keys: `${control}+Shift+2` },
  { action: "capitalize", label: "Capitalize", keys: `${control}+Shift+3` },
  { action: "center", label: "Center align", keys: `${command}+Shift+E` },
  { action: "justify", label: "Justify align", keys: `${command}+Shift+J` },
  { action: "left", label: "Left align", keys: `${command}+Shift+L` },
  { action: "right", label: "Right align", keys: `${command}+Shift+R` },
  { action: "subscript", label: "Subscript", keys: `${command}+,` },
  { action: "superscript", label: "Superscript", keys: `${command}+.` },
  { action: "indent", label: "Indent", keys: `${command}+]` },
  { action: "outdent", label: "Outdent", keys: `${command}+[` },
  { action: "clear-formatting", label: "Clear formatting", keys: `${command}+\\` },
];

export function shortcutKeys(
  action: ShortcutEntry["action"],
): string | undefined {
  return SHORTCUT_ENTRIES.find((entry) => entry.action === action)?.keys;
}

export function matchDocumentShortcut(
  event: KeyboardEvent,
): DocumentShortcutAction | null {
  for (const key of ["1", "2", "3"] as const) {
    if (isExactShortcutMatch(event, key, { ...controlOrMeta, altKey: true })) {
      return `h${key}`;
    }
  }
  const matches: Array<[
    DocumentShortcutAction,
    string,
    Parameters<typeof isExactShortcutMatch>[2],
  ]> = [
    ["paragraph", "0", { ...controlOrMeta, altKey: true }],
    ["number", "7", { ...controlOrMeta, shiftKey: true }],
    ["bullet", "8", { ...controlOrMeta, shiftKey: true }],
    ["check", "9", { ...controlOrMeta, shiftKey: true }],
    ["code-block", "c", { ...controlOrMeta, altKey: true }],
    ["quote", "q", { ctrlKey: true, shiftKey: true }],
    ["font-increase", ">", { ...controlOrMeta, shiftKey: true }],
    ["font-decrease", "<", { ...controlOrMeta, shiftKey: true }],
    ["inline-code", "c", { ...controlOrMeta, shiftKey: true }],
    ["strikethrough", "x", { ...controlOrMeta, shiftKey: true }],
    ["lowercase", "1", { ctrlKey: true, shiftKey: true }],
    ["uppercase", "2", { ctrlKey: true, shiftKey: true }],
    ["capitalize", "3", { ctrlKey: true, shiftKey: true }],
    ["center", "e", { ...controlOrMeta, shiftKey: true }],
    ["justify", "j", { ...controlOrMeta, shiftKey: true }],
    ["left", "l", { ...controlOrMeta, shiftKey: true }],
    ["right", "r", { ...controlOrMeta, shiftKey: true }],
    ["subscript", ",", controlOrMeta],
    ["superscript", ".", controlOrMeta],
    ["indent", "]", controlOrMeta],
    ["outdent", "[", controlOrMeta],
    ["clear-formatting", "\\", controlOrMeta],
    ["link", "k", controlOrMeta],
  ];
  for (const [action, key, modifiers] of matches) {
    if (isExactShortcutMatch(event, key, modifiers)) return action;
  }
  return null;
}
