import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, type EditorState, type LexicalEditor } from "lexical";
import DraggableBlockPlugin from "./playground/plugins/DraggableBlockPlugin";
import CodeActionMenuPlugin from "./playground/plugins/CodeActionMenuPlugin";
import ComponentPickerPlugin from "./playground/plugins/ComponentPickerPlugin";
import FloatingLinkEditorPlugin from "./playground/plugins/FloatingLinkEditorPlugin";
import FloatingTextFormatToolbarPlugin from "./playground/plugins/FloatingTextFormatToolbarPlugin";
import FloatingRubyEditorPlugin from "./playground/plugins/RubyExtension/FloatingRubyEditor";
import ShortcutsPlugin from "./playground/plugins/ShortcutsPlugin";
import TableCellActionMenuPlugin from "./playground/plugins/TableActionMenuPlugin";
import TableCellResizer from "./playground/plugins/TableCellResizer";
import TableHoverActionsV2Plugin from "./playground/plugins/TableHoverActionsV2Plugin";
import TableScrollShadowPlugin from "./playground/plugins/TableScrollShadowPlugin";
import ToolbarPlugin from "./playground/plugins/ToolbarPlugin";
import ContentEditable from "./playground/ui/ContentEditable";
import { deriveDocumentPlainText } from "./editorUtils";
import { FileMenu } from "./FileMenu";
import { FindReplace } from "./FindReplace";
import { InsertMenu } from "./InsertMenu";
import type { DocumentEditorValue } from "../DocumentEditor";

let activePlaygroundSurfaces = 0;

interface MeoingPlaygroundEditorProps {
  language: string;
  onChange: (value: DocumentEditorValue) => void;
  readOnly: boolean;
  onToggleReadOnly: () => void;
}

/**
 * Playground UI with Meoing's existing extension configuration.  Keeping the
 * host configuration here is deliberate: the official playground's image and
 * custom-node examples use a different serialized format and permit local
 * file images, neither of which is valid for Meoing documents.
 */
export function MeoingPlaygroundEditor({
  language,
  onChange,
  readOnly,
  onToggleReadOnly,
}: MeoingPlaygroundEditorProps) {
  const [editor] = useLexicalComposerContext();
  const [activeEditor, setActiveEditor] = useState(editor);
  const [anchorElement, setAnchorElement] = useState<HTMLDivElement | null>(null);
  const [isLinkEditMode, setIsLinkEditMode] = useState(false);
  const [isRubyEditMode, setIsRubyEditMode] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [insertMenuOpen, setInsertMenuOpen] = useState(false);
  const [isSmallWidthViewport, setIsSmallWidthViewport] = useState(false);

  useEffect(() => {
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  useEffect(() => {
    activePlaygroundSurfaces += 1;
    document.body.dataset.meoingPlaygroundActive = "true";
    return () => {
      activePlaygroundSurfaces -= 1;
      if (activePlaygroundSurfaces === 0) {
        delete document.body.dataset.meoingPlaygroundActive;
      }
    };
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia?.("(max-width: 1025px)");
    if (!mediaQuery) return;
    const updateViewport = () => setIsSmallWidthViewport(mediaQuery.matches);
    updateViewport();
    mediaQuery.addEventListener?.("change", updateViewport);
    return () => mediaQuery.removeEventListener?.("change", updateViewport);
  }, []);

  function clearDocument() {
    editor.update(() => {
      $getRoot().clear();
    });
  }

  return (
    <div
      className="meoing-playground"
      data-language={language}
      data-read-only={readOnly || undefined}
      onClickCapture={(event) => {
        // Playground controls can live inside Meoing's document form. Prevent
        // their implicit submit default while preserving each control's handler.
        if ((event.target as Element | null)?.closest("button")) {
          event.preventDefault();
        }
      }}
    >
      <ToolbarPlugin
        editor={editor}
        activeEditor={activeEditor}
        setActiveEditor={setActiveEditor}
        setIsLinkEditMode={setIsLinkEditMode}
        setIsRubyEditMode={setIsRubyEditMode}
        utilitySlot={
          <div className="meoing-playground-utilities">
            {!readOnly ? (
              <InsertMenu
                language={language}
                open={insertMenuOpen}
                onClose={() => setInsertMenuOpen(false)}
                onToggle={() => setInsertMenuOpen((current) => !current)}
                customOnly
              />
            ) : null}
            <button
              type="button"
              aria-label="Find and replace"
              aria-expanded={findOpen}
              className={findOpen ? "is-active" : undefined}
              onClick={() => setFindOpen((current) => !current)}
            >
              <Search size={17} />
            </button>
            <FileMenu
              open={fileMenuOpen}
              onClose={() => setFileMenuOpen(false)}
              onToggle={() => setFileMenuOpen((current) => !current)}
              readOnly={readOnly}
              tocVisible={false}
              onClear={clearDocument}
              onToggleReadOnly={onToggleReadOnly}
              onToggleToc={() => undefined}
            />
          </div>
        }
      />
      {!readOnly ? (
        <ShortcutsPlugin
          editor={activeEditor}
          setIsLinkEditMode={setIsLinkEditMode}
        />
      ) : null}
      <FindReplace open={findOpen} onClose={() => setFindOpen(false)} />
      <div className="editor-container">
        {!readOnly ? <ComponentPickerPlugin /> : null}
        <MarkdownShortcutPlugin />
        <DocumentChangePlugin onChange={onChange} />
        <div className="editor-scroller">
          <div className="editor" ref={setAnchorElement}>
            <ContentEditable placeholder="Write notes, examples, or type / to insert a block..." />
          </div>
        </div>
        <TableCellResizer />
        <TableScrollShadowPlugin />
        {anchorElement ? (
          <>
            <FloatingLinkEditorPlugin
              anchorElem={anchorElement}
              isLinkEditMode={isLinkEditMode}
              setIsLinkEditMode={setIsLinkEditMode}
            />
            <FloatingRubyEditorPlugin
              anchorElem={anchorElement}
              isRubyEditMode={isRubyEditMode}
              setIsRubyEditMode={setIsRubyEditMode}
            />
            {!readOnly ? (
              <TableCellActionMenuPlugin anchorElem={anchorElement} cellMerge />
            ) : null}
            {!readOnly && !isSmallWidthViewport ? (
              <>
                <DraggableBlockPlugin anchorElem={anchorElement} />
                <CodeActionMenuPlugin anchorElem={anchorElement} />
                <TableHoverActionsV2Plugin anchorElem={anchorElement} />
                <FloatingTextFormatToolbarPlugin
                  anchorElem={anchorElement}
                  isRubyEditMode={isRubyEditMode}
                  setIsLinkEditMode={setIsLinkEditMode}
                />
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function DocumentChangePlugin({
  onChange,
}: {
  onChange: (value: DocumentEditorValue) => void;
}) {
  function handleChange(editorState: EditorState, _editor: LexicalEditor) {
    onChange({
      content: JSON.stringify(editorState.toJSON()),
      plainText: deriveDocumentPlainText(editorState),
    });
  }

  return <OnChangePlugin onChange={handleChange} />;
}
