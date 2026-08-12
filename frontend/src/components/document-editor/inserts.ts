import type { LucideIcon } from "lucide-react";
import {
  CalendarDays,
  Columns3,
  Image,
  Languages,
  Minus,
  PanelTopClose,
  PenTool,
  Quote,
  Sigma,
  StickyNote,
  Subtitles,
  Table2,
  TextQuote,
  Vote,
  Youtube,
} from "lucide-react";
import {
  $createParagraphNode,
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
} from "lexical";
import {
  $createHorizontalRuleNode,
} from "@lexical/extension";
import {
  $createTableNodeWithDimensions,
  $isTableCellNode,
  $isTableNode,
} from "@lexical/table";
import { $insertNodeToNearestRoot } from "@lexical/utils";
import { $createBilingualBlockNode } from "../BilingualBlockNode";
import { $createEmbedNode } from "./nodes/EmbedNode";
import { $createEquationNode } from "./nodes/EquationNode";
import { $createExcalidrawNode } from "./nodes/ExcalidrawNode";
import { $createImageNode } from "./nodes/ImageNode";
import { $createRichBlockNode } from "./nodes/RichBlockNode";
import { $createRubyNode } from "./nodes/RubyNode";

export type InsertCommandId =
  | "bilingual"
  | "callout"
  | "collapsible"
  | "columns"
  | "date"
  | "embed-figma"
  | "embed-twitter"
  | "embed-youtube"
  | "equation"
  | "excalidraw"
  | "horizontal-rule"
  | "image"
  | "page-break"
  | "poll"
  | "pull-quote"
  | "ruby"
  | "sticky-note"
  | "table";

export interface InsertCommand {
  description: string;
  icon: LucideIcon;
  id: InsertCommandId;
  keywords: string[];
  label: string;
}

export const INSERT_COMMANDS: InsertCommand[] = [
  {
    description: "Speaker, source text, and translation",
    icon: Languages,
    id: "bilingual",
    keywords: ["audio", "speaker", "translation"],
    label: "Bilingual speaker",
  },
  {
    description: "Rows and columns with keyboard navigation",
    icon: Table2,
    id: "table",
    keywords: ["grid", "cells"],
    label: "Table",
  },
  {
    description: "Embed an image from an HTTPS URL",
    icon: Image,
    id: "image",
    keywords: ["photo", "link", "url"],
    label: "Image",
  },
  {
    description: "Asian-language reading annotation",
    icon: Subtitles,
    id: "ruby",
    keywords: ["furigana", "reading", "annotation"],
    label: "Ruby annotation",
  },
  {
    description: "Visual divider",
    icon: Minus,
    id: "horizontal-rule",
    keywords: ["divider", "line"],
    label: "Horizontal rule",
  },
  {
    description: "Print and export boundary",
    icon: PanelTopClose,
    id: "page-break",
    keywords: ["print", "break"],
    label: "Page break",
  },
  {
    description: "Two editable content columns",
    icon: Columns3,
    id: "columns",
    keywords: ["layout", "two"],
    label: "Columns",
  },
  {
    description: "KaTeX equation",
    icon: Sigma,
    id: "equation",
    keywords: ["math", "latex", "katex"],
    label: "Equation",
  },
  {
    description: "Freeform Excalidraw canvas",
    icon: PenTool,
    id: "excalidraw",
    keywords: ["drawing", "diagram"],
    label: "Excalidraw",
  },
  {
    description: "Question with selectable options",
    icon: Vote,
    id: "poll",
    keywords: ["vote", "question"],
    label: "Poll",
  },
  {
    description: "Expandable summary and details",
    icon: PanelTopClose,
    id: "collapsible",
    keywords: ["details", "accordion"],
    label: "Collapsible",
  },
  {
    description: "Calendar date",
    icon: CalendarDays,
    id: "date",
    keywords: ["calendar", "day"],
    label: "Date",
  },
  {
    description: "Pinned note block",
    icon: StickyNote,
    id: "sticky-note",
    keywords: ["note", "memo"],
    label: "Sticky note",
  },
  {
    description: "Highlighted information",
    icon: TextQuote,
    id: "callout",
    keywords: ["info", "notice"],
    label: "Callout",
  },
  {
    description: "Large quotation with attribution",
    icon: Quote,
    id: "pull-quote",
    keywords: ["quote", "citation"],
    label: "Pull quote",
  },
  {
    description: "Embed a YouTube video",
    icon: Youtube,
    id: "embed-youtube",
    keywords: ["video", "youtube"],
    label: "YouTube",
  },
  {
    description: "Embed a Twitter or X post",
    icon: TextQuote,
    id: "embed-twitter",
    keywords: ["tweet", "x", "twitter"],
    label: "Twitter / X",
  },
  {
    description: "Embed a Figma file or prototype",
    icon: Columns3,
    id: "embed-figma",
    keywords: ["design", "figma"],
    label: "Figma",
  },
];

function $createInsertNode(id: InsertCommandId, language: string): LexicalNode {
  if (id === "horizontal-rule") return $createHorizontalRuleNode();
  if (id === "table") {
    return $createTableNodeWithDimensions(3, 3, {
      columns: false,
      rows: true,
    });
  }
  if (id === "ruby") {
    const paragraph = $createParagraphNode();
    paragraph.append($createRubyNode("", ""));
    return paragraph;
  }
  if (id === "bilingual") return $createBilingualBlockNode("", "", language);
  if (id === "image") return $createImageNode();
  if (id === "equation") return $createEquationNode();
  if (id === "excalidraw") return $createExcalidrawNode();
  if (id === "embed-youtube") return $createEmbedNode("youtube");
  if (id === "embed-twitter") return $createEmbedNode("twitter");
  if (id === "embed-figma") return $createEmbedNode("figma");
  return $createRichBlockNode(id);
}

function $focusInsertedNode(node: LexicalNode): void {
  if ($isTableNode(node)) {
    const firstCell = node.getFirstDescendant();
    if ($isTableCellNode(firstCell)) {
      firstCell.selectStart();
      return;
    }
  }
  node.selectNext();
}

function $getTopLevelBlock(node: LexicalNode): LexicalNode | null {
  let block = node;
  let parent = block.getParent();
  while (parent && parent.getType() !== "root") {
    block = parent;
    parent = block.getParent();
  }
  return parent ? block : null;
}

export function executeInsertCommand(
  editor: LexicalEditor,
  id: InsertCommandId,
  language: string,
): void {
  editor.update(() => {
    if (id === "ruby") {
      const selection = $getSelection();
      const baseText = $isRangeSelection(selection) ? selection.getTextContent() : "";
      if ($isRangeSelection(selection)) {
        selection.insertNodes([$createRubyNode(baseText, "")]);
      }
      return;
    }
    const node = $createInsertNode(id, language);
    $insertNodeToNearestRoot(node);
    $focusInsertedNode(node);
  });
}

/** Inserts a block after the block currently targeted by the hover controls. */
export function executeInsertCommandAfterBlock(
  editor: LexicalEditor,
  id: InsertCommandId,
  language: string,
  targetBlockKey: NodeKey,
): boolean {
  let inserted = false;
  editor.update(() => {
    const target = $getNodeByKey(targetBlockKey);
    if (!target) return;
    const block = $getTopLevelBlock(target);
    if (!block) return;
    const node = $createInsertNode(id, language);
    block.insertAfter(node);
    $focusInsertedNode(node);
    inserted = true;
  }, { discrete: true });
  if (inserted) editor.focus();
  return inserted;
}
