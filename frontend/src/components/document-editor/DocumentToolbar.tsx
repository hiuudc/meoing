import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  CaseLower,
  CaseSensitive,
  CaseUpper,
  Check,
  Code2,
  Eraser,
  Highlighter,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Languages,
  Link2,
  List as ListIcon,
  ListChecks,
  ListOrdered,
  Mic,
  MoreHorizontal,
  Redo2,
  RemoveFormatting,
  Search,
  Smile,
  Strikethrough,
  Subscript,
  Superscript,
  Underline,
  Undo2,
} from "lucide-react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createParagraphNode,
  $getRoot,
  $isElementNode,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_LOW,
  FORMAT_ELEMENT_COMMAND,
  FORMAT_TEXT_COMMAND,
  INDENT_CONTENT_COMMAND,
  OUTDENT_CONTENT_COMMAND,
  REDO_COMMAND,
  SELECTION_CHANGE_COMMAND,
  UNDO_COMMAND,
  type ElementFormatType,
  type TextFormatType,
} from "lexical";
import { $createCodeNode, $isCodeNode } from "@lexical/code-core";
import {
  $getSelectionStyleValueForProperty,
  $patchStyleText,
  $setBlocksType,
} from "@lexical/selection";
import {
  $createHeadingNode,
  $createQuoteNode,
  $isHeadingNode,
  $isQuoteNode,
  type HeadingTagType,
} from "@lexical/rich-text";
import {
  $isLinkNode,
  TOGGLE_LINK_COMMAND,
} from "@lexical/link";
import {
  $isListNode,
  INSERT_CHECK_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  REMOVE_LIST_COMMAND,
} from "@lexical/list";
import { FileMenu } from "./FileMenu";
import { FindReplace } from "./FindReplace";
import { InsertMenu } from "./InsertMenu";
import { $createRubyNode } from "./nodes/RubyNode";
import { sanitizeLinkUrl } from "./editorUtils";
import { languageTagForSpeech } from "../../learning/speech";

type BlockType = "paragraph" | HeadingTagType | "quote" | "code" | "bullet" | "number" | "check";

interface ToolbarState {
  blockType: BlockType;
  canRedo: boolean;
  canUndo: boolean;
  color: string;
  fontFamily: string;
  fontSize: string;
  formats: Record<TextFormatType, boolean>;
  highlight: string;
  linkUrl: string;
}

interface DocumentToolbarProps {
  language: string;
  readOnly: boolean;
  tocVisible: boolean;
  onToggleReadOnly: () => void;
  onToggleToc: () => void;
}

const defaultFormats: Record<TextFormatType, boolean> = {
  bold: false,
  capitalize: false,
  code: false,
  highlight: false,
  italic: false,
  lowercase: false,
  strikethrough: false,
  subscript: false,
  superscript: false,
  underline: false,
  uppercase: false,
};

const initialToolbarState: ToolbarState = {
  blockType: "paragraph",
  canRedo: false,
  canUndo: false,
  color: "#F1EFF5",
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: "17px",
  formats: defaultFormats,
  highlight: "#5C4768",
  linkUrl: "",
};

const blockOptions: Array<{ label: string; value: BlockType }> = [
  { label: "Paragraph", value: "paragraph" },
  { label: "Heading 1", value: "h1" },
  { label: "Heading 2", value: "h2" },
  { label: "Heading 3", value: "h3" },
  { label: "Quote", value: "quote" },
  { label: "Code block", value: "code" },
  { label: "Bulleted list", value: "bullet" },
  { label: "Numbered list", value: "number" },
  { label: "Checklist", value: "check" },
];

const fontOptions = [
  { label: "Sans", value: "Inter, system-ui, sans-serif" },
  { label: "Serif", value: "Georgia, 'Times New Roman', serif" },
  { label: "Mono", value: "'Cascadia Code', Consolas, monospace" },
  { label: "Japanese", value: "'Yu Gothic UI', 'Noto Sans JP', sans-serif" },
];

const fontSizeOptions = ["12px", "14px", "16px", "17px", "18px", "20px", "24px", "28px", "32px"];
const emojis = ["😀", "😂", "😍", "🤔", "👍", "👏", "🎉", "💡", "📌", "✅", "⭐", "🌸", "📚", "🗣️", "✍️"];

interface SpeechRecognitionEventLike {
  results: ArrayLike<{
    0: { transcript: string };
    isFinal: boolean;
  }>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  const speechWindow = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

function findBlockType(): BlockType {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return "paragraph";
  const anchorNode = selection.anchor.getNode();
  const element = anchorNode.getKey() === "root"
    ? anchorNode
    : anchorNode.getTopLevelElementOrThrow();
  if ($isHeadingNode(element)) return element.getTag();
  if ($isQuoteNode(element)) return "quote";
  if ($isCodeNode(element)) return "code";
  if ($isListNode(element)) {
    const listType = element.getListType();
    if (listType === "number") return "number";
    if (listType === "check") return "check";
    return "bullet";
  }
  return "paragraph";
}

function findLinkUrl(): string {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return "";
  const node = selection.anchor.getNode();
  if ($isLinkNode(node)) return node.getURL();
  const parent = node.getParent();
  return $isLinkNode(parent) ? parent.getURL() : "";
}

function normalizeColorInput(value: string, fallback: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

export function DocumentToolbar({
  language,
  readOnly,
  tocVisible,
  onToggleReadOnly,
  onToggleToc,
}: DocumentToolbarProps) {
  const [editor] = useLexicalComposerContext();
  const [toolbarState, setToolbarState] = useState(initialToolbarState);
  const [moreOpen, setMoreOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkInput, setLinkInput] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    function updateToolbar() {
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        const formats = { ...defaultFormats };
        for (const format of Object.keys(formats) as TextFormatType[]) {
          formats[format] = selection.hasFormat(format);
        }
        const blockType = findBlockType();
        const color = $getSelectionStyleValueForProperty(selection, "color", "");
        const fontFamily = $getSelectionStyleValueForProperty(selection, "font-family", "");
        const fontSize = $getSelectionStyleValueForProperty(selection, "font-size", "");
        const highlight = $getSelectionStyleValueForProperty(selection, "background-color", "");
        const linkUrl = findLinkUrl();
        setToolbarState((current) => ({
          ...current,
          blockType,
          color: normalizeColorInput(color, current.color),
          fontFamily: fontFamily || current.fontFamily,
          fontSize: fontSize || current.fontSize,
          formats,
          highlight: normalizeColorInput(highlight, current.highlight),
          linkUrl,
        }));
      });
    }

    const unregisterUpdate = editor.registerUpdateListener(updateToolbar);
    const unregisterSelection = editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        updateToolbar();
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    const unregisterUndo = editor.registerCommand(
      CAN_UNDO_COMMAND,
      (available) => {
        setToolbarState((current) => ({ ...current, canUndo: available }));
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    const unregisterRedo = editor.registerCommand(
      CAN_REDO_COMMAND,
      (available) => {
        setToolbarState((current) => ({ ...current, canRedo: available }));
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    updateToolbar();
    return () => {
      unregisterUpdate();
      unregisterSelection();
      unregisterUndo();
      unregisterRedo();
    };
  }, [editor]);

  useEffect(() => () => recognitionRef.current?.stop(), []);

  function formatBlock(blockType: BlockType) {
    if (blockType === "bullet") {
      editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
      return;
    }
    if (blockType === "number") {
      editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
      return;
    }
    if (blockType === "check") {
      editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined);
      return;
    }
    if (toolbarState.blockType === "bullet" || toolbarState.blockType === "number" || toolbarState.blockType === "check") {
      editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
    }
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      if (blockType === "paragraph") {
        $setBlocksType(selection, () => $createParagraphNode());
      } else if (blockType === "quote") {
        $setBlocksType(selection, () => $createQuoteNode());
      } else if (blockType === "code") {
        $setBlocksType(selection, () => $createCodeNode());
      } else {
        $setBlocksType(selection, () => $createHeadingNode(blockType));
      }
    });
  }

  function applyStyle(property: "background-color" | "color" | "font-family" | "font-size", value: string) {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) $patchStyleText(selection, { [property]: value });
    });
  }

  function setDirection(direction: "ltr" | "rtl") {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      const seen = new Set<string>();
      for (const node of selection.getNodes()) {
        const element = node.getTopLevelElementOrThrow();
        if (!$isElementNode(element) || seen.has(element.getKey())) continue;
        seen.add(element.getKey());
        element.setDirection(direction);
      }
    });
  }

  function clearFormatting() {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      for (const node of selection.getNodes()) {
        if ($isTextNode(node)) {
          node.setFormat(0);
          node.setStyle("");
        }
      }
    });
  }

  function clearDocument() {
    if (!window.confirm("Clear this document draft? This cannot be undone inside the editor.")) return;
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      root.append(paragraph);
      paragraph.select();
    });
  }

  function insertRuby() {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      selection.insertNodes([$createRubyNode(selection.getTextContent(), "")]);
    });
  }

  function applyLink() {
    const nextUrl = sanitizeLinkUrl(linkInput);
    if (!nextUrl) return;
    editor.dispatchCommand(TOGGLE_LINK_COMMAND, {
      rel: "noopener noreferrer",
      target: "_blank",
      url: nextUrl,
    });
    setLinkOpen(false);
  }

  function toggleSpeech() {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const Constructor = speechRecognitionConstructor();
    if (!Constructor) return;
    const recognition = new Constructor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = languageTagForSpeech(language);
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .filter((result) => result.isFinal)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ");
      if (!transcript) return;
      editor.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertText(`${transcript} `);
      });
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }

  return (
    <>
      <div className="document-editor-toolbar" role="toolbar" aria-label="Document formatting">
        <div className="document-editor-toolbar-group">
          <ToolbarButton
            label="Undo"
            disabled={!toolbarState.canUndo || readOnly}
            onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}
          >
            <Undo2 size={17} />
          </ToolbarButton>
          <ToolbarButton
            label="Redo"
            disabled={!toolbarState.canRedo || readOnly}
            onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)}
          >
            <Redo2 size={17} />
          </ToolbarButton>
        </div>

        <div className="document-editor-toolbar-group document-toolbar-block-group">
          <select
            value={toolbarState.blockType}
            disabled={readOnly}
            aria-label="Block type"
            onChange={(event) => formatBlock(event.target.value as BlockType)}
          >
            {blockOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>

        <div className="document-editor-toolbar-group document-toolbar-desktop-extra">
          <select
            value={toolbarState.fontFamily}
            disabled={readOnly}
            aria-label="Font family"
            onChange={(event) => applyStyle("font-family", event.target.value)}
          >
            {fontOptions.map((option) => (
              <option key={option.label} value={option.value}>{option.label}</option>
            ))}
          </select>
          <select
            value={fontSizeOptions.includes(toolbarState.fontSize) ? toolbarState.fontSize : "17px"}
            disabled={readOnly}
            aria-label="Font size"
            onChange={(event) => applyStyle("font-size", event.target.value)}
          >
            {fontSizeOptions.map((size) => (
              <option key={size} value={size}>{size.replace("px", "")}</option>
            ))}
          </select>
        </div>

        <div className="document-editor-toolbar-group">
          <ToolbarButton
            label="Bold"
            disabled={readOnly}
            pressed={toolbarState.formats.bold}
            onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold")}
          >
            <Bold size={17} />
          </ToolbarButton>
          <ToolbarButton
            label="Italic"
            disabled={readOnly}
            pressed={toolbarState.formats.italic}
            onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic")}
          >
            <Italic size={17} />
          </ToolbarButton>
          <ToolbarButton
            label="Underline"
            disabled={readOnly}
            pressed={toolbarState.formats.underline}
            onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "underline")}
          >
            <Underline size={17} />
          </ToolbarButton>
        </div>

        <div className="document-editor-toolbar-group document-toolbar-desktop-extra">
          <label className="document-color-control" title="Text color">
            <Baseline size={17} />
            <input
              type="color"
              value={toolbarState.color}
              disabled={readOnly}
              aria-label="Text color"
              onChange={(event) => applyStyle("color", event.target.value)}
            />
          </label>
          <label className="document-color-control" title="Highlight color">
            <Highlighter size={17} />
            <input
              type="color"
              value={toolbarState.highlight}
              disabled={readOnly}
              aria-label="Highlight color"
              onChange={(event) => applyStyle("background-color", event.target.value)}
            />
          </label>
        </div>

        <div className="document-editor-toolbar-group document-toolbar-desktop-extra">
          <ToolbarButton
            label="Bulleted list"
            disabled={readOnly}
            pressed={toolbarState.blockType === "bullet"}
            onClick={() => formatBlock("bullet")}
          >
            <ListIcon size={17} />
          </ToolbarButton>
          <ToolbarButton
            label="Numbered list"
            disabled={readOnly}
            pressed={toolbarState.blockType === "number"}
            onClick={() => formatBlock("number")}
          >
            <ListOrdered size={17} />
          </ToolbarButton>
          <ToolbarButton
            label="Checklist"
            disabled={readOnly}
            pressed={toolbarState.blockType === "check"}
            onClick={() => formatBlock("check")}
          >
            <ListChecks size={17} />
          </ToolbarButton>
        </div>

        <div className="document-editor-toolbar-group document-toolbar-desktop-extra">
          {([
            ["left", AlignLeft],
            ["center", AlignCenter],
            ["right", AlignRight],
            ["justify", AlignJustify],
          ] as Array<[ElementFormatType, typeof AlignLeft]>).map(([alignment, Icon]) => (
            <ToolbarButton
              key={alignment}
              label={`${alignment} align`}
              disabled={readOnly}
              onClick={() => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, alignment)}
            >
              <Icon size={17} />
            </ToolbarButton>
          ))}
        </div>

        <div className="document-editor-toolbar-group document-toolbar-action-group">
          <div className="document-link-menu">
            <ToolbarButton
              label="Link"
              disabled={readOnly}
              pressed={Boolean(toolbarState.linkUrl)}
              onClick={() => {
                const current = toolbarState.linkUrl;
                setLinkInput(current);
                setLinkOpen((open) => !open);
              }}
            >
              <Link2 size={17} />
            </ToolbarButton>
            {linkOpen ? (
              <div className="document-toolbar-popover document-link-popover">
                <label>
                  <span>Link URL</span>
                  <input
                    autoFocus
                    type="url"
                    value={linkInput}
                    onChange={(event) => setLinkInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        applyLink();
                      }
                    }}
                    placeholder="https://..."
                  />
                </label>
                <button type="button" onClick={applyLink}>Apply</button>
                <button
                  type="button"
                  disabled={!toolbarState.linkUrl}
                  onClick={() => {
                    editor.dispatchCommand(TOGGLE_LINK_COMMAND, null);
                    setLinkOpen(false);
                  }}
                >
                  Remove
                </button>
              </div>
            ) : null}
          </div>
          <InsertMenu language={language} />
        </div>

        <div className="document-editor-toolbar-group document-toolbar-utility-group">
          <ToolbarButton label="Find and replace" pressed={findOpen} onClick={() => setFindOpen((open) => !open)}>
            <Search size={17} />
          </ToolbarButton>
          <ToolbarButton
            label={listening ? "Stop speech-to-text" : "Speech-to-text"}
            disabled={readOnly || !speechRecognitionConstructor()}
            pressed={listening}
            onClick={toggleSpeech}
          >
            <Mic size={17} />
          </ToolbarButton>
          <div className="document-emoji-menu">
            <ToolbarButton
              label="Emoji"
              disabled={readOnly}
              pressed={emojiOpen}
              onClick={() => setEmojiOpen((open) => !open)}
            >
              <Smile size={17} />
            </ToolbarButton>
            {emojiOpen ? (
              <div className="document-toolbar-popover document-emoji-popover" role="menu">
                {emojis.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      editor.update(() => {
                        const selection = $getSelection();
                        if ($isRangeSelection(selection)) selection.insertText(emoji);
                      });
                      setEmojiOpen(false);
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <FileMenu
            readOnly={readOnly}
            tocVisible={tocVisible}
            onClear={clearDocument}
            onToggleReadOnly={onToggleReadOnly}
            onToggleToc={onToggleToc}
          />
          <div className="document-more-menu">
            <ToolbarButton
              label="More formatting"
              pressed={moreOpen}
              onClick={() => setMoreOpen((open) => !open)}
            >
              <MoreHorizontal size={17} />
            </ToolbarButton>
            {moreOpen ? (
              <div className="document-toolbar-popover document-more-popover">
                <header>
                  <strong>More formatting</strong>
                  <button type="button" onClick={() => setMoreOpen(false)} aria-label="Close more formatting">Close</button>
                </header>
                <div className="document-more-grid">
                  <MenuFormatButton
                    label="Strikethrough"
                    icon={<Strikethrough size={17} />}
                    pressed={toolbarState.formats.strikethrough}
                    onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "strikethrough")}
                  />
                  <MenuFormatButton
                    label="Inline code"
                    icon={<Code2 size={17} />}
                    pressed={toolbarState.formats.code}
                    onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "code")}
                  />
                  <MenuFormatButton
                    label="Subscript"
                    icon={<Subscript size={17} />}
                    pressed={toolbarState.formats.subscript}
                    onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "subscript")}
                  />
                  <MenuFormatButton
                    label="Superscript"
                    icon={<Superscript size={17} />}
                    pressed={toolbarState.formats.superscript}
                    onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "superscript")}
                  />
                  <MenuFormatButton
                    label="Lowercase"
                    icon={<CaseLower size={17} />}
                    pressed={toolbarState.formats.lowercase}
                    onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "lowercase")}
                  />
                  <MenuFormatButton
                    label="Uppercase"
                    icon={<CaseUpper size={17} />}
                    pressed={toolbarState.formats.uppercase}
                    onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "uppercase")}
                  />
                  <MenuFormatButton
                    label="Capitalize"
                    icon={<CaseSensitive size={17} />}
                    pressed={toolbarState.formats.capitalize}
                    onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "capitalize")}
                  />
                  <MenuFormatButton
                    label="Clear formatting"
                    icon={<RemoveFormatting size={17} />}
                    onClick={clearFormatting}
                  />
                  <MenuFormatButton
                    label="Indent"
                    icon={<IndentIncrease size={17} />}
                    onClick={() => editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined)}
                  />
                  <MenuFormatButton
                    label="Outdent"
                    icon={<IndentDecrease size={17} />}
                    onClick={() => editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined)}
                  />
                  <MenuFormatButton
                    label="Left to right"
                    icon={<Languages size={17} />}
                    onClick={() => setDirection("ltr")}
                  />
                  <MenuFormatButton
                    label="Right to left"
                    icon={<Languages size={17} />}
                    onClick={() => setDirection("rtl")}
                  />
                  <MenuFormatButton
                    label="Ruby annotation"
                    icon={<Baseline size={17} />}
                    onClick={insertRuby}
                  />
                  <MenuFormatButton
                    label="Clear inline styles"
                    icon={<Eraser size={17} />}
                    onClick={clearFormatting}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <FindReplace open={findOpen} onClose={() => setFindOpen(false)} />
    </>
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

function MenuFormatButton({
  icon,
  label,
  onClick,
  pressed = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  pressed?: boolean;
}) {
  return (
    <button
      className={pressed ? "is-active" : ""}
      type="button"
      aria-pressed={pressed}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {pressed ? <Check size={14} /> : icon}
      <span>{label}</span>
    </button>
  );
}
