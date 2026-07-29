import { useRef, useState } from "react";
import {
  BookOpenText,
  Download,
  Eye,
  EyeOff,
  FileDown,
  FileJson,
  FileText,
  Trash2,
  Upload,
} from "lucide-react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  downloadTextFile,
  exportEditorContent,
  importEditorContent,
  type DocumentTransferFormat,
} from "./editorUtils";

interface FileMenuProps {
  onClose: () => void;
  onToggle: (trigger: HTMLButtonElement) => void;
  open: boolean;
  readOnly: boolean;
  tocVisible: boolean;
  onClear: () => void;
  onToggleReadOnly: () => void;
  onToggleToc: () => void;
}

const formatDetails: Record<DocumentTransferFormat, {
  extension: string;
  mime: string;
  name: string;
}> = {
  html: { extension: "html", mime: "text/html", name: "HTML" },
  json: { extension: "json", mime: "application/json", name: "JSON" },
  markdown: { extension: "md", mime: "text/markdown", name: "Markdown" },
};

export function FileMenu({
  onClose,
  onToggle,
  open,
  readOnly,
  tocVisible,
  onClear,
  onToggleReadOnly,
  onToggleToc,
}: FileMenuProps) {
  const [editor] = useLexicalComposerContext();
  const [status, setStatus] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const importFormatRef = useRef<DocumentTransferFormat>("json");

  function exportFile(format: DocumentTransferFormat) {
    const details = formatDetails[format];
    downloadTextFile(
      `meoi-document.${details.extension}`,
      exportEditorContent(editor, format),
      details.mime,
    );
    setStatus(`Exported ${details.name}`);
    onClose();
  }

  function chooseImport(format: DocumentTransferFormat) {
    importFormatRef.current = format;
    onClose();
    inputRef.current?.click();
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    const format = importFormatRef.current;
    try {
      const source = await file.text();
      importEditorContent(editor, format, source);
      setStatus(`Imported ${formatDetails[format].name}`);
      onClose();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The document could not be imported.");
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="document-file-menu">
      <button
        type="button"
        className={open ? "is-active" : ""}
        aria-label="Document tools"
        title="Document tools"
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => onToggle(event.currentTarget)}
      >
        <FileDown size={17} />
      </button>
      {open ? (
        <div className="document-toolbar-popover document-file-popover" role="menu">
          <p>Import</p>
          <button type="button" role="menuitem" onClick={() => chooseImport("json")}>
            <FileJson size={16} /> JSON
          </button>
          <button type="button" role="menuitem" onClick={() => chooseImport("html")}>
            <FileText size={16} /> HTML
          </button>
          <button type="button" role="menuitem" onClick={() => chooseImport("markdown")}>
            <Upload size={16} /> Markdown
          </button>
          <p>Export</p>
          <button type="button" role="menuitem" onClick={() => exportFile("json")}>
            <FileJson size={16} /> JSON
          </button>
          <button type="button" role="menuitem" onClick={() => exportFile("html")}>
            <Download size={16} /> HTML
          </button>
          <button type="button" role="menuitem" onClick={() => exportFile("markdown")}>
            <Download size={16} /> Markdown
          </button>
          <span className="document-menu-divider" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={tocVisible}
            onClick={() => {
              onToggleToc();
              onClose();
            }}
          >
            <BookOpenText size={16} /> Document outline (H1-H3)
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={readOnly}
            onClick={() => {
              onToggleReadOnly();
              onClose();
            }}
          >
            {readOnly ? <EyeOff size={16} /> : <Eye size={16} />}
            {readOnly ? "Resume editing" : "Read-only mode"}
          </button>
          <button
            className="is-danger"
            type="button"
            role="menuitem"
            onClick={() => {
              onClear();
              onClose();
            }}
          >
            <Trash2 size={16} /> Clear document
          </button>
        </div>
      ) : null}
      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        accept=".json,.html,.htm,.md,.markdown,application/json,text/html,text/markdown"
        onChange={(event) => void importFile(event.target.files?.[0])}
      />
      <span className="visually-hidden" role="status" aria-live="polite">{status}</span>
    </div>
  );
}
