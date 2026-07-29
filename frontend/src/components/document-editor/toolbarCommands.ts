import {
  $createParagraphNode,
  $getSelection,
  $isElementNode,
  $isTextNode,
  FORMAT_ELEMENT_COMMAND,
  INDENT_CONTENT_COMMAND,
  OUTDENT_CONTENT_COMMAND,
  type ElementFormatType,
  type LexicalEditor,
} from "lexical";
import { $createCodeNode } from "@lexical/code-core";
import {
  INSERT_CHECK_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  REMOVE_LIST_COMMAND,
} from "@lexical/list";
import {
  $patchStyleText,
  $setBlocksType,
} from "@lexical/selection";
import {
  $createHeadingNode,
  $createQuoteNode,
} from "@lexical/rich-text";

export type BlockType =
  | "paragraph"
  | "h1"
  | "h2"
  | "h3"
  | "quote"
  | "code"
  | "bullet"
  | "number"
  | "check";

export function formatBlock(
  editor: LexicalEditor,
  currentBlockType: BlockType,
  nextBlockType: BlockType,
): void {
  if (nextBlockType === "bullet") {
    editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
    return;
  }
  if (nextBlockType === "number") {
    editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
    return;
  }
  if (nextBlockType === "check") {
    editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined);
    return;
  }
  if (currentBlockType === "bullet"
    || currentBlockType === "number"
    || currentBlockType === "check") {
    editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
  }
  editor.update(() => {
    const selection = $getSelection();
    if (!selection) return;
    if (nextBlockType === "paragraph") {
      $setBlocksType(selection, () => $createParagraphNode());
    } else if (nextBlockType === "quote") {
      $setBlocksType(selection, () => $createQuoteNode());
    } else if (nextBlockType === "code") {
      $setBlocksType(selection, () => $createCodeNode());
    } else {
      $setBlocksType(selection, () => $createHeadingNode(nextBlockType));
    }
  });
}

export function applySelectionStyle(
  editor: LexicalEditor,
  property: "background-color" | "color" | "font-family" | "font-size",
  value: string,
): void {
  editor.update(() => {
    const selection = $getSelection();
    if (selection) $patchStyleText(selection, { [property]: value });
  });
}

export function changeFontSize(
  editor: LexicalEditor,
  currentValue: string,
  delta: number,
): void {
  const parsed = Number.parseInt(currentValue, 10);
  const current = Number.isFinite(parsed) ? parsed : 17;
  const next = Math.min(72, Math.max(8, current + delta));
  applySelectionStyle(editor, "font-size", `${next}px`);
}

export function clearSelectionFormatting(editor: LexicalEditor): void {
  editor.update(() => {
    const selection = $getSelection();
    if (!selection) return;
    const visited = new Set<string>();
    for (const node of selection.getNodes()) {
      const textNodes = $isTextNode(node)
        ? [node]
        : $isElementNode(node) ? node.getAllTextNodes() : [];
      for (const textNode of textNodes) {
        if (visited.has(textNode.getKey())) continue;
        visited.add(textNode.getKey());
        textNode.setFormat(0);
        textNode.setStyle("");
      }
    }
  });
}

export function setSelectionDirection(
  editor: LexicalEditor,
  direction: "ltr" | "rtl",
): void {
  editor.update(() => {
    const selection = $getSelection();
    if (!selection) return;
    const seen = new Set<string>();
    for (const node of selection.getNodes()) {
      const element = node.getTopLevelElementOrThrow();
      if (!$isElementNode(element) || seen.has(element.getKey())) continue;
      seen.add(element.getKey());
      element.setDirection(direction);
    }
  });
}

export function setSelectionAlignment(
  editor: LexicalEditor,
  alignment: ElementFormatType,
): void {
  editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, alignment);
}

export function indentSelection(editor: LexicalEditor): void {
  editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined);
}

export function outdentSelection(editor: LexicalEditor): void {
  editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined);
}
