import {
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  Columns3,
  GripVertical,
  Rows3,
  Trash2,
  X,
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
  type EditorState,
  type NodeKey,
} from "lexical";
import {
  $deleteTableColumnAtSelection,
  $deleteTableRowAtSelection,
  $insertTableColumnAtNode,
  $insertTableRowAtNode,
  $isTableCellNode,
  $isTableSelection,
  TableCellNode,
  TableNode,
} from "@lexical/table";
import { $getNearestNodeOfType } from "@lexical/utils";
import { deriveDocumentPlainText } from "./editorUtils";
import { SlashMenuPlugin } from "./InsertMenu";
import type { DocumentEditorValue } from "../DocumentEditor";

interface EditorPluginsProps {
  anchorElement: HTMLElement | null;
  contextBarElement: HTMLElement | null;
  language: string;
  onChange: (value: DocumentEditorValue) => void;
  onCloseToc: () => void;
  readOnly: boolean;
  tocVisible: boolean;
}

export function EditorPlugins({
  anchorElement,
  contextBarElement,
  language,
  onChange,
  onCloseToc,
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
      <TableCellActionsPlugin contextBarElement={contextBarElement} readOnly={readOnly} />
      <DocumentOutline onClose={onCloseToc} visible={tocVisible} />
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

export function $getCurrentTableCellKey(): NodeKey | null {
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

function TableCellActionsPlugin({
  contextBarElement,
  readOnly,
}: {
  contextBarElement: HTMLElement | null;
  readOnly: boolean;
}) {
  const [editor] = useLexicalComposerContext();
  const [cellKey, setCellKey] = useState<NodeKey | null>(null);
  const [cellWidth, setCellWidth] = useState(160);

  useEffect(() => editor.registerUpdateListener(({ editorState }) => {
    editorState.read(() => {
      const key = $getCurrentTableCellKey();
      setCellKey(key);
      const node = key ? $getNodeByKey(key) : null;
      if ($isTableCellNode(node)) setCellWidth(node.getWidth() ?? 160);
    });
  }), [editor]);

  if (!cellKey || !contextBarElement || readOnly) return null;
  const activeCellKey = cellKey;

  function runTableUpdate(update: (cell: TableCellNode) => void) {
    editor.update(() => {
      const cell = $getNodeByKey(activeCellKey);
      if (!$isTableCellNode(cell)) return;
      update(cell);
    });
  }

  function runSelectionTableUpdate(update: () => void) {
    runTableUpdate((cell) => {
      cell.selectStart();
      update();
    });
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

  return createPortal((
    <div className="document-table-cell-actions" role="toolbar" aria-label="Table cell actions">
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => runTableUpdate((cell) => {
        $insertTableRowAtNode(cell, false);
      })}>
        <Rows3 size={15} /> Row above
      </button>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => runTableUpdate((cell) => {
        $insertTableRowAtNode(cell, true);
      })}>
        <Rows3 size={15} /> Row below
      </button>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => runTableUpdate((cell) => {
        $insertTableColumnAtNode(cell, false);
      })}>
        <Columns3 size={15} /> Column left
      </button>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => runTableUpdate((cell) => {
        $insertTableColumnAtNode(cell, true);
      })}>
        <Columns3 size={15} /> Column right
      </button>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => runSelectionTableUpdate($deleteTableRowAtSelection)}>
        Delete row
      </button>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => runSelectionTableUpdate($deleteTableColumnAtSelection)}>
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
  ), contextBarElement);
}

function DocumentOutline({
  onClose,
  visible,
}: {
  onClose: () => void;
  visible: boolean;
}) {
  return (
    <TableOfContentsPlugin>
      {(entries, editor) => visible ? (
        <aside className="document-table-of-contents" aria-label="Document outline">
          <header>
            <div>
              <strong>Document outline</strong>
              <span>{entries.length} {entries.length === 1 ? "heading" : "headings"}</span>
            </div>
            <button type="button" onClick={onClose} aria-label="Close document outline">
              <X size={16} />
            </button>
          </header>
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
          )) : (
            <p>Add H1, H2, or H3 headings to navigate this document.</p>
          )}
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
