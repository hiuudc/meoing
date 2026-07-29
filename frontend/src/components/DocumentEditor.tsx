import { useEffect, useState, type ReactNode } from "react";
import {
  Bold,
  Italic,
  Languages,
  List as ListIcon,
  ListOrdered,
  Redo2,
  Underline,
  Undo2,
} from "lucide-react";
import { ListItemNode, ListNode, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND } from "@lexical/list";
import { LexicalComposer, type InitialConfigType, type InitialEditorStateType } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_LOW,
  FORMAT_TEXT_COMMAND,
  REDO_COMMAND,
  UNDO_COMMAND,
  type EditorState,
} from "lexical";
import { normalizeDocumentContent } from "../document";
import {
  $createBilingualBlockNode,
  BilingualBlockNode,
} from "./BilingualBlockNode";

export interface DocumentEditorValue {
  content: string;
  plainText: string;
}

interface DocumentEditorProps {
  content?: string;
  language: string;
  onChange: (value: DocumentEditorValue) => void;
  plainText: string;
}

const editorTheme: InitialConfigType["theme"] = {
  heading: {
    h1: "document-editor-heading-one",
    h2: "document-editor-heading-two",
  },
  list: {
    listitem: "document-editor-list-item",
    nested: {
      listitem: "document-editor-list-item-nested",
    },
    ol: "document-editor-list-ordered",
    ul: "document-editor-list-unordered",
  },
  paragraph: "document-editor-paragraph",
  quote: "document-editor-quote",
  text: {
    bold: "document-editor-bold",
    italic: "document-editor-italic",
    underline: "document-editor-underline",
  },
};

const editorNodes = [HeadingNode, QuoteNode, ListNode, ListItemNode, BilingualBlockNode];

function handleEditorError(error: Error) {
  throw error;
}

function createInitialEditorState(content: string | undefined, plainText: string): InitialEditorStateType {
  const normalizedContent = normalizeDocumentContent(content);
  if (normalizedContent) return normalizedContent;
  return () => {
    const paragraph = $createParagraphNode();
    if (plainText) paragraph.append($createTextNode(plainText));
    $getRoot().append(paragraph);
  };
}

export function DocumentEditor({
  content,
  language,
  onChange,
  plainText,
}: DocumentEditorProps) {
  const [initialConfig] = useState<InitialConfigType>(() => ({
    editorState: createInitialEditorState(content, plainText),
    namespace: "MeoiDocumentEditor",
    nodes: editorNodes,
    onError: handleEditorError,
    theme: editorTheme,
  }));

  return (
    <div className="document-editor">
      <LexicalComposer initialConfig={initialConfig}>
        <DocumentToolbar language={language} />
        <div className="document-editor-surface">
          <RichTextPlugin
            contentEditable={<ContentEditable className="document-editor-input" aria-label="Document content" />}
            placeholder={<div className="document-editor-placeholder">Write notes, examples, or a short dialogue...</div>}
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
        <HistoryPlugin />
        <ListPlugin />
        <DocumentChangePlugin onChange={onChange} />
      </LexicalComposer>
    </div>
  );
}

function DocumentChangePlugin({ onChange }: { onChange: (value: DocumentEditorValue) => void }) {
  function handleChange(editorState: EditorState) {
    let plainText = "";
    editorState.read(() => {
      plainText = $getRoot().getTextContent().replace(/\n{3,}/g, "\n\n").trim();
    });
    onChange({
      content: JSON.stringify(editorState.toJSON()),
      plainText,
    });
  }

  return <OnChangePlugin onChange={handleChange} />;
}

function DocumentToolbar({ language }: { language: string }) {
  const [editor] = useLexicalComposerContext();
  const [formats, setFormats] = useState({ bold: false, italic: false, underline: false });
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  useEffect(() => {
    const unregisterUpdate = editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        setFormats({
          bold: $isRangeSelection(selection) && selection.hasFormat("bold"),
          italic: $isRangeSelection(selection) && selection.hasFormat("italic"),
          underline: $isRangeSelection(selection) && selection.hasFormat("underline"),
        });
      });
    });
    const unregisterUndo = editor.registerCommand(
      CAN_UNDO_COMMAND,
      (available) => {
        setCanUndo(available);
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    const unregisterRedo = editor.registerCommand(
      CAN_REDO_COMMAND,
      (available) => {
        setCanRedo(available);
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    return () => {
      unregisterUpdate();
      unregisterUndo();
      unregisterRedo();
    };
  }, [editor]);

  function insertBilingualBlock() {
    editor.update(() => {
      const bilingualBlock = $createBilingualBlockNode("", "", language);
      if ($getSelection()) $insertNodes([bilingualBlock]);
      else $getRoot().append(bilingualBlock);
      const paragraph = $createParagraphNode();
      bilingualBlock.insertAfter(paragraph);
      paragraph.select();
    });
  }

  return (
    <div className="document-editor-toolbar" role="toolbar" aria-label="Document formatting">
      <div className="document-editor-toolbar-group">
        <ToolbarButton
          label="Undo"
          disabled={!canUndo}
          onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}
        >
          <Undo2 size={17} />
        </ToolbarButton>
        <ToolbarButton
          label="Redo"
          disabled={!canRedo}
          onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)}
        >
          <Redo2 size={17} />
        </ToolbarButton>
      </div>
      <div className="document-editor-toolbar-group">
        <ToolbarButton
          label="Bold"
          pressed={formats.bold}
          onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold")}
        >
          <Bold size={17} />
        </ToolbarButton>
        <ToolbarButton
          label="Italic"
          pressed={formats.italic}
          onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic")}
        >
          <Italic size={17} />
        </ToolbarButton>
        <ToolbarButton
          label="Underline"
          pressed={formats.underline}
          onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "underline")}
        >
          <Underline size={17} />
        </ToolbarButton>
      </div>
      <div className="document-editor-toolbar-group">
        <ToolbarButton
          label="Bulleted list"
          onClick={() => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)}
        >
          <ListIcon size={17} />
        </ToolbarButton>
        <ToolbarButton
          label="Numbered list"
          onClick={() => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)}
        >
          <ListOrdered size={17} />
        </ToolbarButton>
      </div>
      <button
        className="document-editor-insert-block"
        type="button"
        aria-label="Bilingual audio"
        title="Insert bilingual audio block"
        onMouseDown={(event) => event.preventDefault()}
        onClick={insertBilingualBlock}
      >
        <Languages size={17} />
        <span>Bilingual audio</span>
      </button>
    </div>
  );
}

function ToolbarButton({
  children,
  disabled,
  label,
  onClick,
  pressed,
}: {
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  pressed?: boolean;
}) {
  return (
    <button
      className={pressed ? "is-active" : ""}
      type="button"
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
