import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
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
  ChevronDown,
  CircleHelp,
  Code2,
  Eraser,
  Highlighter,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Languages,
  Link2,
  Mic,
  Minus,
  MoreHorizontal,
  Plus,
  Redo2,
  RemoveFormatting,
  Search,
  Strikethrough,
  Subscript,
  Superscript,
  Type,
  Underline,
  Undo2,
  X,
} from "lucide-react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_LOW,
  FORMAT_TEXT_COMMAND,
  REDO_COMMAND,
  SELECTION_CHANGE_COMMAND,
  UNDO_COMMAND,
  type ElementFormatType,
  type LexicalNode,
  type TextFormatType,
} from "lexical";
import { $isCodeNode } from "@lexical/code-core";
import { $isLinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import { $isListNode } from "@lexical/list";
import {
  $getSelectionStyleValueForProperty,
} from "@lexical/selection";
import {
  $isHeadingNode,
  $isQuoteNode,
} from "@lexical/rich-text";
import { $isTableSelection } from "@lexical/table";
import { languageTagForSpeech } from "../../learning/speech";
import { FileMenu } from "./FileMenu";
import { FindReplace } from "./FindReplace";
import { InsertMenu } from "./InsertMenu";
import { ShortcutsPlugin } from "./ShortcutsPlugin";
import { sanitizeLinkUrl } from "./editorUtils";
import { $createRubyNode } from "./nodes/RubyNode";
import {
  SHORTCUT_ENTRIES,
  shortcutKeys,
  type ShortcutEntry,
} from "./shortcuts";
import {
  applySelectionStyle,
  changeFontSize,
  clearSelectionFormatting,
  formatBlock,
  indentSelection,
  outdentSelection,
  setSelectionAlignment,
  setSelectionDirection,
  type BlockType,
} from "./toolbarCommands";
import {
  toggleToolbarMenu,
  type ToolbarMenuId,
} from "./toolbarState";

interface ToolbarState {
  alignment: ElementFormatType;
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
  alignment: "left",
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

const alignmentOptions: Array<{
  icon: typeof AlignLeft;
  label: string;
  value: ElementFormatType;
}> = [
  { icon: AlignLeft, label: "Left align", value: "left" },
  { icon: AlignCenter, label: "Center align", value: "center" },
  { icon: AlignRight, label: "Right align", value: "right" },
  { icon: AlignJustify, label: "Justify align", value: "justify" },
];

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

function nearestBlock(node: LexicalNode): LexicalNode {
  let current = node;
  let parent = current.getParent();
  while (parent && parent.getType() !== "root" && parent.getType() !== "tablecell") {
    current = parent;
    parent = current.getParent();
  }
  return current;
}

function selectionAnchorNode(): LexicalNode | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) && !$isTableSelection(selection)) return null;
  const anchor = selection.anchor.getNode();
  if ($isTableSelection(selection) && $isElementNode(anchor)) {
    return anchor.getFirstDescendant() ?? anchor;
  }
  return anchor;
}

function findBlockType(): BlockType {
  const anchor = selectionAnchorNode();
  if (!anchor) return "paragraph";
  const element = nearestBlock(anchor);
  if ($isHeadingNode(element)) {
    const tag = element.getTag();
    return tag === "h1" || tag === "h2" || tag === "h3" ? tag : "paragraph";
  }
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

function findAlignment(): ElementFormatType {
  const anchor = selectionAnchorNode();
  if (!anchor) return "left";
  const element = nearestBlock(anchor);
  return $isElementNode(element) ? element.getFormatType() || "left" : "left";
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

function blockShortcut(blockType: BlockType): string | undefined {
  if (blockType === "code") return shortcutKeys("code-block");
  if (blockType === "paragraph"
    || blockType === "h1"
    || blockType === "h2"
    || blockType === "h3"
    || blockType === "number"
    || blockType === "bullet"
    || blockType === "check"
    || blockType === "quote") {
    return shortcutKeys(blockType);
  }
  return undefined;
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
  const [activeMenu, setActiveMenu] = useState<ToolbarMenuId | null>(null);
  const [linkInput, setLinkInput] = useState("");
  const [listening, setListening] = useState(false);
  const toolbarShellRef = useRef<HTMLDivElement>(null);
  const activeTriggerRef = useRef<HTMLElement | null>(null);
  const linkTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusFrameRef = useRef<number | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const closeMenu = useCallback((restoreFocus = false) => {
    setActiveMenu(null);
    if (!restoreFocus || !activeTriggerRef.current) return;
    const trigger = activeTriggerRef.current;
    if (restoreFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(restoreFocusFrameRef.current);
    }
    restoreFocusFrameRef.current = window.requestAnimationFrame(() => {
      trigger.focus();
      restoreFocusFrameRef.current = null;
    });
  }, []);

  const toggleMenu = useCallback((
    menu: ToolbarMenuId,
    trigger: HTMLButtonElement,
  ) => {
    activeTriggerRef.current = trigger;
    const next = toggleToolbarMenu(activeMenu, menu);
    if (next) setActiveMenu(next);
    else closeMenu(true);
  }, [activeMenu, closeMenu]);

  const openLinkEditor = useCallback(() => {
    setLinkInput(toolbarState.linkUrl);
    if (!activeMenu) activeTriggerRef.current = editor.getRootElement();
    setActiveMenu("link");
  }, [activeMenu, editor, toolbarState.linkUrl]);

  useEffect(() => {
    function updateToolbar() {
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) && !$isTableSelection(selection)) return;
        const formats = { ...defaultFormats };
        for (const format of Object.keys(formats) as TextFormatType[]) {
          formats[format] = selection.hasFormat(format);
        }
        const alignment = findAlignment();
        const blockType = findBlockType();
        const color = $getSelectionStyleValueForProperty(selection, "color", "");
        const fontFamily = $getSelectionStyleValueForProperty(selection, "font-family", "");
        const fontSize = $getSelectionStyleValueForProperty(selection, "font-size", "");
        const highlight = $getSelectionStyleValueForProperty(selection, "background-color", "");
        const linkUrl = findLinkUrl();
        setToolbarState((current) => ({
          ...current,
          alignment,
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

  useEffect(() => {
    if (!activeMenu) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      if (toolbarShellRef.current?.contains(event.target as Node)) return;
      closeMenu(false);
    }
    function handleMenuKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeMenu(true);
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, select, textarea")) return;
      const items = Array.from(
        toolbarShellRef.current?.querySelectorAll<HTMLButtonElement>(
          '[role="menu"] button:not(:disabled)',
        ) ?? [],
      );
      if (!items.length) return;
      const currentIndex = target ? items.indexOf(target as HTMLButtonElement) : -1;
      let nextIndex = 0;
      if (event.key === "End") nextIndex = items.length - 1;
      else if (event.key === "ArrowUp") {
        nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
      } else if (event.key === "ArrowDown") {
        nextIndex = currentIndex >= items.length - 1 ? 0 : currentIndex + 1;
      }
      event.preventDefault();
      items[nextIndex]?.focus();
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    window.addEventListener("keydown", handleMenuKeyboard, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      window.removeEventListener("keydown", handleMenuKeyboard, true);
    };
  }, [activeMenu, closeMenu]);

  useEffect(() => () => {
    recognitionRef.current?.stop();
    if (restoreFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(restoreFocusFrameRef.current);
    }
  }, []);

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
    closeMenu(true);
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

  const alignment = alignmentOptions.find((option) => option.value === toolbarState.alignment)
    ?? alignmentOptions[0];
  const AlignmentIcon = alignment.icon;
  const numericFontSize = Number.parseInt(toolbarState.fontSize, 10) || 17;

  function runMenuCommand(command: () => void) {
    command();
    closeMenu(true);
  }

  return (
    <div className="document-editor-toolbar-shell" ref={toolbarShellRef}>
      <div className="document-editor-toolbar" role="toolbar" aria-label="Document formatting">
        <div className="document-editor-toolbar-group document-toolbar-history-group">
          <ToolbarButton
            label="Undo"
            shortcut={shortcutKeys("undo")}
            disabled={!toolbarState.canUndo || readOnly}
            onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}
          >
            <Undo2 size={17} />
          </ToolbarButton>
          <ToolbarButton
            label="Redo"
            shortcut={shortcutKeys("redo")}
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
            title={`Block type${blockShortcut(toolbarState.blockType) ? ` (${blockShortcut(toolbarState.blockType)})` : ""}`}
            onChange={(event) => formatBlock(
              editor,
              toolbarState.blockType,
              event.target.value as BlockType,
            )}
          >
            {blockOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>

        <div className="document-editor-toolbar-group document-toolbar-font-group">
          <Type size={16} aria-hidden="true" />
          <select
            value={toolbarState.fontFamily}
            disabled={readOnly}
            aria-label="Font family"
            onChange={(event) => applySelectionStyle(editor, "font-family", event.target.value)}
          >
            {fontOptions.map((option) => (
              <option key={option.label} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>

        <div className="document-editor-toolbar-group document-toolbar-size-group">
          <ToolbarButton
            label="Decrease font size"
            shortcut={shortcutKeys("font-decrease")}
            disabled={readOnly || numericFontSize <= 8}
            onClick={() => changeFontSize(editor, toolbarState.fontSize, -1)}
          >
            <Minus size={15} />
          </ToolbarButton>
          <input
            className="document-toolbar-font-size-input"
            type="number"
            min={8}
            max={72}
            value={numericFontSize}
            disabled={readOnly}
            aria-label="Font size"
            onChange={(event) => {
              const value = Math.min(72, Math.max(8, Number(event.target.value) || 17));
              applySelectionStyle(editor, "font-size", `${value}px`);
            }}
          />
          <ToolbarButton
            label="Increase font size"
            shortcut={shortcutKeys("font-increase")}
            disabled={readOnly || numericFontSize >= 72}
            onClick={() => changeFontSize(editor, toolbarState.fontSize, 1)}
          >
            <Plus size={15} />
          </ToolbarButton>
        </div>

        <div className="document-editor-toolbar-group document-toolbar-primary-group">
          <ToolbarButton
            label="Bold"
            shortcut={shortcutKeys("bold")}
            disabled={readOnly}
            pressed={toolbarState.formats.bold}
            onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold")}
          >
            <Bold size={17} />
          </ToolbarButton>
          <ToolbarButton
            label="Italic"
            shortcut={shortcutKeys("italic")}
            disabled={readOnly}
            pressed={toolbarState.formats.italic}
            onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic")}
          >
            <Italic size={17} />
          </ToolbarButton>
          <ToolbarButton
            label="Underline"
            shortcut={shortcutKeys("underline")}
            disabled={readOnly}
            pressed={toolbarState.formats.underline}
            onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "underline")}
          >
            <Underline size={17} />
          </ToolbarButton>
          <ToolbarButton
            className="document-toolbar-desktop-primary-extra"
            label="Inline code"
            shortcut={shortcutKeys("inline-code")}
            disabled={readOnly}
            pressed={toolbarState.formats.code}
            onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "code")}
          >
            <Code2 size={17} />
          </ToolbarButton>
          <div className="document-link-menu document-toolbar-desktop-primary-extra">
            <ToolbarButton
              buttonRef={linkTriggerRef}
              label="Link"
              shortcut={shortcutKeys("link")}
              disabled={readOnly}
              pressed={Boolean(toolbarState.linkUrl) || activeMenu === "link"}
              onClick={(trigger) => {
                setLinkInput(toolbarState.linkUrl);
                toggleMenu("link", trigger);
              }}
            >
              <Link2 size={17} />
            </ToolbarButton>
          </div>
        </div>

        <div className="document-editor-toolbar-group document-toolbar-color-group">
          <label className="document-color-control" title="Text color">
            <Baseline size={17} />
            <input
              type="color"
              value={toolbarState.color}
              disabled={readOnly}
              aria-label="Text color"
              onChange={(event) => applySelectionStyle(editor, "color", event.target.value)}
            />
          </label>
          <label className="document-color-control" title="Highlight color">
            <Highlighter size={17} />
            <input
              type="color"
              value={toolbarState.highlight}
              disabled={readOnly}
              aria-label="Highlight color"
              onChange={(event) => applySelectionStyle(editor, "background-color", event.target.value)}
            />
          </label>
        </div>

        <div className="document-editor-toolbar-group document-toolbar-format-menu document-more-menu">
          <ToolbarButton
            label="More formatting"
            pressed={activeMenu === "formatting"}
            onClick={(trigger) => toggleMenu("formatting", trigger)}
          >
            <MoreHorizontal size={17} />
          </ToolbarButton>
          {activeMenu === "formatting" ? (
            <div className="document-toolbar-popover document-more-popover" role="menu">
              <header>
                <strong>More formatting</strong>
                <button type="button" onClick={() => closeMenu(true)} aria-label="Close more formatting">
                  <X size={16} /> Close
                </button>
              </header>
              <div className="document-more-mobile-controls">
                <label>
                  <span>Font</span>
                  <select
                    value={toolbarState.fontFamily}
                    disabled={readOnly}
                    aria-label="Mobile font family"
                    onChange={(event) => applySelectionStyle(editor, "font-family", event.target.value)}
                  >
                    {fontOptions.map((option) => (
                      <option key={option.label} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <div className="document-more-mobile-size">
                  <button type="button" onClick={() => changeFontSize(editor, toolbarState.fontSize, -1)}>
                    <Minus size={15} />
                  </button>
                  <span>{numericFontSize}px</span>
                  <button type="button" onClick={() => changeFontSize(editor, toolbarState.fontSize, 1)}>
                    <Plus size={15} />
                  </button>
                </div>
                <label className="document-more-mobile-color">
                  <span>Text</span>
                  <input
                    type="color"
                    value={toolbarState.color}
                    onChange={(event) => applySelectionStyle(editor, "color", event.target.value)}
                  />
                </label>
                <label className="document-more-mobile-color">
                  <span>Highlight</span>
                  <input
                    type="color"
                    value={toolbarState.highlight}
                    onChange={(event) => applySelectionStyle(editor, "background-color", event.target.value)}
                  />
                </label>
              </div>
              <div className="document-more-grid">
                <MenuFormatButton
                  label="Strikethrough"
                  shortcut={shortcutKeys("strikethrough")}
                  icon={<Strikethrough size={17} />}
                  pressed={toolbarState.formats.strikethrough}
                  onClick={() => runMenuCommand(() => {
                    editor.dispatchCommand(FORMAT_TEXT_COMMAND, "strikethrough");
                  })}
                />
                <MenuFormatButton
                  label="Inline code"
                  shortcut={shortcutKeys("inline-code")}
                  icon={<Code2 size={17} />}
                  pressed={toolbarState.formats.code}
                  onClick={() => runMenuCommand(() => {
                    editor.dispatchCommand(FORMAT_TEXT_COMMAND, "code");
                  })}
                />
                <MenuFormatButton
                  label="Subscript"
                  shortcut={shortcutKeys("subscript")}
                  icon={<Subscript size={17} />}
                  pressed={toolbarState.formats.subscript}
                  onClick={() => runMenuCommand(() => {
                    editor.dispatchCommand(FORMAT_TEXT_COMMAND, "subscript");
                  })}
                />
                <MenuFormatButton
                  label="Superscript"
                  shortcut={shortcutKeys("superscript")}
                  icon={<Superscript size={17} />}
                  pressed={toolbarState.formats.superscript}
                  onClick={() => runMenuCommand(() => {
                    editor.dispatchCommand(FORMAT_TEXT_COMMAND, "superscript");
                  })}
                />
                <MenuFormatButton
                  label="Lowercase"
                  shortcut={shortcutKeys("lowercase")}
                  icon={<CaseLower size={17} />}
                  pressed={toolbarState.formats.lowercase}
                  onClick={() => runMenuCommand(() => {
                    editor.dispatchCommand(FORMAT_TEXT_COMMAND, "lowercase");
                  })}
                />
                <MenuFormatButton
                  label="Uppercase"
                  shortcut={shortcutKeys("uppercase")}
                  icon={<CaseUpper size={17} />}
                  pressed={toolbarState.formats.uppercase}
                  onClick={() => runMenuCommand(() => {
                    editor.dispatchCommand(FORMAT_TEXT_COMMAND, "uppercase");
                  })}
                />
                <MenuFormatButton
                  label="Capitalize"
                  shortcut={shortcutKeys("capitalize")}
                  icon={<CaseSensitive size={17} />}
                  pressed={toolbarState.formats.capitalize}
                  onClick={() => runMenuCommand(() => {
                    editor.dispatchCommand(FORMAT_TEXT_COMMAND, "capitalize");
                  })}
                />
                <MenuFormatButton
                  label="Clear formatting"
                  shortcut={shortcutKeys("clear-formatting")}
                  icon={<RemoveFormatting size={17} />}
                  onClick={() => runMenuCommand(() => clearSelectionFormatting(editor))}
                />
                <MenuFormatButton
                  label="Indent"
                  shortcut={shortcutKeys("indent")}
                  icon={<IndentIncrease size={17} />}
                  onClick={() => runMenuCommand(() => indentSelection(editor))}
                />
                <MenuFormatButton
                  label="Outdent"
                  shortcut={shortcutKeys("outdent")}
                  icon={<IndentDecrease size={17} />}
                  onClick={() => runMenuCommand(() => outdentSelection(editor))}
                />
                <MenuFormatButton
                  label="Left to right"
                  icon={<Languages size={17} />}
                  onClick={() => runMenuCommand(() => setSelectionDirection(editor, "ltr"))}
                />
                <MenuFormatButton
                  label="Right to left"
                  icon={<Languages size={17} />}
                  onClick={() => runMenuCommand(() => setSelectionDirection(editor, "rtl"))}
                />
                <MenuFormatButton
                  label="Ruby annotation"
                  icon={<Baseline size={17} />}
                  onClick={() => runMenuCommand(insertRuby)}
                />
                <MenuFormatButton
                  label="Clear inline styles"
                  icon={<Eraser size={17} />}
                  onClick={() => runMenuCommand(() => clearSelectionFormatting(editor))}
                />
                <div className="document-more-mobile-only document-more-mobile-alignments">
                  {alignmentOptions.map((option) => {
                    const Icon = option.icon;
                    return (
                      <MenuFormatButton
                        key={option.value}
                        label={option.label}
                        shortcut={shortcutKeys(option.value as ShortcutEntry["action"])}
                        icon={<Icon size={17} />}
                        pressed={toolbarState.alignment === option.value}
                        onClick={() => runMenuCommand(() => {
                          setSelectionAlignment(editor, option.value);
                        })}
                      />
                    );
                  })}
                </div>
                <MenuFormatButton
                  className="document-more-mobile-only"
                  label="Edit link"
                  shortcut={shortcutKeys("link")}
                  icon={<Link2 size={17} />}
                  onClick={openLinkEditor}
                />
                <MenuFormatButton
                  className="document-more-mobile-only"
                  label="Find and replace"
                  icon={<Search size={17} />}
                  onClick={() => setActiveMenu("find")}
                />
                <MenuFormatButton
                  className="document-more-mobile-only"
                  label={listening ? "Stop speech-to-text" : "Speech-to-text"}
                  icon={<Mic size={17} />}
                  onClick={() => {
                    toggleSpeech();
                    closeMenu(true);
                  }}
                />
                <MenuFormatButton
                  className="document-more-mobile-only"
                  label="Keyboard shortcuts"
                  icon={<CircleHelp size={17} />}
                  onClick={() => setActiveMenu("shortcuts")}
                />
              </div>
            </div>
          ) : null}
        </div>

        <div className="document-editor-toolbar-group document-toolbar-file-group">
          <FileMenu
            open={activeMenu === "file"}
            onClose={() => closeMenu(true)}
            onToggle={(trigger) => toggleMenu("file", trigger)}
            readOnly={readOnly}
            tocVisible={tocVisible}
            onClear={clearDocument}
            onToggleReadOnly={onToggleReadOnly}
            onToggleToc={onToggleToc}
          />
        </div>

        <div className="document-editor-toolbar-group document-toolbar-insert-group">
          <InsertMenu
            language={language}
            open={activeMenu === "insert"}
            onClose={() => closeMenu(true)}
            onToggle={(trigger) => toggleMenu("insert", trigger)}
          />
        </div>

        <div className="document-editor-toolbar-group document-toolbar-alignment-menu">
          <div className="document-alignment-menu">
            <ToolbarButton
              className="document-toolbar-wide-button"
              label={alignment.label}
              pressed={activeMenu === "alignment"}
              onClick={(trigger) => toggleMenu("alignment", trigger)}
            >
              <AlignmentIcon size={17} />
              <span>{alignment.label}</span>
              <ChevronDown size={14} />
            </ToolbarButton>
            {activeMenu === "alignment" ? (
              <div className="document-toolbar-popover document-alignment-popover" role="menu">
                {alignmentOptions.map((option) => {
                  const Icon = option.icon;
                  return (
                    <MenuFormatButton
                      key={option.value}
                      label={option.label}
                      shortcut={shortcutKeys(option.value as ShortcutEntry["action"])}
                      icon={<Icon size={17} />}
                      pressed={toolbarState.alignment === option.value}
                      onClick={() => runMenuCommand(() => {
                        setSelectionAlignment(editor, option.value);
                      })}
                    />
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>

        <div className="document-editor-toolbar-group document-toolbar-utility-group">
          <ToolbarButton
            className="document-toolbar-desktop-utility"
            label="Find and replace"
            pressed={activeMenu === "find"}
            onClick={(trigger) => {
              if (tocVisible && activeMenu !== "find") onToggleToc();
              toggleMenu("find", trigger);
            }}
          >
            <Search size={17} />
          </ToolbarButton>
          <ToolbarButton
            className="document-toolbar-desktop-utility"
            label={listening ? "Stop speech-to-text" : "Speech-to-text"}
            disabled={readOnly || !speechRecognitionConstructor()}
            pressed={listening}
            onClick={toggleSpeech}
          >
            <Mic size={17} />
          </ToolbarButton>
          <div className="document-shortcuts-menu document-toolbar-desktop-utility">
            <ToolbarButton
              label="Keyboard shortcuts"
              pressed={activeMenu === "shortcuts"}
              onClick={(trigger) => {
                if (tocVisible && activeMenu !== "shortcuts") onToggleToc();
                toggleMenu("shortcuts", trigger);
              }}
            >
              <CircleHelp size={17} />
            </ToolbarButton>
          </div>
        </div>
      </div>

      {activeMenu === "link" ? (
        <div
          className="document-toolbar-popover document-link-popover"
          role="dialog"
          aria-label="Edit link"
        >
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
            onClick={() => runMenuCommand(() => {
              editor.dispatchCommand(TOGGLE_LINK_COMMAND, null);
            })}
          >
            Remove
          </button>
        </div>
      ) : null}
      <FindReplace
        open={activeMenu === "find"}
        onClose={() => closeMenu(true)}
      />
      {activeMenu === "shortcuts" ? (
        <div className="document-shortcuts-host">
          <ShortcutsHelp onClose={() => closeMenu(true)} />
        </div>
      ) : null}
      <ShortcutsPlugin
        blockType={toolbarState.blockType}
        fontSize={toolbarState.fontSize}
        onEditLink={openLinkEditor}
      />
    </div>
  );
}

function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="document-toolbar-popover document-shortcuts-popover" role="dialog" aria-label="Keyboard shortcuts">
      <header>
        <div>
          <strong>Keyboard shortcuts</strong>
          <span>Lexical Playground shortcuts</span>
        </div>
        <button type="button" onClick={onClose} aria-label="Close keyboard shortcuts">
          <X size={16} />
        </button>
      </header>
      <table>
        <thead>
          <tr><th>Action</th><th>Shortcut</th></tr>
        </thead>
        <tbody>
          {SHORTCUT_ENTRIES.map((entry) => (
            <tr key={entry.action}>
              <td>{entry.label}</td>
              <td><kbd>{entry.keys}</kbd></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ToolbarButton({
  buttonRef,
  children,
  className = "",
  disabled,
  label,
  onClick,
  pressed,
  shortcut,
}: {
  buttonRef?: Ref<HTMLButtonElement>;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  label: string;
  onClick: (trigger: HTMLButtonElement) => void;
  pressed?: boolean;
  shortcut?: string;
}) {
  const title = shortcut ? `${label} (${shortcut})` : label;
  return (
    <button
      className={`${pressed ? "is-active " : ""}${className}`.trim()}
      ref={buttonRef}
      type="button"
      disabled={disabled}
      aria-label={title}
      aria-pressed={pressed}
      title={title}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => onClick(event.currentTarget)}
    >
      {children}
    </button>
  );
}

function MenuFormatButton({
  className = "",
  icon,
  label,
  onClick,
  pressed = false,
  shortcut,
}: {
  className?: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  pressed?: boolean;
  shortcut?: string;
}) {
  return (
    <button
      className={`${pressed ? "is-active " : ""}${className}`.trim()}
      type="button"
      role="menuitem"
      aria-pressed={pressed}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {pressed ? <Check size={14} /> : icon}
      <span>{label}</span>
      {shortcut ? <kbd>{shortcut}</kbd> : null}
    </button>
  );
}
