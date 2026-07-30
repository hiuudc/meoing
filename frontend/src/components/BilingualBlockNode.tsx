import type { ReactNode } from "react";
import { Trash2, Volume2 } from "lucide-react";
import {
  $applyNodeReplacement,
  $createParagraphNode,
  $getNodeByKey,
  DecoratorNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  languageTagForSpeech,
  loadSpeechPreference,
  resolveSpeechVoice,
  speechTextForLanguage,
} from "../learning/speech";

export type SerializedBilingualBlockNode = Spread<
  {
    language: string;
    sourceText: string;
    translation: string;
  },
  SerializedLexicalNode
>;

interface BilingualBlockProps {
  language: string;
  nodeKey: NodeKey;
  sourceText: string;
  translation: string;
}

function supportsSpeech(): boolean {
  return typeof window !== "undefined"
    && "speechSynthesis" in window
    && typeof SpeechSynthesisUtterance !== "undefined";
}

function speakText(text: string, language: string) {
  if (!supportsSpeech() || !text.trim()) return;
  const preference = loadSpeechPreference();
  const utterance = new SpeechSynthesisUtterance(speechTextForLanguage(text, language));
  utterance.lang = languageTagForSpeech(language);
  utterance.rate = preference.rate;
  utterance.voice = resolveSpeechVoice(window.speechSynthesis.getVoices(), preference, language) ?? null;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function BilingualBlock({
  language,
  nodeKey,
  sourceText,
  translation,
}: BilingualBlockProps) {
  const [editor] = useLexicalComposerContext();

  function updateNode(update: (node: BilingualBlockNode) => void) {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isBilingualBlockNode(node)) update(node);
    });
  }

  function removeNode() {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (!$isBilingualBlockNode(node)) return;
      const paragraph = $createParagraphNode();
      node.replace(paragraph);
      paragraph.select();
    });
  }

  return (
    <section className="bilingual-block" contentEditable={false} aria-label="Bilingual audio block">
      <span className="bilingual-block-pointer" aria-hidden="true" />
      <button
        className="bilingual-speak-button"
        type="button"
        onClick={() => speakText(sourceText, language)}
        disabled={!supportsSpeech() || !sourceText.trim()}
        aria-label={`Play ${language} text`}
        title={`Play ${language} text`}
      >
        <Volume2 size={22} />
      </button>
      <div className="bilingual-copy">
        <textarea
          className="bilingual-source-input"
          value={sourceText}
          onChange={(event) => updateNode((node) => node.setSourceText(event.target.value))}
          placeholder="Enter the sentence to study"
          rows={1}
          aria-label="Text to speak"
        />
        <textarea
          className="bilingual-translation-input"
          value={translation}
          onChange={(event) => updateNode((node) => node.setTranslation(event.target.value))}
          placeholder="Add a translation"
          rows={1}
          aria-label="Translation"
        />
      </div>
      <button
        className="bilingual-remove-button"
        type="button"
        onClick={removeNode}
        aria-label="Remove bilingual block"
        title="Remove bilingual block"
      >
        <Trash2 size={16} />
      </button>
    </section>
  );
}

export class BilingualBlockNode extends DecoratorNode<ReactNode> {
  __language: string;
  __sourceText: string;
  __translation: string;

  static getType(): string {
    return "bilingual-block";
  }

  static clone(node: BilingualBlockNode): BilingualBlockNode {
    return new BilingualBlockNode(
      node.__sourceText,
      node.__translation,
      node.__language,
      node.__key,
    );
  }

  static importJSON(serializedNode: SerializedBilingualBlockNode): BilingualBlockNode {
    return new BilingualBlockNode(
      serializedNode.sourceText,
      serializedNode.translation,
      serializedNode.language,
    );
  }

  constructor(
    sourceText = "",
    translation = "",
    language = "English",
    key?: NodeKey,
  ) {
    super(key);
    this.__sourceText = sourceText;
    this.__translation = translation;
    this.__language = language;
  }

  exportJSON(): SerializedBilingualBlockNode {
    return {
      ...super.exportJSON(),
      language: this.getLanguage(),
      sourceText: this.getSourceText(),
      translation: this.getTranslation(),
    };
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const element = document.createElement("div");
    element.className = "bilingual-block-shell";
    return element;
  }

  updateDOM(): false {
    return false;
  }

  decorate(): ReactNode {
    return (
      <BilingualBlock
        language={this.getLanguage()}
        nodeKey={this.getKey()}
        sourceText={this.getSourceText()}
        translation={this.getTranslation()}
      />
    );
  }

  getTextContent(): string {
    return [this.getSourceText(), this.getTranslation()].filter(Boolean).join("\n");
  }

  getLanguage(): string {
    return this.getLatest().__language;
  }

  getSourceText(): string {
    return this.getLatest().__sourceText;
  }

  getTranslation(): string {
    return this.getLatest().__translation;
  }

  setSourceText(sourceText: string): this {
    this.getWritable().__sourceText = sourceText;
    return this;
  }

  setTranslation(translation: string): this {
    this.getWritable().__translation = translation;
    return this;
  }

  isInline(): false {
    return false;
  }

  isKeyboardSelectable(): true {
    return true;
  }
}

export function $createBilingualBlockNode(
  sourceText = "",
  translation = "",
  language = "English",
): BilingualBlockNode {
  return $applyNodeReplacement(new BilingualBlockNode(sourceText, translation, language));
}

export function $isBilingualBlockNode(
  node: LexicalNode | null | undefined,
): node is BilingualBlockNode {
  return node instanceof BilingualBlockNode;
}
