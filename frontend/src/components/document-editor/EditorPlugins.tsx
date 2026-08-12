import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  Columns3,
  GripVertical,
  Merge,
  Palette,
  Rows3,
  Trash2,
  UnfoldHorizontal,
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
  $getNearestNodeFromDOMNode,
  $getSelection,
  type EditorState,
  type NodeKey,
} from "lexical";
import {
  $deleteTableColumnAtSelection,
  $deleteTableRowAtSelection,
  $getTableColumnIndexFromTableCellNode,
  $getTableNodeFromLexicalNodeOrThrow,
  $getTableRowIndexFromTableCellNode,
  $insertTableColumnAtNode,
  $insertTableRowAtNode,
  $isTableCellNode,
  $isTableSelection,
  $mergeCells,
  $setTableColumnIsHeader,
  $setTableRowIsHeader,
  $unmergeCellNode,
  TableCellHeaderStates,
  TableCellNode,
  TableNode,
} from "@lexical/table";
import { $isLinkNode } from "@lexical/link";
import { $getNearestNodeOfType } from "@lexical/utils";
import { deriveDocumentPlainText } from "./editorUtils";
import { BlockInsertMenu, SlashMenuPlugin } from "./InsertMenu";
import { sanitizeLinkUrl } from "./editorUtils";
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
      <FloatingLinkEditor readOnly={readOnly} />
      <DocumentOutline onClose={onCloseToc} visible={tocVisible} />
      {anchorElement && !readOnly ? <DraggableBlocksPlugin anchorElement={anchorElement} language={language} /> : null}
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
  const [tableState, setTableState] = useState<{
    cellKey: NodeKey;
    cellWidth: number;
    backgroundColor: string;
    verticalAlign: string;
    rowIndex: number;
    columnIndex: number;
    rowStriping: boolean;
    frozenRows: number;
    frozenColumns: number;
    rowHeader: boolean;
    columnHeader: boolean;
    merged: boolean;
    selectedCellKeys: NodeKey[];
  } | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => editor.registerUpdateListener(({ editorState }) => {
    editorState.read(() => {
      const key = $getCurrentTableCellKey();
      const node = key ? $getNodeByKey(key) : null;
      if (!$isTableCellNode(node)) {
        setTableState(null);
        return;
      }
      const table = $getTableNodeFromLexicalNodeOrThrow(node);
      const selection = $getSelection();
      const selectedCellKeys = selection?.getNodes().flatMap((selectedNode) => {
        const cell = $isTableCellNode(selectedNode)
          ? selectedNode
          : $getNearestNodeOfType(selectedNode, TableCellNode);
        return cell ? [cell.getKey()] : [];
      }) ?? [node.getKey()];
      setTableState({
        cellKey: node.getKey(),
        cellWidth: node.getWidth() ?? 160,
        backgroundColor: node.getBackgroundColor() ?? "",
        verticalAlign: node.getVerticalAlign() ?? "top",
        rowIndex: $getTableRowIndexFromTableCellNode(node),
        columnIndex: $getTableColumnIndexFromTableCellNode(node),
        rowStriping: table.getRowStriping(),
        frozenRows: table.getFrozenRows(),
        frozenColumns: table.getFrozenColumns(),
        rowHeader: node.hasHeaderState(TableCellHeaderStates.ROW),
        columnHeader: node.hasHeaderState(TableCellHeaderStates.COLUMN),
        merged: node.getRowSpan() > 1 || node.getColSpan() > 1,
        selectedCellKeys: [...new Set(selectedCellKeys)],
      });
    });
  }), [editor]);

  if (!tableState || !contextBarElement || readOnly) return null;
  const activeCellKey = tableState.cellKey;
  const selectedCellKeys = tableState.selectedCellKeys;

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
    editor.update(() => {
      const cell = $getNodeByKey(activeCellKey);
      if ($isTableCellNode(cell)) cell.setWidth(normalized);
    });
  }

  function selectedCells(): TableCellNode[] {
    return selectedCellKeys.flatMap((key) => {
      const node = $getNodeByKey(key);
      return $isTableCellNode(node) ? [node] : [];
    });
  }

  function mergeCells() {
    editor.update(() => {
      const cells = selectedCells();
      if (cells.length > 1) $mergeCells(cells);
    });
  }

  function setTableOption(update: (table: TableNode, cell: TableCellNode) => void) {
    runTableUpdate((cell) => update($getTableNodeFromLexicalNodeOrThrow(cell), cell));
  }

  return createPortal((
    <div className="document-table-cell-actions" role="toolbar" aria-label="Table actions">
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
      <button type="button" disabled={tableState.selectedCellKeys.length < 2} onMouseDown={(event) => event.preventDefault()} onClick={mergeCells}>
        <Merge size={15} /> Merge
      </button>
      <button type="button" disabled={!tableState.merged} onMouseDown={(event) => event.preventDefault()} onClick={() => runTableUpdate((cell) => $unmergeCellNode(cell))}>
        <UnfoldHorizontal size={15} /> Unmerge
      </button>
      <button
        type="button"
        aria-expanded={moreOpen}
        aria-haspopup="menu"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setMoreOpen((current) => !current)}
      >
        <Palette size={15} /> Format <ChevronDown size={13} />
      </button>
      <label>
        <span>Cell width</span>
        <input
          type="range"
          min={80}
          max={600}
          value={tableState.cellWidth}
          onChange={(event) => resizeCell(Number(event.target.value))}
        />
      </label>
      <button className="is-danger" type="button" onMouseDown={(event) => event.preventDefault()} onClick={deleteTable}>
        <Trash2 size={15} /> Table
      </button>
      {moreOpen ? <div className="document-table-format-menu" role="menu">
        <label>Cell background
          <input
            aria-label="Cell background color"
            type="color"
            value={tableState.backgroundColor || "#2f3040"}
            onChange={(event) => runTableUpdate((cell) => cell.setBackgroundColor(event.target.value))}
          />
        </label>
        <button type="button" role="menuitem" onClick={() => runTableUpdate((cell) => cell.setBackgroundColor(null))}>Clear cell background</button>
        <label>Vertical alignment
          <select value={tableState.verticalAlign} onChange={(event) => runTableUpdate((cell) => cell.setVerticalAlign(event.target.value))}>
            <option value="top">Top</option>
            <option value="middle">Middle</option>
            <option value="bottom">Bottom</option>
          </select>
        </label>
        <button type="button" role="menuitem" onClick={() => setTableOption((table) => table.setRowStriping(!table.getRowStriping()))}>
          {tableState.rowStriping ? <Check size={15} /> : null} Toggle row striping
        </button>
        <button type="button" role="menuitem" onClick={() => setTableOption((table) => table.setFrozenRows(table.getFrozenRows() ? 0 : 1))}>
          {tableState.frozenRows ? <Check size={15} /> : null} Freeze first row
        </button>
        <button type="button" role="menuitem" onClick={() => setTableOption((table) => table.setFrozenColumns(table.getFrozenColumns() ? 0 : 1))}>
          {tableState.frozenColumns ? <Check size={15} /> : null} Freeze first column
        </button>
        <button type="button" role="menuitem" onClick={() => setTableOption((table) => $setTableRowIsHeader(table, tableState.rowIndex, !tableState.rowHeader))}>
          {tableState.rowHeader ? <Check size={15} /> : null} Toggle row header
        </button>
        <button type="button" role="menuitem" onClick={() => setTableOption((table) => $setTableColumnIsHeader(table, tableState.columnIndex, !tableState.columnHeader))}>
          {tableState.columnHeader ? <Check size={15} /> : null} Toggle column header
        </button>
      </div> : null}
    </div>
  ), contextBarElement);
}

function FloatingLinkEditor({ readOnly }: { readOnly: boolean }) {
  const [editor] = useLexicalComposerContext();
  const [link, setLink] = useState<{ key: NodeKey; url: string; rect: DOMRect } | null>(null);

  useEffect(() => {
    if (readOnly) return;
    return editor.registerRootListener((root) => {
      if (!root) return;
      const rootElement = root;
      function onLinkClick(event: MouseEvent) {
        const target = event.target instanceof Element ? event.target.closest("a") : null;
        if (!target || !rootElement.contains(target)) return;
        event.preventDefault();
        editor.getEditorState().read(() => {
          const lexicalNode = $getNearestNodeFromDOMNode(target);
          const linkNode = $isLinkNode(lexicalNode)
            ? lexicalNode
            : lexicalNode?.getParent();
          if (!$isLinkNode(linkNode)) return;
          setLink({ key: linkNode.getKey(), url: linkNode.getURL(), rect: target.getBoundingClientRect() });
        });
      }
      root.addEventListener("click", onLinkClick, true);
      return () => root.removeEventListener("click", onLinkClick, true);
    });
  }, [editor, readOnly]);

  useEffect(() => {
    if (!link) return;
    function close(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".document-floating-link-popover")) setLink(null);
    }
    function closeOnKey(event: KeyboardEvent) {
      if (event.key === "Escape") setLink(null);
    }
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnKey);
    };
  }, [link]);

  if (!link) return null;
  const left = Math.max(12, Math.min(link.rect.left, window.innerWidth - 360));
  const top = Math.max(12, link.rect.bottom + 8);
  return createPortal(
    <form
      className="document-floating-link-popover"
      style={{ left, top }}
      onSubmit={(event) => {
        event.preventDefault();
        const nextUrl = sanitizeLinkUrl(link.url);
        if (!nextUrl) return;
        editor.update(() => {
          const node = $getNodeByKey(link.key);
          if ($isLinkNode(node)) node.setURL(nextUrl);
        });
        setLink(null);
      }}
    >
      <input aria-label="Link URL" autoFocus value={link.url} onChange={(event) => setLink((current) => current ? { ...current, url: event.target.value } : current)} />
      <button className="secondary-button" type="submit">Edit</button>
      <button className="secondary-button is-danger" type="button" onClick={() => {
        editor.update(() => {
          const node = $getNodeByKey(link.key);
          if (!$isLinkNode(node)) return;
          const children = node.getChildren();
          for (const child of children) node.insertBefore(child);
          node.remove();
        });
        setLink(null);
      }}>Remove</button>
    </form>,
    document.body,
  );
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

function DraggableBlocksPlugin({ anchorElement, language }: { anchorElement: HTMLElement; language: string }) {
  const menuRef = useRef<HTMLElement | null>(null);
  const targetLineRef = useRef<HTMLElement | null>(null);
  const targetBlockKeyRef = useRef<NodeKey | null>(null);
  const [targetBlockKey, setTargetBlockKey] = useState<NodeKey | null>(null);
  const [editor] = useLexicalComposerContext();

  const handleElementChanged = useCallback((element: HTMLElement | null) => {
    let nextBlockKey: NodeKey | null = null;
    if (element) {
      editor.getEditorState().read(() => {
        // The upstream plugin passes the DOM element for one of these direct
        // root children. Comparing the elements avoids relying on a stale
        // DOM-to-node map while the menu is portalled beside the editor.
        const targetBlock = $getRoot().getChildren().find((node) => (
          editor.getElementByKey(node.getKey()) === element
        ));
        nextBlockKey = targetBlock?.getKey() ?? null;
      });
    }
    if (nextBlockKey) targetBlockKeyRef.current = nextBlockKey;
    setTargetBlockKey((current) => current === nextBlockKey ? current : nextBlockKey);
  }, [editor]);

  return (
    <DraggableBlockPlugin_EXPERIMENTAL
      anchorElem={anchorElement}
      menuRef={menuRef as RefObject<HTMLElement | null>}
      targetLineRef={targetLineRef as RefObject<HTMLElement | null>}
      menuComponent={(
        <div ref={menuRef as RefObject<HTMLDivElement>} className="document-block-actions">
          <BlockInsertMenu
            language={language}
            targetBlockKey={targetBlockKey}
            targetBlockKeyRef={targetBlockKeyRef}
          />
          <button
            className="document-block-drag-handle"
            type="button"
            aria-label="Drag block"
            title="Drag block"
          >
            <GripVertical size={17} />
          </button>
        </div>
      )}
      targetLineComponent={<div ref={targetLineRef as RefObject<HTMLDivElement>} className="document-block-drop-line" />}
      isOnMenu={(element) => menuRef.current?.contains(element) ?? false}
      onElementChanged={handleElementChanged}
    />
  );
}
