import { useState } from "react";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalExtensionComposer } from "@lexical/react/LexicalExtensionComposer";
import { createDocumentEditorExtension } from "./document-editor/editorConfig";
import { DocumentToolbar } from "./document-editor/DocumentToolbar";
import { EditorPlugins } from "./document-editor/EditorPlugins";

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

export function DocumentEditor({
  content,
  language,
  onChange,
  plainText,
}: DocumentEditorProps) {
  const [extension] = useState(() => createDocumentEditorExtension(content, plainText));
  const [anchorElement, setAnchorElement] = useState<HTMLDivElement | null>(null);
  const [contextBarElement, setContextBarElement] = useState<HTMLDivElement | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [tocVisible, setTocVisible] = useState(false);

  return (
    <div className={`document-editor${readOnly ? " is-read-only" : ""}`}>
      <LexicalExtensionComposer extension={extension} contentEditable={null}>
        <DocumentToolbar
          language={language}
          readOnly={readOnly}
          tocVisible={tocVisible}
          onToggleReadOnly={() => setReadOnly((current) => !current)}
          onToggleToc={() => setTocVisible((current) => !current)}
        />
        <div className="document-editor-context-bar" ref={setContextBarElement} />
        <div className="document-editor-body">
          <div className="document-editor-surface" ref={setAnchorElement}>
            <ContentEditable
              className="document-editor-input"
              aria-label="Document content"
              aria-placeholder="Write notes, examples, or a short dialogue"
              placeholder={(
                <div className="document-editor-placeholder">
                  Write notes, examples, or type / to insert a block...
                </div>
              )}
            />
          </div>
        </div>
        <EditorPlugins
          anchorElement={anchorElement}
          contextBarElement={contextBarElement}
          language={language}
          onChange={onChange}
          onCloseToc={() => setTocVisible(false)}
          readOnly={readOnly}
          tocVisible={tocVisible}
        />
      </LexicalExtensionComposer>
    </div>
  );
}
