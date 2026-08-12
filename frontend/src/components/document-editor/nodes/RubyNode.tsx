import type { ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $applyNodeReplacement,
  $createTextNode,
  $getNodeByKey,
  DecoratorNode,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";

export type SerializedRubyNode = Spread<{
  baseText: string;
  rubyText: string;
}, SerializedLexicalNode>;

interface RubyEditorProps {
  baseText: string;
  nodeKey: NodeKey;
  rubyText: string;
}

function RubyEditor({ baseText, nodeKey, rubyText }: RubyEditorProps) {
  const [editor] = useLexicalComposerContext();

  function updateNode(update: (node: RubyNode) => void) {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isRubyNode(node)) update(node);
    });
  }

  return (
    <span className="document-ruby-node" contentEditable={false}>
      <ruby>
        <input
          value={baseText}
          onChange={(event) => updateNode((node) => node.setBaseText(event.target.value))}
          aria-label="Ruby base text"
          placeholder="Text"
        />
        <rt>
          <input
            value={rubyText}
            onChange={(event) => updateNode((node) => node.setRubyText(event.target.value))}
            aria-label="Ruby annotation"
            placeholder="Reading"
          />
        </rt>
      </ruby>
      <button
        type="button"
        aria-label="Remove ruby annotation"
        title="Remove ruby annotation"
        onClick={() => {
          editor.update(() => {
            const node = $getNodeByKey(nodeKey);
            if ($isRubyNode(node)) node.replace($createTextNode(node.getBaseText()));
          });
        }}
      >
        <Trash2 size={13} />
      </button>
    </span>
  );
}

export class RubyNode extends DecoratorNode<ReactNode> {
  __baseText: string;
  __rubyText: string;

  static getType(): string {
    return "meoi-ruby";
  }

  static clone(node: RubyNode): RubyNode {
    return new RubyNode(node.__baseText, node.__rubyText, node.__key);
  }

  static importJSON(serializedNode: SerializedRubyNode): RubyNode {
    return new RubyNode(serializedNode.baseText, serializedNode.rubyText);
  }

  constructor(baseText = "", rubyText = "", key?: NodeKey) {
    super(key);
    this.__baseText = baseText;
    this.__rubyText = rubyText;
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const element = document.createElement("span");
    element.className = "document-ruby-shell";
    return element;
  }

  updateDOM(): false {
    return false;
  }

  decorate(): ReactNode {
    return (
      <RubyEditor
        baseText={this.getBaseText()}
        nodeKey={this.getKey()}
        rubyText={this.getRubyText()}
      />
    );
  }

  exportDOM(): DOMExportOutput {
    const ruby = document.createElement("ruby");
    ruby.append(document.createTextNode(this.getBaseText()));
    const annotation = document.createElement("rt");
    annotation.textContent = this.getRubyText();
    ruby.append(annotation);
    return { element: ruby };
  }

  exportJSON(): SerializedRubyNode {
    return {
      ...super.exportJSON(),
      baseText: this.getBaseText(),
      rubyText: this.getRubyText(),
    };
  }

  getTextContent(): string {
    return `${this.getBaseText()} (${this.getRubyText()})`;
  }

  getBaseText(): string {
    return this.getLatest().__baseText;
  }

  getRubyText(): string {
    return this.getLatest().__rubyText;
  }

  setBaseText(value: string): this {
    this.getWritable().__baseText = value;
    return this;
  }

  setRubyText(value: string): this {
    this.getWritable().__rubyText = value;
    return this;
  }

  isInline(): true {
    return true;
  }
}

export function $createRubyNode(baseText = "", rubyText = ""): RubyNode {
  return $applyNodeReplacement(new RubyNode(baseText, rubyText));
}

export function $isRubyNode(node: LexicalNode | null | undefined): node is RubyNode {
  return node instanceof RubyNode;
}
