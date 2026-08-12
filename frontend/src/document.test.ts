import { $getRoot, createEditor } from "lexical";
import { describe, expect, it } from "vitest";
import {
  $createBilingualBlockNode,
  $isBilingualBlockNode,
  BilingualBlockNode,
} from "./components/BilingualBlockNode";
import { normalizeDocumentContent } from "./document";

function validParagraphContent(text = "Existing notes") {
  return JSON.stringify({
    root: {
      children: [{
        children: [{
          detail: 0,
          format: 0,
          mode: "normal",
          style: "",
          text,
          type: "text",
          version: 1,
        }],
        direction: null,
        format: "",
        indent: 0,
        textFormat: 0,
        textStyle: "",
        type: "paragraph",
        version: 1,
      }],
      direction: null,
      format: "",
      indent: 0,
      type: "root",
      version: 1,
    },
  });
}

describe("document content", () => {
  it("accepts a Lexical editor state and rejects malformed or empty states", () => {
    const valid = validParagraphContent();

    expect(normalizeDocumentContent(valid)).toBe(valid);
    expect(normalizeDocumentContent("{not-json")).toBeUndefined();
    expect(normalizeDocumentContent(JSON.stringify({
      root: { children: [], type: "root", version: 1 },
    }))).toBeUndefined();
    expect(normalizeDocumentContent(JSON.stringify({
      root: { children: [{ type: "paragraph" }], type: "root", version: 1 },
    }))).toBeUndefined();
  });

  it("does not impose an application-level document size limit", () => {
    const largeContent = validParagraphContent("x".repeat(2_100_000));
    expect(normalizeDocumentContent(largeContent)).toBe(largeContent);
  });

  it("round-trips bilingual audio node fields and plain text", () => {
    const editor = createEditor({
      namespace: "DocumentNodeTest",
      nodes: [BilingualBlockNode],
      onError: (error) => {
        throw error;
      },
    });

    editor.update(() => {
      $getRoot().append($createBilingualBlockNode(
        "すみません、いまなんじですか。",
        "Excuse me, what time is it now?",
        "Japanese",
      ));
    }, { discrete: true });

    const serialized = JSON.stringify(editor.getEditorState().toJSON());
    expect(normalizeDocumentContent(serialized)).toBe(serialized);

    const restored = createEditor({
      namespace: "DocumentNodeRestoreTest",
      nodes: [BilingualBlockNode],
      onError: (error) => {
        throw error;
      },
    });
    restored.setEditorState(restored.parseEditorState(serialized));

    restored.getEditorState().read(() => {
      const node = $getRoot().getFirstChild();
      expect($isBilingualBlockNode(node)).toBe(true);
      if (!$isBilingualBlockNode(node)) return;
      expect(node.getLanguage()).toBe("Japanese");
      expect(node.getSourceText()).toBe("すみません、いまなんじですか。");
      expect(node.getTranslation()).toBe("Excuse me, what time is it now?");
      expect($getRoot().getTextContent()).toBe(
        "すみません、いまなんじですか。\nExcuse me, what time is it now?",
      );
    });
  });
});
