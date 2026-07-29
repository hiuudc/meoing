import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  COMMAND_PRIORITY_NORMAL,
  FORMAT_TEXT_COMMAND,
  KEY_DOWN_COMMAND,
} from "lexical";
import {
  changeFontSize,
  clearSelectionFormatting,
  formatBlock,
  indentSelection,
  outdentSelection,
  setSelectionAlignment,
  type BlockType,
} from "./toolbarCommands";
import { matchDocumentShortcut } from "./shortcuts";

interface ShortcutsPluginProps {
  blockType: BlockType;
  fontSize: string;
  onEditLink: () => void;
}

export function ShortcutsPlugin({
  blockType,
  fontSize,
  onEditLink,
}: ShortcutsPluginProps) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => editor.registerCommand(
    KEY_DOWN_COMMAND,
    (event) => {
      const action = matchDocumentShortcut(event);
      if (!action) return false;
      if (action === "paragraph"
        || action === "h1"
        || action === "h2"
        || action === "h3"
        || action === "number"
        || action === "bullet"
        || action === "check"
        || action === "code-block"
        || action === "quote") {
        formatBlock(
          editor,
          blockType,
          action === "code-block" ? "code" : action,
        );
      } else if (action === "font-increase") {
        changeFontSize(editor, fontSize, 1);
      } else if (action === "font-decrease") {
        changeFontSize(editor, fontSize, -1);
      } else if (action === "inline-code") {
        editor.dispatchCommand(FORMAT_TEXT_COMMAND, "code");
      } else if (action === "strikethrough"
        || action === "lowercase"
        || action === "uppercase"
        || action === "capitalize"
        || action === "subscript"
        || action === "superscript") {
        editor.dispatchCommand(FORMAT_TEXT_COMMAND, action);
      } else if (action === "center"
        || action === "justify"
        || action === "left"
        || action === "right") {
        setSelectionAlignment(editor, action);
      } else if (action === "indent") {
        indentSelection(editor);
      } else if (action === "outdent") {
        outdentSelection(editor);
      } else if (action === "clear-formatting") {
        clearSelectionFormatting(editor);
      } else if (action === "link") {
        onEditLink();
      }
      event.preventDefault();
      return true;
    },
    COMMAND_PRIORITY_NORMAL,
  ), [blockType, editor, fontSize, onEditLink]);

  return null;
}
