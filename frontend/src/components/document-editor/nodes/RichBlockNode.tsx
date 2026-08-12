import type { ReactNode } from "react";
import {
  CalendarDays,
  Columns3,
  MessageSquareQuote,
  PanelTopClose,
  StickyNote,
  Trash2,
  Vote,
} from "lucide-react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $applyNodeReplacement,
  $createParagraphNode,
  $getNodeByKey,
  DecoratorNode,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";

export type RichBlockKind =
  | "callout"
  | "collapsible"
  | "columns"
  | "date"
  | "page-break"
  | "poll"
  | "pull-quote"
  | "sticky-note";

export type SerializedRichBlockNode = Spread<{
  kind: RichBlockKind;
  values: string[];
}, SerializedLexicalNode>;

const kindLabels: Record<RichBlockKind, string> = {
  callout: "Callout",
  collapsible: "Collapsible",
  columns: "Columns",
  date: "Date",
  "page-break": "Page break",
  poll: "Poll",
  "pull-quote": "Pull quote",
  "sticky-note": "Sticky note",
};

const kindIcons: Record<RichBlockKind, typeof CalendarDays> = {
  callout: MessageSquareQuote,
  collapsible: PanelTopClose,
  columns: Columns3,
  date: CalendarDays,
  "page-break": PanelTopClose,
  poll: Vote,
  "pull-quote": MessageSquareQuote,
  "sticky-note": StickyNote,
};

export function defaultRichBlockValues(kind: RichBlockKind): string[] {
  if (kind === "columns") return ["Left column", "Right column"];
  if (kind === "poll") return ["Question", "Option 1", "Option 2", "Option 3"];
  if (kind === "collapsible") return ["Summary", "Hidden details"];
  if (kind === "date") return [new Date().toISOString().slice(0, 10)];
  if (kind === "page-break") return [];
  if (kind === "pull-quote") return ["A memorable quotation", "Attribution"];
  if (kind === "sticky-note") return ["Remember this"];
  return ["Important note"];
}

interface RichBlockEditorProps {
  kind: RichBlockKind;
  nodeKey: NodeKey;
  values: string[];
}

function RichBlockEditor({ kind, nodeKey, values }: RichBlockEditorProps) {
  const [editor] = useLexicalComposerContext();
  const Icon = kindIcons[kind];

  function updateValue(index: number, value: string) {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isRichBlockNode(node)) node.setValue(index, value);
    });
  }

  function removeNode() {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (!$isRichBlockNode(node)) return;
      const paragraph = $createParagraphNode();
      node.replace(paragraph);
      paragraph.select();
    });
  }

  if (kind === "page-break") {
    return (
      <div className="document-page-break" contentEditable={false}>
        <span>Page break</span>
        <button type="button" onClick={removeNode} aria-label="Remove page break">
          <Trash2 size={15} />
        </button>
      </div>
    );
  }

  let content: ReactNode;
  if (kind === "columns") {
    content = (
      <div className="document-columns-grid">
        {values.slice(0, 2).map((value, index) => (
          <textarea
            key={index}
            value={value}
            onChange={(event) => updateValue(index, event.target.value)}
            aria-label={`Column ${index + 1}`}
            rows={5}
          />
        ))}
      </div>
    );
  } else if (kind === "poll") {
    content = (
      <div className="document-poll-fields">
        <input
          className="document-poll-question"
          value={values[0] ?? ""}
          onChange={(event) => updateValue(0, event.target.value)}
          aria-label="Poll question"
        />
        {values.slice(1).map((value, index) => (
          <label key={index}>
            <input type="radio" name={`poll-preview-${nodeKey}`} disabled />
            <input
              value={value}
              onChange={(event) => updateValue(index + 1, event.target.value)}
              aria-label={`Poll option ${index + 1}`}
            />
          </label>
        ))}
      </div>
    );
  } else if (kind === "collapsible") {
    content = (
      <details open>
        <summary>
          <input
            value={values[0] ?? ""}
            onChange={(event) => updateValue(0, event.target.value)}
            aria-label="Collapsible summary"
          />
        </summary>
        <textarea
          value={values[1] ?? ""}
          onChange={(event) => updateValue(1, event.target.value)}
          aria-label="Collapsible details"
          rows={4}
        />
      </details>
    );
  } else if (kind === "date") {
    content = (
      <input
        className="document-date-input"
        type="date"
        value={values[0] ?? ""}
        onChange={(event) => updateValue(0, event.target.value)}
        aria-label="Date"
      />
    );
  } else if (kind === "pull-quote") {
    content = (
      <blockquote>
        <textarea
          value={values[0] ?? ""}
          onChange={(event) => updateValue(0, event.target.value)}
          aria-label="Pull quote"
          rows={3}
        />
        <input
          value={values[1] ?? ""}
          onChange={(event) => updateValue(1, event.target.value)}
          aria-label="Quote attribution"
          placeholder="Attribution"
        />
      </blockquote>
    );
  } else {
    content = (
      <textarea
        value={values[0] ?? ""}
        onChange={(event) => updateValue(0, event.target.value)}
        aria-label={kindLabels[kind]}
        rows={kind === "sticky-note" ? 4 : 3}
      />
    );
  }

  return (
    <section className={`document-rich-block is-${kind}`} contentEditable={false}>
      <div className="document-node-heading">
        <span><Icon size={17} /> {kindLabels[kind]}</span>
        <button
          className="document-node-remove"
          type="button"
          onClick={removeNode}
          aria-label={`Remove ${kindLabels[kind].toLowerCase()}`}
        >
          <Trash2 size={16} />
        </button>
      </div>
      {content}
    </section>
  );
}

export class RichBlockNode extends DecoratorNode<ReactNode> {
  __kind: RichBlockKind;
  __values: string[];

  static getType(): string {
    return "meoi-rich-block";
  }

  static clone(node: RichBlockNode): RichBlockNode {
    return new RichBlockNode(node.__kind, node.__values, node.__key);
  }

  static importJSON(serializedNode: SerializedRichBlockNode): RichBlockNode {
    return new RichBlockNode(serializedNode.kind, serializedNode.values);
  }

  constructor(
    kind: RichBlockKind = "callout",
    values = defaultRichBlockValues(kind),
    key?: NodeKey,
  ) {
    super(key);
    this.__kind = kind;
    this.__values = values.map(String);
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const element = document.createElement("div");
    element.className = "document-rich-block-shell";
    return element;
  }

  updateDOM(): false {
    return false;
  }

  decorate(): ReactNode {
    return (
      <RichBlockEditor
        kind={this.getKind()}
        nodeKey={this.getKey()}
        values={this.getValues()}
      />
    );
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement(this.getKind() === "pull-quote" ? "blockquote" : "section");
    element.dataset.meoiBlock = this.getKind();
    element.textContent = this.getTextContent();
    return { element };
  }

  exportJSON(): SerializedRichBlockNode {
    return {
      ...super.exportJSON(),
      kind: this.getKind(),
      values: this.getValues(),
    };
  }

  getTextContent(): string {
    if (this.getKind() === "page-break") return "\n";
    return this.getValues().filter(Boolean).join("\n");
  }

  getKind(): RichBlockKind {
    return this.getLatest().__kind;
  }

  getValues(): string[] {
    return [...this.getLatest().__values];
  }

  setValue(index: number, value: string): this {
    const writable = this.getWritable();
    const values = [...writable.__values];
    values[index] = value;
    writable.__values = values;
    return this;
  }

  isInline(): false {
    return false;
  }

  isKeyboardSelectable(): true {
    return true;
  }
}

export function $createRichBlockNode(
  kind: RichBlockKind,
  values = defaultRichBlockValues(kind),
): RichBlockNode {
  return $applyNodeReplacement(new RichBlockNode(kind, values));
}

export function $isRichBlockNode(node: LexicalNode | null | undefined): node is RichBlockNode {
  return node instanceof RichBlockNode;
}
