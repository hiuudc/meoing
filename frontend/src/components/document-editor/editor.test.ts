// @vitest-environment jsdom
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $setSelection,
  IS_APPLE,
  createEditor,
  type Klass,
  type LexicalNode,
} from "lexical";
import { CodeHighlightNode, CodeNode } from "@lexical/code-core";
import { LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import {
  $createTableNodeWithDimensions,
  $createTableSelectionFrom,
  TableCellNode,
  TableNode,
  TableRowNode,
} from "@lexical/table";
import { describe, expect, it } from "vitest";
import {
  $createBilingualBlockNode,
  BilingualBlockNode,
} from "../BilingualBlockNode";
import { $getCurrentTableCellKey } from "./EditorPlugins";
import { findTextOffsets } from "./FindReplace";
import { documentEditorTheme } from "./editorConfig";
import {
  deriveDocumentPlainText,
  detectEmbedProvider,
  exportEditorContent,
  importEditorContent,
  isSupportedImageFile,
  resolveEmbedUrl,
  sanitizeImageSource,
  sanitizeLinkUrl,
} from "./editorUtils";
import {
  $createEmbedNode,
  $isEmbedNode,
  EmbedNode,
} from "./nodes/EmbedNode";
import {
  $createEquationNode,
  $isEquationNode,
  EquationNode,
} from "./nodes/EquationNode";
import {
  $createExcalidrawNode,
  $isExcalidrawNode,
  ExcalidrawNode,
} from "./nodes/ExcalidrawNode";
import {
  $createImageNode,
  $isImageNode,
  ImageNode,
} from "./nodes/ImageNode";
import {
  $createRichBlockNode,
  $isRichBlockNode,
  RichBlockNode,
  type RichBlockKind,
} from "./nodes/RichBlockNode";
import {
  $createRubyNode,
  $isRubyNode,
  RubyNode,
} from "./nodes/RubyNode";
import {
  SHORTCUT_ENTRIES,
  matchDocumentShortcut,
  type DocumentShortcutAction,
} from "./shortcuts";
import { toggleToolbarMenu } from "./toolbarState";

const customNodes: Array<Klass<LexicalNode>> = [
  BilingualBlockNode,
  EmbedNode,
  EquationNode,
  ExcalidrawNode,
  ImageNode,
  RichBlockNode,
  RubyNode,
];

const transferNodes: Array<Klass<LexicalNode>> = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  CodeNode,
  CodeHighlightNode,
  LinkNode,
];

function createTestEditor(nodes = customNodes) {
  return createEditor({
    namespace: "MeoiDocumentEditorTest",
    nodes,
    onError(error) {
      throw error;
    },
  });
}

describe("document editor custom nodes", () => {
  it("round-trips every custom node through Lexical JSON", () => {
    const kinds: RichBlockKind[] = [
      "callout",
      "collapsible",
      "columns",
      "date",
      "page-break",
      "poll",
      "pull-quote",
      "sticky-note",
    ];
    const editor = createTestEditor();
    editor.update(() => {
      const rubyParagraph = $createParagraphNode().append($createRubyNode("漢字", "かんじ"));
      $getRoot().append(
        $createBilingualBlockNode("すみません", "Excuse me", "Japanese"),
        $createImageNode("https://example.com/image.png", "Example", "Caption", 520, 320),
        $createEquationNode("x^2 + y^2 = z^2"),
        $createEmbedNode("youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
        $createExcalidrawNode(JSON.stringify({ elements: [{ id: "shape-1" }] })),
        ...kinds.map((kind) => $createRichBlockNode(kind, [`${kind} value`])),
        rubyParagraph,
      );
    }, { discrete: true });

    const serialized = JSON.stringify(editor.getEditorState().toJSON());
    const restored = createTestEditor();
    restored.setEditorState(restored.parseEditorState(serialized));

    restored.getEditorState().read(() => {
      const children = $getRoot().getChildren();
      expect(children[0].getTextContent()).toContain("すみません");
      expect($isImageNode(children[1])).toBe(true);
      if ($isImageNode(children[1])) {
        expect(children[1].getSource()).toBe("https://example.com/image.png");
        expect(children[1].getAltText()).toBe("Example");
        expect(children[1].getWidth()).toBe(520);
        expect(children[1].getHeight()).toBe(320);
      }
      expect($isEquationNode(children[2])).toBe(true);
      if ($isEquationNode(children[2])) expect(children[2].getEquation()).toBe("x^2 + y^2 = z^2");
      expect($isEmbedNode(children[3])).toBe(true);
      if ($isEmbedNode(children[3])) expect(children[3].getProvider()).toBe("youtube");
      expect($isExcalidrawNode(children[4])).toBe(true);
      if ($isExcalidrawNode(children[4])) expect(children[4].getData()).toContain("shape-1");

      const richBlocks = children.slice(5, 5 + kinds.length);
      richBlocks.forEach((node, index) => {
        expect($isRichBlockNode(node)).toBe(true);
        if ($isRichBlockNode(node)) {
          expect(node.getKind()).toBe(kinds[index]);
          expect(node.getValues()).toEqual([`${kinds[index]} value`]);
        }
      });

      const rubyContainer = children[children.length - 1];
      const ruby = $isElementNode(rubyContainer)
        ? rubyContainer.getFirstChild()
        : null;
      expect($isRubyNode(ruby)).toBe(true);
      if ($isRubyNode(ruby)) {
        expect(ruby.getBaseText()).toBe("漢字");
        expect(ruby.getRubyText()).toBe("かんじ");
      }
    });
  });
});

describe("document import and export", () => {
  it("exports and restores JSON, HTML, and Markdown", () => {
    const editor = createTestEditor(transferNodes);
    editor.update(() => {
      const heading = new HeadingNode("h1").append($createTextNode("Study notes"));
      const paragraph = $createParagraphNode().append($createTextNode("A formatted paragraph."));
      $getRoot().append(heading, paragraph);
    }, { discrete: true });

    const json = exportEditorContent(editor, "json");
    const html = exportEditorContent(editor, "html");
    const markdown = exportEditorContent(editor, "markdown");

    expect(json).toContain('"type": "heading"');
    expect(html).toContain("<h1");
    expect(html).toContain("Study notes");
    expect(markdown).toContain("# Study notes");

    const jsonEditor = createTestEditor(transferNodes);
    importEditorContent(jsonEditor, "json", json);
    expect(jsonEditor.getEditorState().read(() => $getRoot().getTextContent())).toContain("Study notes");

    const htmlEditor = createTestEditor(transferNodes);
    importEditorContent(htmlEditor, "html", "<h2>Imported HTML</h2><p>Body</p>");
    expect(htmlEditor.getEditorState().read(() => $getRoot().getTextContent())).toContain("Imported HTML");

    const markdownEditor = createTestEditor(transferNodes);
    importEditorContent(markdownEditor, "markdown", "## Imported Markdown\n\n- First\n- Second");
    expect(markdownEditor.getEditorState().read(() => $getRoot().getTextContent())).toContain("Imported Markdown");
    expect(exportEditorContent(markdownEditor, "markdown")).toContain("- First");
  });

  it("derives normalized plain text from editor state", () => {
    const editor = createTestEditor();
    editor.update(() => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode("First")),
        $createParagraphNode().append($createTextNode("Second")),
      );
    }, { discrete: true });

    expect(deriveDocumentPlainText(editor.getEditorState())).toBe("First\n\nSecond");
  });
});

describe("document URL and file validation", () => {
  it("accepts safe links and rejects script protocols", () => {
    expect(sanitizeLinkUrl("example.com/notes")).toBe("https://example.com/notes");
    expect(sanitizeLinkUrl("mailto:learner@example.com")).toBe("mailto:learner@example.com");
    expect(sanitizeLinkUrl("javascript:alert(1)")).toBeNull();
  });

  it("accepts supported image sources and MIME types only", () => {
    expect(sanitizeImageSource("https://example.com/photo.webp")).toBe("https://example.com/photo.webp");
    expect(sanitizeImageSource("data:image/png;base64,aGVsbG8=")).toBe("data:image/png;base64,aGVsbG8=");
    expect(sanitizeImageSource("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
    expect(isSupportedImageFile({ type: "image/gif" })).toBe(true);
    expect(isSupportedImageFile({ type: "image/svg+xml" })).toBe(false);
  });

  it("validates provider-specific embed URLs and creates privacy-aware embeds", () => {
    expect(detectEmbedProvider("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube");
    expect(detectEmbedProvider("https://x.com/example/status/123456")).toBe("twitter");
    expect(detectEmbedProvider("https://www.figma.com/file/abc/Test")).toBe("figma");
    expect(detectEmbedProvider("https://example.com/video")).toBeNull();

    expect(resolveEmbedUrl("https://youtu.be/dQw4w9WgXcQ")?.embedUrl)
      .toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(resolveEmbedUrl("https://x.com/example/status/123456")?.embedUrl)
      .toBe("https://platform.twitter.com/embed/Tweet.html?id=123456");
    expect(resolveEmbedUrl("https://example.com", "youtube")).toBeNull();
  });
});

describe("editor commands", () => {
  it("finds case-sensitive and insensitive text offsets", () => {
    expect(findTextOffsets("Meoi meoi MEOI", "meoi", false)).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 9 },
      { start: 10, end: 14 },
    ]);
    expect(findTextOffsets("Meoi meoi", "Meoi", true)).toEqual([{ start: 0, end: 4 }]);
    expect(findTextOffsets("No match", "", false)).toEqual([]);
  });
});

describe("document toolbar menus", () => {
  it("keeps only one custom toolbar menu active", () => {
    expect(toggleToolbarMenu(null, "insert")).toBe("insert");
    expect(toggleToolbarMenu("insert", "file")).toBe("file");
    expect(toggleToolbarMenu("file", "file")).toBeNull();
    expect(toggleToolbarMenu("formatting", "shortcuts")).toBe("shortcuts");
  });
});

describe("document keyboard shortcuts", () => {
  const commandModifier = IS_APPLE ? { metaKey: true } : { ctrlKey: true };
  const cases: Array<[DocumentShortcutAction, KeyboardEventInit]> = [
    ["paragraph", { key: "0", ...commandModifier, altKey: true }],
    ["h1", { key: "1", ...commandModifier, altKey: true }],
    ["h2", { key: "2", ...commandModifier, altKey: true }],
    ["h3", { key: "3", ...commandModifier, altKey: true }],
    ["number", { key: "7", ...commandModifier, shiftKey: true }],
    ["bullet", { key: "8", ...commandModifier, shiftKey: true }],
    ["check", { key: "9", ...commandModifier, shiftKey: true }],
    ["code-block", { key: "c", ...commandModifier, altKey: true }],
    ["quote", { key: "q", ctrlKey: true, shiftKey: true }],
    ["font-increase", { key: ">", ...commandModifier, shiftKey: true }],
    ["font-decrease", { key: "<", ...commandModifier, shiftKey: true }],
    ["inline-code", { key: "c", ...commandModifier, shiftKey: true }],
    ["strikethrough", { key: "x", ...commandModifier, shiftKey: true }],
    ["lowercase", { key: "1", ctrlKey: true, shiftKey: true }],
    ["uppercase", { key: "2", ctrlKey: true, shiftKey: true }],
    ["capitalize", { key: "3", ctrlKey: true, shiftKey: true }],
    ["center", { key: "e", ...commandModifier, shiftKey: true }],
    ["justify", { key: "j", ...commandModifier, shiftKey: true }],
    ["left", { key: "l", ...commandModifier, shiftKey: true }],
    ["right", { key: "r", ...commandModifier, shiftKey: true }],
    ["subscript", { key: ",", ...commandModifier }],
    ["superscript", { key: ".", ...commandModifier }],
    ["indent", { key: "]", ...commandModifier }],
    ["outdent", { key: "[", ...commandModifier }],
    ["clear-formatting", { key: "\\", ...commandModifier }],
    ["link", { key: "k", ...commandModifier }],
  ];

  it.each(cases)("matches %s using the Playground key combination", (action, init) => {
    expect(matchDocumentShortcut(new KeyboardEvent("keydown", init))).toBe(action);
  });

  it("rejects partial modifiers and omits Comments from the help list", () => {
    expect(matchDocumentShortcut(new KeyboardEvent("keydown", { key: "1" }))).toBeNull();
    expect(SHORTCUT_ENTRIES.some((entry) => entry.label.includes("Comment"))).toBe(false);
    expect(SHORTCUT_ENTRIES.find((entry) => entry.action === "bold")?.keys).toContain("B");
  });
});

describe("document table selection", () => {
  it("maps both range and table selections to the active cell", () => {
    const editor = createTestEditor([TableNode, TableRowNode, TableCellNode]);
    let firstCellKey = "";
    let secondCellKey = "";

    editor.update(() => {
      const table = $createTableNodeWithDimensions(2, 2, true);
      $getRoot().append(table);
      const firstRow = table.getFirstChildOrThrow() as TableRowNode;
      const secondRow = table.getLastChildOrThrow() as TableRowNode;
      const firstCell = firstRow.getFirstChildOrThrow() as TableCellNode;
      const secondCell = secondRow.getLastChildOrThrow() as TableCellNode;
      firstCellKey = firstCell.getKey();
      secondCellKey = secondCell.getKey();

      const rangeSelection = $createRangeSelection();
      const firstText = firstCell.getFirstDescendant();
      if (!firstText) throw new Error("Expected a text node in the table cell.");
      rangeSelection.anchor.set(firstText.getKey(), 0, "text");
      rangeSelection.focus.set(firstText.getKey(), 0, "text");
      $setSelection(rangeSelection);
      expect($getCurrentTableCellKey()).toBe(firstCellKey);

      $setSelection($createTableSelectionFrom(table, secondCell, firstCell));
      expect($getCurrentTableCellKey()).toBe(secondCellKey);
    }, { discrete: true });

    expect(firstCellKey).not.toBe("");
    expect(secondCellKey).not.toBe("");
    expect(documentEditorTheme.tableCellSelected).toBe("document-editor-table-cell-selected");
    expect(documentEditorTheme.tableSelection).toBe("document-editor-table-selection");
  });
});
