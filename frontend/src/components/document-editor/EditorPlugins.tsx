import {
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  Columns3,
  GripVertical,
  Rows3,
  Trash2,
} from "lucide-react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { DraggableBlockPlugin_EXPERIMENTAL } from "@lexical/react/LexicalDraggableBlockPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { TableOfContentsPlugin } from "@lexical/react/LexicalTableOfContentsPlugin";
import {
  $createParagraphNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  COMMAND_PRIORITY_EDITOR,
  type EditorState,
  type NodeKey,
} from "lexical";
import { DRAG_DROP_PASTE } from "@lexical/rich-text";
import {
  $deleteTableColumnAtSelection,
  $deleteTableRowAtSelection,
  $insertTableColumnAtSelection,
  $insertTableRowAtSelection,
  $isTableCellNode,
  $isTableSelection,
  TableCellNode,
  TableNode,
} from "@lexical/table";
import { $getNearestNodeOfType, $insertNodeToNearestRoot } from "@lexical/utils";
import { deriveDocumentPlainText, readImageFileAsDataUrl } from "./editorUtils";
import { SlashMenuPlugin } from "./InsertMenu";
import { $createImageNode } from "./nodes/ImageNode";
import type { DocumentEditorValue } from "../DocumentEditor";

interface EditorPluginsProps {
  anchorElement: HTMLElement | null;
  language: string;
  onChange: (value: DocumentEditorValue) => void;
  readOnly: boolean;
  tocVisible: boolean;
}

export function EditorPlugins({
  anchorElement,
  language,
  onChange,
  readOnly,
  tocVisible,
}: EditorPluginsProps) {
  return (
    <>
      <DocumentChangePlugin onChange={onChange} />
      <EditablePlugin readOnly={readOnly} />
      <MarkdownShortcutPlugin />
      <SlashMenuPlugin language={language} />
      <CodeHighlightPlugin />
      <ImageDropPlugin />
      <TableCellActionsPlugin readOnly={readOnly} />
      <DocumentTableOfContents visible={tocVisible} />
      {anchorElement && !readOnly ? <DraggableBlocksPlugin anchorElement={anchorElement} /> : null}
    </>
  );
}

function EditablePlugin({ readOnly }: { readOnly: boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);
  return null;
}

function DocumentChangePlugin({
  onChange,
}: {
  onChange: (value: DocumentEditorValue) => void;
}) {
  function handleChange(editorState: EditorState) {
    onChange({
      content: JSON.stringify(editorState.toJSON()),
      plainText: deriveDocumentPlainText(editorState),
    });
  }

  return <OnChangePlugin onChange={handleChange} />;
}

function CodeHighlightPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    let active = true;
    let unregister: (() => void) | undefined;
    void import("@lexical/code-prism").then(({ registerCodeHighlighting }) => {
      if (active) unregister = registerCodeHighlighting(editor);
    });
    return () => {
      active = false;
      unregister?.();
    };
  }, [editor]);

  return null;
}

function ImageDropPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => editor.registerCommand(
    DRAG_DROP_PASTE,
    (files) => {
      const supportedFiles = files.filter((file) => (
        ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)
      ));
      if (!supportedFiles.length) return false;
      void Promise.all(supportedFiles.map(readImageFileAsDataUrl)).then((sources) => {
        editor.update(() => {
          for (const source of sources) {
            $insertNodeToNearestRoot($createImageNode(source, "", ""));
          }
        });
      });
      return true;
    },
    COMMAND_PRIORITY_EDITOR,
  ), [editor]);

  return null;
}

function currentTableCellKey(): NodeKey | null {
  const selection = $getSelection();
  if (!selection) return null;
  if ($isTableSelection(selection)) {
    const node = selection.anchor.getNode();
    const cell = $isTableCellNode(node) ? node : $getNearestNodeOfType(node, TableCellNode);
    return cell?.getKey() ?? null;
  }
  const node = selection.getNodes()[0];
  return node ? $getNearestNodeOfType(node, TableCellNode)?.getKey() ?? null : null;
}

function TableCellActionsPlugin({ readOnly }: { readOnly: boolean }) {
  const [editor] = useLexicalComposerContext();
  const [cellKey, setCellKey] = useState<NodeKey | null>(null);
  const [cellWidth, setCellWidth] = useState(160);

  useEffect(() => editor.registerUpdateListener(({ editorState }) => {
    editorState.read(() => {
      const key = currentTableCellKey();
      setCellKey(key);
      const node = key ? $getNodeByKey(key) : null;
      if ($isTableCellNode(node)) setCellWidth(node.getWidth() ?? 160);
    });
  }), [editor]);

  if (!cellKey || readOnly) return null;
  const activeCellKey = cellKey;

  function runTableUpdate(update: () => void) {
    editor.update(update);
  }

  function deleteTable() {
    editor.update(() => {
      const cell = $getNodeByKey(activeCellKey);
      if (!$isTableCellNode(cell)) return;
      const table = $getNearestNodeOfType(cell, TableNode);
      if (!table) return;
      const paragraph = $createParagraphNode();
      table.replace(paragraph);
      paragraph.select();
    });
  }

  function resizeCell(width: number) {
    const normalized = Math.max(80, Math.min(600, Math.round(width)));
    setCellWidth(normalized);
    editor.update(() => {
      const cell = $getNodeByKey(activeCellKey);
      if ($isTableCellNode(cell)) cell.setWidth(normalized);
    });
  }

  return (
    <div className="document-table-cell-actions" role="toolbar" aria-label="Table cell actions">
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => runTableUpdate(() => $insertTableRowAtSelection(false))}>
        <Rows3 size={15} /> Row above
      </button>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => runTableUpdate(() => $insertTableRowAtSelection(true))}>
        <Rows3 size={15} /> Row below
      </button>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => runTableUpdate(() => $insertTableColumnAtSelection(false))}>
        <Columns3 size={15} /> Column left
      </button>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => runTableUpdate(() => $insertTableColumnAtSelection(true))}>
        <Columns3 size={15} /> Column right
      </button>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => runTableUpdate($deleteTableRowAtSelection)}>
        Delete row
      </button>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => runTableUpdate($deleteTableColumnAtSelection)}>
        Delete column
      </button>
      <label>
        <span>Cell width</span>
        <input
          type="range"
          min={80}
          max={600}
          value={cellWidth}
          onChange={(event) => resizeCell(Number(event.target.value))}
        />
      </label>
      <button className="is-danger" type="button" onMouseDown={(event) => event.preventDefault()} onClick={deleteTable}>
        <Trash2 size={15} /> Table
      </button>
    </div>
  );
}

function DocumentTableOfContents({ visible }: { visible: boolean }) {
  return (
    <TableOfContentsPlugin>
      {(entries, editor) => visible ? (
        <aside className="document-table-of-contents" aria-label="Table of contents">
          <header>Table of contents</header>
          {entries.length ? entries.map(([key, text, tag]) => (
            <button
              key={key}
              className={`is-${tag}`}
              type="button"
              onClick={() => editor.getElementByKey(key)?.scrollIntoView({
                behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
                block: "center",
              })}
            >
              {text || "Untitled heading"}
            </button>
          )) : <p>Add headings to build an outline.</p>}
        </aside>
      ) : <></>}
    </TableOfContentsPlugin>
  );
}

function DraggableBlocksPlugin({ anchorElement }: { anchorElement: HTMLElement }) {
  const menuRef = useRef<HTMLElement | null>(null);
  const targetLineRef = useRef<HTMLElement | null>(null);

  return (
    <DraggableBlockPlugin_EXPERIMENTAL
      anchorElem={anchorElement}
      menuRef={menuRef as RefObject<HTMLElement | null>}
      targetLineRef={targetLineRef as RefObject<HTMLElement | null>}
      menuComponent={(
        <button
          ref={menuRef as RefObject<HTMLButtonElement>}
          className="document-block-drag-handle"
          type="button"
          aria-label="Drag block"
          title="Drag block"
        >
          <GripVertical size={17} />
        </button>
      )}
      targetLineComponent={<div ref={targetLineRef as RefObject<HTMLDivElement>} className="document-block-drop-line" />}
      isOnMenu={(element) => menuRef.current?.contains(element) ?? false}
    />
  );
}
