// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentEditor } from "../DocumentEditor";

const EMPTY_DOCUMENT = JSON.stringify({
  root: {
    children: [{ children: [], direction: null, format: "", indent: 0, type: "paragraph", version: 1 }],
    direction: null,
    format: "",
    indent: 0,
    type: "root",
    version: 1,
  },
});

let mountedRoot: Root | null = null;
let mountedContainer: HTMLDivElement | null = null;

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });

afterEach(async () => {
  if (mountedRoot) {
    await act(async () => mountedRoot?.unmount());
  }
  mountedContainer?.remove();
  mountedRoot = null;
  mountedContainer = null;
});

describe("Meoing Playground editor adapter", () => {
  it("mounts the Playground interaction surface without service-only tooling", async () => {
    mountedContainer = document.createElement("div");
    document.body.append(mountedContainer);
    mountedRoot = createRoot(mountedContainer);

    await act(async () => {
      mountedRoot?.render(
        <DocumentEditor
          content={EMPTY_DOCUMENT}
          language="Japanese"
          plainText=""
          onChange={() => undefined}
        />,
      );
    });

    expect(mountedContainer.querySelector(".meoing-playground .toolbar")).not.toBeNull();
    expect(mountedContainer.querySelector(".meoing-playground .editor-scroller")).not.toBeNull();
    expect(mountedContainer.querySelector(".ContentEditable__root")).not.toBeNull();
    expect(mountedContainer.querySelector('[aria-label="Find and replace"]')).not.toBeNull();
    expect(mountedContainer.textContent).not.toContain("Collaboration");
    expect(mountedContainer.textContent).not.toContain("Test recorder");
  });
});
