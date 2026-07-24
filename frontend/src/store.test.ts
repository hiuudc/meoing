import { describe, expect, it } from "vitest";
import {
  COLOR_THEME_PRESETS,
  accentStyle,
  addThemeStop,
  cloneTheme,
  contrastTextColor,
  hexToHsv,
  hsvToHex,
  isValidHex,
  markThemeCustom,
  reconcileThemeSelection,
  removeThemeStop,
  resetTheme,
  saturationValueFromPointer,
  selectBaseTheme,
  selectColorTheme,
  surpriseTheme,
  themeStyle,
  updateThemeStop,
} from "./theme";
import {
  DEFAULT_THEME,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  STORAGE_KEY,
  createSeedState,
  loadWorkspace,
  normalizeSidebarWidth,
  normalizeThemeConfig,
  saveWorkspace,
  workspaceReducer,
} from "./store";
import { cleanUnitName } from "./unit";

describe("workspace reducer", () => {
  it("creates and updates a document without mutating the previous state", () => {
    const state = createSeedState();
    const document = {
      id: "new-document",
      unitId: "jp-rhythm",
      title: "Evening routine",
      type: "Notes",
      body: "A short practice document.",
      updatedAt: "Just now",
    };

    const created = workspaceReducer(state, { type: "createDocument", document });
    const updated = workspaceReducer(created, {
      type: "updateDocument",
      document: { ...document, title: "Evening routine revised" },
    });

    expect(state.documents["new-document"]).toBeUndefined();
    expect(created.documentOrder[0]).toBe("new-document");
    expect(updated.documents["new-document"].title).toBe("Evening routine revised");
  });

  it("falls back to another collection and removes descendants after deletion", () => {
    let state = createSeedState();
    state = workspaceReducer(state, { type: "selectCollection", id: "spanish" });
    state = workspaceReducer(state, {
      type: "createDocument",
      document: {
        id: "spanish-document",
        unitId: "es-starters",
        title: "Starter notes",
        type: "Notes",
        body: "",
        updatedAt: "Just now",
      },
    });

    const next = workspaceReducer(state, { type: "deleteCollection", id: "spanish" });

    expect(next.activeCollectionId).toBe("japanese");
    expect(next.activeUnitId).toBe("jp-first");
    expect(next.collections.spanish).toBeUndefined();
    expect(next.units["es-starters"]).toBeUndefined();
    expect(next.documents["spanish-document"]).toBeUndefined();
  });

  it("keeps at least one collection", () => {
    const state = createSeedState();
    const onlyJapanese = workspaceReducer(
      workspaceReducer(state, { type: "deleteCollection", id: "spanish" }),
      { type: "deleteCollection", id: "research" },
    );

    expect(workspaceReducer(onlyJapanese, { type: "deleteCollection", id: "japanese" })).toBe(onlyJapanese);
  });

  it("moves units within their collection without disturbing foreign units", () => {
    const state = createSeedState();
    const movedBefore = workspaceReducer(state, {
      type: "moveUnit",
      id: "jp-small-talk",
      targetId: "jp-first",
      placement: "before",
    });
    const movedAfter = workspaceReducer(state, {
      type: "moveUnit",
      id: "jp-first",
      targetId: "jp-town",
      placement: "after",
    });

    expect(movedBefore.unitOrder.slice(0, 4)).toEqual(["jp-small-talk", "jp-first", "jp-rhythm", "jp-town"]);
    expect(movedAfter.unitOrder.slice(0, 4)).toEqual(["jp-rhythm", "jp-town", "jp-first", "jp-small-talk"]);
    expect(movedBefore.unitOrder.slice(4)).toEqual(["es-starters", "research-notes"]);
    expect(state.unitOrder.slice(0, 4)).toEqual(["jp-first", "jp-rhythm", "jp-town", "jp-small-talk"]);
  });

  it("ignores invalid and cross-collection unit moves", () => {
    const state = createSeedState();

    expect(workspaceReducer(state, { type: "moveUnit", id: "jp-first", targetId: "jp-first", placement: "after" })).toBe(state);
    expect(workspaceReducer(state, { type: "moveUnit", id: "jp-first", targetId: "es-starters", placement: "after" })).toBe(state);
    expect(workspaceReducer(state, { type: "moveUnit", id: "missing", targetId: "jp-first", placement: "before" })).toBe(state);
  });

  it("clamps sidebar width updates", () => {
    const state = createSeedState();

    expect(workspaceReducer(state, { type: "setSidebarWidth", width: 330 }).sidebarWidth).toBe(330);
    expect(workspaceReducer(state, { type: "setSidebarWidth", width: 0 }).sidebarWidth).toBe(MIN_SIDEBAR_WIDTH);
    expect(workspaceReducer(state, { type: "setSidebarWidth", width: 999 }).sidebarWidth).toBe(MAX_SIDEBAR_WIDTH);
    expect(normalizeSidebarWidth(Number.NaN)).toBe(DEFAULT_SIDEBAR_WIDTH);
  });
});

describe("persistence", () => {
  it("round-trips versioned state through storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const state = createSeedState();
    saveWorkspace(state, storage);

    expect(values.has(STORAGE_KEY)).toBe(true);
    expect(loadWorkspace(storage)).toEqual(state);
  });

  it("normalizes a legacy collection profile without changing the workspace storage version", () => {
    const state = createSeedState();
    const legacy = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    const collections = legacy.collections as Record<string, { learningProfile?: Record<string, unknown> }>;
    delete collections.japanese.learningProfile?.sourceLanguage;
    const storage = { getItem: () => JSON.stringify(legacy) };

    const loaded = loadWorkspace(storage);
    expect(loaded.version).toBe(state.version);
    expect(loaded.collections.japanese.learningProfile?.sourceLanguage).toBe("English");
  });

  it("round-trips a persisted custom sidebar width", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const state = workspaceReducer(createSeedState(), { type: "setSidebarWidth", width: 336 });
    saveWorkspace(state, storage);

    expect(loadWorkspace(storage).sidebarWidth).toBe(336);
  });

  it("uses seed state for malformed persisted content", () => {
    const storage = { getItem: () => "{not-json" };
    expect(loadWorkspace(storage)).toEqual(createSeedState());
  });

  it("normalizes legacy themes without changing their visual values", () => {
    const state = createSeedState();
    const { selection: _selection, ...legacyTheme } = state.theme;
    const storage = { getItem: () => JSON.stringify({ ...state, theme: legacyTheme }) };

    expect(loadWorkspace(storage).theme).toEqual({
      ...legacyTheme,
      selection: { kind: "custom" },
    });
  });

  it("defaults sidebar width for legacy persisted workspaces", () => {
    const state = createSeedState();
    const { sidebarWidth: _sidebarWidth, ...legacyState } = state;
    const storage = { getItem: () => JSON.stringify(legacyState) };

    expect(loadWorkspace(storage).sidebarWidth).toBe(DEFAULT_SIDEBAR_WIDTH);
  });

  it("loads legacy units without settings and normalizes optional question settings in version 1", () => {
    const state = createSeedState();
    const unitId = state.unitOrder[0];
    const storage = {
      getItem: () => JSON.stringify({
        ...state,
        units: {
          ...state.units,
          [unitId]: {
            ...state.units[unitId],
            questionSettings: {
              enabledFormats: ["singleChoice", "selectBlank", "translation", "unknown"],
              customTemplates: [{
                id: "daily-greeting",
                name: "  Daily greeting  ",
                baseFormat: "selectBlank",
                guidance: "  Use one greeting.  ",
              }],
            },
          },
        },
      }),
    };

    const loaded = loadWorkspace(storage);
    expect(loaded.version).toBe(1);
    expect(loaded.units[unitId].questionSettings?.enabledFormats).toEqual(["singleChoice", "selectBlank", "translation"]);
    expect(loaded.units[unitId].questionSettings?.customTemplates[0]).toMatchObject({
      name: "Daily greeting",
      guidance: "Use one greeting.",
      enabled: true,
    });

    const legacyStorage = { getItem: () => JSON.stringify(state) };
    expect(loadWorkspace(legacyStorage).units[unitId].questionSettings).toBeUndefined();
  });
});

describe("unit names", () => {
  it("strips legacy numbering prefixes without changing clean names", () => {
    expect(cleanUnitName("Unit 02 \u00b7 Daily Rhythm")).toBe("Daily Rhythm");
    expect(cleanUnitName("Unit 02 \u00c2\u00b7 Daily Rhythm")).toBe("Daily Rhythm");
    expect(cleanUnitName("Daily Rhythm")).toBe("Daily Rhythm");
  });
});

describe("theme drafts", () => {
  it("edits a cloned draft without changing the applied theme", () => {
    const applied = cloneTheme(DEFAULT_THEME);
    const draft = updateThemeStop(applied, 0, "#123456");

    expect(draft.colorStops[0]).toBe("#123456");
    expect(draft.selection).toEqual({ kind: "custom" });
    expect(applied.colorStops[0]).toBe(DEFAULT_THEME.colorStops[0]);
  });

  it("supports one to eight color stops and surprises themes predictably", () => {
    const oneStop = { ...DEFAULT_THEME, colorStops: ["#111111"] };
    const stillOne = removeThemeStop(oneStop, 0);
    const withStop = addThemeStop(oneStop);
    const full = { ...DEFAULT_THEME, colorStops: Array.from({ length: 8 }, () => "#222222") };
    const stillFull = addThemeStop(full);
    const surprised = surpriseTheme(DEFAULT_THEME, () => 0);

    expect(stillOne.colorStops).toEqual(["#111111"]);
    expect(withStop.colorStops).toEqual(["#111111", "#111111"]);
    expect(stillFull.colorStops).toHaveLength(8);
    expect(surprised.colorStops).toEqual(["#6757F5", "#9B5CF6", "#D15BEC", "#F06EAF"]);
    expect(surprised.intensity).toBe(62);
    expect(surprised.selection).toEqual({ kind: "custom" });
  });

  it("round-trips HSV colors and validates hex input", () => {
    expect(hsvToHex(hexToHsv("#BE58F2"))).toBe("#BE58F2");
    expect(hsvToHex({ h: 0, s: 100, v: 100 })).toBe("#FF0000");
    expect(isValidHex("#123ABC")).toBe(true);
    expect(isValidHex("#123")).toBe(false);
  });

  it("maps pointer coordinates into saturation and brightness", () => {
    expect(saturationValueFromPointer(50, 25, 100, 100)).toEqual({ s: 50, v: 75 });
    expect(saturationValueFromPointer(-10, 110, 100, 100)).toEqual({ s: 0, v: 0 });
  });

  it("uses intensity to produce visibly different tinted surfaces", () => {
    const quiet = themeStyle({ ...DEFAULT_THEME, intensity: 20 });
    const vivid = themeStyle({ ...DEFAULT_THEME, intensity: 100 });

    expect(quiet["--bg-main"]).not.toBe(vivid["--bg-main"]);
    expect(vivid["--bg-main"]).toContain("linear-gradient");
  });

  it("renders selected base themes as untinted surfaces with a standard accent", () => {
    const neutral = themeStyle(selectBaseTheme(DEFAULT_THEME, "midnight"));
    const collectionAccent = themeStyle(
      selectBaseTheme({ ...DEFAULT_THEME, useCollectionAccents: true }, "dusk"),
      "#123456",
    );

    expect(neutral["--bg-main"]).toBe("#1C2230");
    expect(neutral["--bg-main"]).not.toContain("linear-gradient");
    expect(neutral["--accent"]).toBe("#655BF5");
    expect(collectionAccent["--accent"]).toBe("#123456");
  });

  it("derives readable text and foreground colors for extreme accents", () => {
    const lightTheme = selectBaseTheme(DEFAULT_THEME, "light");
    const lightAccent = accentStyle(lightTheme, "#FFFFFF");
    const darkAccent = accentStyle(selectBaseTheme(DEFAULT_THEME, "black"), "#FFFFFF");

    expect(contrastTextColor("#FFFFFF")).toBe("#17171C");
    expect(contrastTextColor("#000000")).toBe("#FFFFFF");
    expect(lightAccent["--accent"]).toBe("#FFFFFF");
    expect(lightAccent["--accent-contrast"]).toBe("#17171C");
    expect(lightAccent["--accent-readable"]).not.toBe("#FFFFFF");
    expect(darkAccent["--accent-readable"]).toBe("#FFFFFF");
  });

  it("applies color presets as canonical dusk themes while retaining preferences", () => {
    const preset = COLOR_THEME_PRESETS.find(({ id }) => id === "spring");
    const selected = selectColorTheme({ ...DEFAULT_THEME, syncAcrossDevices: false }, "spring");

    expect(selected.selection).toEqual({ kind: "palette", id: "spring" });
    expect(selected.base).toBe("dusk");
    expect(selected.colorStops).toEqual(preset?.colorStops);
    expect(selected.gradientDirection).toBe(135);
    expect(selected.intensity).toBe(74);
    expect(selected.syncAcrossDevices).toBe(false);
  });

  it("reconciles complete custom preset matches without collapsing modified drafts", () => {
    const selected = selectColorTheme(DEFAULT_THEME, "orchid");
    const matchingCustom = markThemeCustom(selected);
    const modifiedCustom = markThemeCustom({ ...selected, intensity: 75 });

    expect(reconcileThemeSelection(matchingCustom).selection).toEqual({ kind: "palette", id: "orchid" });
    expect(reconcileThemeSelection(modifiedCustom).selection).toEqual({ kind: "custom" });
  });

  it("resets to the graphite-lilac custom theme and clones stored selections", () => {
    const selected = selectColorTheme(DEFAULT_THEME, "golden");
    const cloned = cloneTheme(selected);
    const reset = resetTheme();

    expect(normalizeThemeConfig().selection).toEqual({ kind: "custom" });
    expect(reset).toEqual(DEFAULT_THEME);
    expect(reset.selection).toEqual({ kind: "custom" });
    expect(cloned).toEqual(selected);
    expect(cloned).not.toBe(selected);
    expect(cloned.selection).not.toBe(selected.selection);
  });
});
