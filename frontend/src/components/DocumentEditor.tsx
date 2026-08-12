import { useState } from "react";
import { LexicalExtensionComposer } from "@lexical/react/LexicalExtensionComposer";
import { createDocumentEditorExtension } from "./document-editor/editorConfig";
import { SettingsContext } from "./document-editor/playground/context/SettingsContext";
import { ToolbarContext } from "./document-editor/playground/context/ToolbarContext";
import { MeoingPlaygroundEditor } from "./document-editor/MeoingPlaygroundEditor";

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
  const [readOnly, setReadOnly] = useState(false);

  return (
    <div className={`document-editor${readOnly ? " is-read-only" : ""}`}>
      <LexicalExtensionComposer extension={extension} contentEditable={null}>
        <SettingsContext>
          <ToolbarContext>
            <MeoingPlaygroundEditor
              language={language}
              onChange={onChange}
              readOnly={readOnly}
              onToggleReadOnly={() => setReadOnly((current) => !current)}
            />
          </ToolbarContext>
        </SettingsContext>
      </LexicalExtensionComposer>
    </div>
  );
}
