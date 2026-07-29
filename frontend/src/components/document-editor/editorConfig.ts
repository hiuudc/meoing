import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  configExtension,
  defineExtension,
  type EditorThemeClasses,
  type InitialEditorStateType,
} from "lexical";
import { CodeExtension } from "@lexical/code-core";
import { HorizontalRuleExtension, TabIndentationExtension } from "@lexical/extension";
import { HashtagExtension } from "@lexical/hashtag";
import { HistoryExtension } from "@lexical/history";
import {
  AutoLinkExtension,
  LinkExtension,
  autoLinkEmailMatcher,
  autoLinkUrlMatcher,
} from "@lexical/link";
import { CheckListExtension, ListExtension } from "@lexical/list";
import { RichTextExtension } from "@lexical/rich-text";
import { TableExtension } from "@lexical/table";
import { normalizeDocumentContent } from "../../document";
import { BilingualBlockNode } from "../BilingualBlockNode";
import { EmbedNode } from "./nodes/EmbedNode";
import { EquationNode } from "./nodes/EquationNode";
import { ExcalidrawNode } from "./nodes/ExcalidrawNode";
import { ImageNode } from "./nodes/ImageNode";
import { RichBlockNode } from "./nodes/RichBlockNode";
import { RubyNode } from "./nodes/RubyNode";
import { sanitizeLinkUrl } from "./editorUtils";

export const documentEditorTheme: EditorThemeClasses = {
  code: "document-editor-code",
  codeHighlight: {
    atrule: "token-atrule",
    attr: "token-attr",
    boolean: "token-boolean",
    builtin: "token-builtin",
    cdata: "token-cdata",
    char: "token-char",
    class: "token-class",
    "class-name": "token-class-name",
    comment: "token-comment",
    constant: "token-constant",
    deleted: "token-deleted",
    doctype: "token-doctype",
    entity: "token-entity",
    function: "token-function",
    important: "token-important",
    inserted: "token-inserted",
    keyword: "token-keyword",
    namespace: "token-namespace",
    number: "token-number",
    operator: "token-operator",
    prolog: "token-prolog",
    property: "token-property",
    punctuation: "token-punctuation",
    regex: "token-regex",
    selector: "token-selector",
    string: "token-string",
    symbol: "token-symbol",
    tag: "token-tag",
    url: "token-url",
    variable: "token-variable",
  },
  hashtag: "document-editor-hashtag",
  heading: {
    h1: "document-editor-heading-one",
    h2: "document-editor-heading-two",
    h3: "document-editor-heading-three",
  },
  link: "document-editor-link",
  list: {
    checklist: "document-editor-list-checklist",
    listitem: "document-editor-list-item",
    listitemChecked: "document-editor-list-item-checked",
    listitemUnchecked: "document-editor-list-item-unchecked",
    nested: {
      listitem: "document-editor-list-item-nested",
    },
    ol: "document-editor-list-ordered",
    ul: "document-editor-list-unordered",
  },
  paragraph: "document-editor-paragraph",
  quote: "document-editor-quote",
  table: "document-editor-table",
  tableAddColumns: "document-editor-table-add-columns",
  tableAddRows: "document-editor-table-add-rows",
  tableCell: "document-editor-table-cell",
  tableCellActionButton: "document-editor-table-action",
  tableCellActionButtonContainer: "document-editor-table-action-container",
  tableCellHeader: "document-editor-table-cell-header",
  tableCellResizer: "document-editor-table-resizer",
  tableScrollableWrapper: "document-editor-table-scroll",
  tableSelected: "document-editor-table-selected",
  tableSelection: "document-editor-table-selection",
  text: {
    bold: "document-editor-bold",
    capitalize: "document-editor-capitalize",
    code: "document-editor-inline-code",
    italic: "document-editor-italic",
    lowercase: "document-editor-lowercase",
    strikethrough: "document-editor-strikethrough",
    subscript: "document-editor-subscript",
    superscript: "document-editor-superscript",
    underline: "document-editor-underline",
    underlineStrikethrough: "document-editor-underline-strikethrough",
    uppercase: "document-editor-uppercase",
  },
};

function createInitialEditorState(
  content: string | undefined,
  plainText: string,
): InitialEditorStateType {
  const normalizedContent = normalizeDocumentContent(content);
  if (normalizedContent) return normalizedContent;
  return () => {
    const paragraph = $createParagraphNode();
    if (plainText) paragraph.append($createTextNode(plainText));
    $getRoot().append(paragraph);
  };
}

export function createDocumentEditorExtension(
  content: string | undefined,
  plainText: string,
) {
  return defineExtension({
    name: "MeoiDocumentEditor",
    namespace: "MeoiDocumentEditor",
    nodes: [
      BilingualBlockNode,
      EmbedNode,
      EquationNode,
      ExcalidrawNode,
      ImageNode,
      RichBlockNode,
      RubyNode,
    ],
    theme: documentEditorTheme,
    $initialEditorState: createInitialEditorState(content, plainText),
    onError(error: Error) {
      throw error;
    },
    dependencies: [
      RichTextExtension,
      configExtension(HistoryExtension, { maxDepth: 100 }),
      ListExtension,
      CheckListExtension,
      CodeExtension,
      HorizontalRuleExtension,
      configExtension(TabIndentationExtension, { maxIndent: 8 }),
      configExtension(LinkExtension, {
        attributes: { rel: "noopener noreferrer", target: "_blank" },
        validateUrl: (value) => sanitizeLinkUrl(value) !== null,
      }),
      configExtension(AutoLinkExtension, {
        matchers: [autoLinkUrlMatcher, autoLinkEmailMatcher],
      }),
      HashtagExtension,
      configExtension(TableExtension, {
        hasCellBackgroundColor: true,
        hasCellMerge: true,
        hasHorizontalScroll: true,
        hasNestedTables: false,
        hasTabHandler: true,
      }),
    ],
  });
}
