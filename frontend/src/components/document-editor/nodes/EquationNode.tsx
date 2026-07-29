import { useEffect, useRef, useState, type ReactNode } from "react";
import { Sigma, Trash2 } from "lucide-react";
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

export type SerializedEquationNode = Spread<{
  equation: string;
}, SerializedLexicalNode>;

interface EquationEditorProps {
  equation: string;
  nodeKey: NodeKey;
}

function EquationPreview({ equation }: { equation: string }) {
  const outputRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void Promise.all([
      import("katex"),
      import("katex/dist/katex.min.css"),
    ]).then(([katex]) => {
      if (!active || !outputRef.current) return;
      try {
        katex.default.render(equation || "\\text{Enter an equation}", outputRef.current, {
          displayMode: true,
          output: "htmlAndMathml",
          strict: "warn",
          throwOnError: true,
        });
        setError("");
      } catch (renderError) {
        outputRef.current.textContent = equation;
        setError(renderError instanceof Error ? renderError.message : "Invalid equation");
      }
    });
    return () => {
      active = false;
    };
  }, [equation]);

  return (
    <>
      <div className="document-equation-preview" ref={outputRef} aria-label="Equation preview" />
      {error ? <p className="document-node-error" role="status">{error}</p> : null}
    </>
  );
}

function EquationEditor({ equation, nodeKey }: EquationEditorProps) {
  const [editor] = useLexicalComposerContext();

  function updateEquation(value: string) {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isEquationNode(node)) node.setEquation(value);
    });
  }

  return (
    <section className="document-equation-node" contentEditable={false}>
      <div className="document-node-heading">
        <span><Sigma size={17} /> Equation</span>
        <button
          className="document-node-remove"
          type="button"
          aria-label="Remove equation"
          title="Remove equation"
          onClick={() => {
            editor.update(() => {
              const node = $getNodeByKey(nodeKey);
              if (!$isEquationNode(node)) return;
              const paragraph = $createParagraphNode();
              node.replace(paragraph);
              paragraph.select();
            });
          }}
        >
          <Trash2 size={16} />
        </button>
      </div>
      <EquationPreview equation={equation} />
      <label>
        <span>LaTeX</span>
        <textarea
          rows={2}
          value={equation}
          onChange={(event) => updateEquation(event.target.value)}
          placeholder={"\\frac{a}{b}"}
          spellCheck={false}
        />
      </label>
    </section>
  );
}

export class EquationNode extends DecoratorNode<ReactNode> {
  __equation: string;

  static getType(): string {
    return "meoi-equation";
  }

  static clone(node: EquationNode): EquationNode {
    return new EquationNode(node.__equation, node.__key);
  }

  static importJSON(serializedNode: SerializedEquationNode): EquationNode {
    return new EquationNode(serializedNode.equation);
  }

  constructor(equation = "", key?: NodeKey) {
    super(key);
    this.__equation = equation;
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const element = document.createElement("div");
    element.className = "document-equation-shell";
    return element;
  }

  updateDOM(): false {
    return false;
  }

  decorate(): ReactNode {
    return <EquationEditor equation={this.getEquation()} nodeKey={this.getKey()} />;
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement("div");
    element.dataset.equation = this.getEquation();
    element.textContent = `$$${this.getEquation()}$$`;
    return { element };
  }

  exportJSON(): SerializedEquationNode {
    return {
      ...super.exportJSON(),
      equation: this.getEquation(),
    };
  }

  getTextContent(): string {
    return `$$${this.getEquation()}$$`;
  }

  getEquation(): string {
    return this.getLatest().__equation;
  }

  setEquation(value: string): this {
    this.getWritable().__equation = value;
    return this;
  }

  isInline(): false {
    return false;
  }

  isKeyboardSelectable(): true {
    return true;
  }
}

export function $createEquationNode(equation = ""): EquationNode {
  return $applyNodeReplacement(new EquationNode(equation));
}

export function $isEquationNode(node: LexicalNode | null | undefined): node is EquationNode {
  return node instanceof EquationNode;
}
