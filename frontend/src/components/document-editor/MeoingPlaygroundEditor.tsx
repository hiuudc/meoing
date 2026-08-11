import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, type EditorState, type LexicalEditor } from "lexical";
import DraggableBlockPlugin from "./playground/plugins/DraggableBlockPlugin";
import FloatingLinkEditorPlugin from "./playground/plugins/FloatingLinkEditorPlugin";
import TableCellActionMenuPlugin from "./playground/plugins/TableActionMenuPlugin";
import TableCellResizer from "./playground/plugins/TableCellResizer";
import TableHoverActionsV2Plugin from "./playground/plugins/TableHoverActionsV2Plugin";
import ToolbarPlugin from "./playground/plugins/ToolbarPlugin";
import ContentEditable from "./playground/ui/ContentEditable";
import { deriveDocumentPlainText } from "./editorUtils";
import { FileMenu } from "./FileMenu";
import { FindReplace } from "./FindReplace";
import { InsertMenu, SlashMenuPlugin } from "./InsertMenu";
import type { DocumentEditorValue } from "../DocumentEditor";

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

  useEffect(() => {
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  function clearDocument() {
    editor.update(() => {
      $getRoot().clear();
    });
  }

  return (
    <div className="meoing-playground" data-read-only={readOnly || undefined}>
      <ToolbarPlugin
        editor={editor}
        activeEditor={activeEditor}
        setActiveEditor={setActiveEditor}
        setIsLinkEditMode={setIsLinkEditMode}
        setIsRubyEditMode={setIsRubyEditMode}
      />
      <div className="meoing-playground-utilities">
        {!readOnly ? (
          <InsertMenu
            language={language}
            open={insertMenuOpen}
            onClose={() => setInsertMenuOpen(false)}
            onToggle={() => setInsertMenuOpen((current) => !current)}
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
      <FindReplace open={findOpen} onClose={() => setFindOpen(false)} />
      <div className="editor-container">
        <SlashMenuPlugin language={language} />
        <MarkdownShortcutPlugin />
        <DocumentChangePlugin onChange={onChange} />
        <div className="editor-scroller">
          <div className="editor" ref={setAnchorElement}>
            <ContentEditable placeholder="Write notes, examples, or type / to insert a block..." />
          </div>
        </div>
        <TableCellResizer />
        {anchorElement ? (
          <>
            <FloatingLinkEditorPlugin
              anchorElem={anchorElement}
              isLinkEditMode={isLinkEditMode}
              setIsLinkEditMode={setIsLinkEditMode}
            />
            {!readOnly ? (
              <>
                <DraggableBlockPlugin anchorElem={anchorElement} />
                <TableHoverActionsV2Plugin anchorElem={anchorElement} />
                <TableCellActionMenuPlugin anchorElem={anchorElement} cellMerge />
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
