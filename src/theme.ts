import type { CSSProperties } from "react";
import { DEFAULT_THEME } from "./store";
import type { BaseTheme, ColorThemeId, ThemeConfig } from "./types";

const BASE_SURFACES = {
  light: {
    rail: "#E4E3E9",
    sidebar: "#F0EFF4",
    main: "#FCFCFD",
    panel: "#F6F5F8",
    elevated: "#FFFFFF",
    hover: "#E9E7EF",
    selected: "#DED9F7",
    text: "#24242B",
    secondary: "#686873",
    muted: "#888894",
    border: "rgba(46, 44, 60, .12)",
  },
  dusk: {
    rail: "#18191F",
    sidebar: "#202127",
    main: "#292A31",
    panel: "#24252B",
    elevated: "#303139",
    hover: "#343640",
    selected: "#3C3D49",
    text: "#F3F3F5",
    secondary: "#B5B6C0",
    muted: "#858792",
    border: "rgba(255, 255, 255, .08)",
  },
  midnight: {
    rail: "#10131B",
    sidebar: "#161B26",
    main: "#1C2230",
    panel: "#181E29",
    elevated: "#252C3B",
    hover: "#2A3445",
    selected: "#303E50",
    text: "#EFF5F5",
    secondary: "#AABBC2",
    muted: "#7D8B94",
    border: "rgba(166, 199, 204, .1)",
  },
  black: {
    rail: "#08080A",
    sidebar: "#101012",
    main: "#151518",
    panel: "#111114",
    elevated: "#1D1D21",
    hover: "#25252B",
    selected: "#2C2C34",
    text: "#F7F7FA",
    secondary: "#B8B8C1",
    muted: "#85858F",
    border: "rgba(255, 255, 255, .09)",
  },
} as const;

export type ThemeStyle = CSSProperties & Record<`--${string}`, string>;
export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface HsvColor {
  h: number;
  s: number;
  v: number;
}

const FALLBACK_COLOR = "#655BF5";
const COLOR_THEME_DIRECTION = 135;
const COLOR_THEME_INTENSITY = 74;

export const COLOR_THEME_PRESETS: { id: ColorThemeId; colorStops: string[] }[] = [
  { id: "orchid", colorStops: ["#8B7CF6", "#A855F7", "#BE58F2", "#E56BD4"] },
  { id: "spring", colorStops: ["#A8D8B0", "#D4E8A8", "#EFF0C2", "#F5DCA8"] },
  { id: "sunset", colorStops: ["#F0A58B", "#EFC981", "#F5DDAB", "#E996A7"] },
  { id: "lagoon", colorStops: ["#7CA9E8", "#86C6DB", "#A8D9D0", "#CCDCC6"] },
  { id: "lavender", colorStops: ["#D98FA6", "#D7AFD8", "#C9B7F3", "#A68CE7"] },
  { id: "meadow", colorStops: ["#E9E0C2", "#D2E6C6", "#B0D8CB", "#85B6B5"] },
  { id: "ember", colorStops: ["#EA6E75", "#ED9C75", "#E7B36E", "#DCC777"] },
  { id: "cobalt", colorStops: ["#2E75DE", "#295ED0", "#4F53C8", "#733EB4"] },
  { id: "forest", colorStops: ["#196D66", "#2D907C", "#70B584", "#A3C77E"] },
  { id: "berry", colorStops: ["#D25082", "#CA5CA0", "#A65BBC", "#6B4CD7"] },
  { id: "ocean", colorStops: ["#544A91", "#5E64AD", "#527FB5", "#418F9A"] },
  { id: "golden", colorStops: ["#AF6A30", "#C78B3F", "#E0B153", "#EAC96C"] },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isValidHex(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

export function normalizeHex(value: string, fallback = FALLBACK_COLOR): string {
  return (isValidHex(value) ? value : fallback).toUpperCase();
}

export function hexToRgb(value: string): RgbColor {
  const hex = normalizeHex(value).slice(1);
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }: RgbColor): string {
  const channel = (value: number) => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`.toUpperCase();
}

export function rgbToHsv({ r, g, b }: RgbColor): HsvColor {
  const red = clamp(r, 0, 255) / 255;
  const green = clamp(g, 0, 255) / 255;
  const blue = clamp(b, 0, 255) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;

  if (delta) {
    if (max === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (max === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }

  return {
    h: hue < 0 ? hue + 360 : hue,
    s: max ? (delta / max) * 100 : 0,
    v: max * 100,
  };
}

export function hsvToRgb({ h, s, v }: HsvColor): RgbColor {
  const hue = ((h % 360) + 360) % 360;
  const saturation = clamp(s, 0, 100) / 100;
  const value = clamp(v, 0, 100) / 100;
  const chroma = value * saturation;
  const section = hue / 60;
  const middle = chroma * (1 - Math.abs((section % 2) - 1));
  const offset = value - chroma;
  const channels =
    section < 1 ? [chroma, middle, 0] :
    section < 2 ? [middle, chroma, 0] :
    section < 3 ? [0, chroma, middle] :
    section < 4 ? [0, middle, chroma] :
    section < 5 ? [middle, 0, chroma] :
    [chroma, 0, middle];

  return {
    r: Math.round((channels[0] + offset) * 255),
    g: Math.round((channels[1] + offset) * 255),
    b: Math.round((channels[2] + offset) * 255),
  };
}

export function hexToHsv(value: string): HsvColor {
  return rgbToHsv(hexToRgb(value));
}

export function hsvToHex(value: HsvColor): string {
  return rgbToHex(hsvToRgb(value));
}

export function saturationValueFromPointer(
  x: number,
  y: number,
  width: number,
  height: number,
): Pick<HsvColor, "s" | "v"> {
  return {
    s: Math.round(clamp(x / Math.max(width, 1), 0, 1) * 100),
    v: Math.round((1 - clamp(y / Math.max(height, 1), 0, 1)) * 100),
  };
}

export function cloneTheme(theme: ThemeConfig): ThemeConfig {
  return { ...theme, selection: { ...theme.selection }, colorStops: [...theme.colorStops] };
}

export function resetTheme(): ThemeConfig {
  return cloneTheme(DEFAULT_THEME);
}

export function markThemeCustom(theme: ThemeConfig): ThemeConfig {
  return { ...theme, selection: { kind: "custom" } };
}

export function selectBaseTheme(theme: ThemeConfig, base: BaseTheme): ThemeConfig {
  return { ...theme, base, selection: { kind: "base", id: base } };
}

export function selectColorTheme(theme: ThemeConfig, id: ColorThemeId): ThemeConfig {
  const preset = COLOR_THEME_PRESETS.find((themePreset) => themePreset.id === id);
  if (!preset) return theme;
  return {
    ...theme,
    selection: { kind: "palette", id },
    base: "dusk",
    colorStops: [...preset.colorStops],
    gradientDirection: COLOR_THEME_DIRECTION,
    intensity: COLOR_THEME_INTENSITY,
  };
}

function hasSameStops(first: string[], second: string[]): boolean {
  return first.length === second.length
    && first.every((color, index) => normalizeHex(color) === normalizeHex(second[index]));
}

export function reconcileThemeSelection(theme: ThemeConfig): ThemeConfig {
  if (theme.selection.kind !== "custom") return theme;
  const preset = COLOR_THEME_PRESETS.find(({ colorStops }) => (
    theme.base === "dusk"
    && theme.gradientDirection === COLOR_THEME_DIRECTION
    && theme.intensity === COLOR_THEME_INTENSITY
    && hasSameStops(theme.colorStops, colorStops)
  ));
  return preset ? { ...theme, selection: { kind: "palette", id: preset.id } } : theme;
}

export function updateThemeStop(theme: ThemeConfig, index: number, value: string): ThemeConfig {
  const colorStops = [...theme.colorStops];
  colorStops[index] = normalizeHex(value, colorStops[index]);
  return markThemeCustom({ ...theme, colorStops });
}

export function addThemeStop(theme: ThemeConfig): ThemeConfig {
  if (theme.colorStops.length >= 8) return theme;
  return markThemeCustom({
    ...theme,
    colorStops: [...theme.colorStops, theme.colorStops[theme.colorStops.length - 1] ?? "#BE58F2"],
  });
}

export function removeThemeStop(theme: ThemeConfig, index: number): ThemeConfig {
  if (theme.colorStops.length <= 1) return theme;
  return markThemeCustom({ ...theme, colorStops: theme.colorStops.filter((_, itemIndex) => itemIndex !== index) });
}

const SURPRISE_PALETTES = [
  ["#6757F5", "#9B5CF6", "#D15BEC", "#F06EAF"],
  ["#1F8A89", "#39B8A3", "#84C69B", "#D7DFA3"],
  ["#0C6BE8", "#2E9AF4", "#6BC6ED", "#BDE7F0"],
  ["#E05C5C", "#ED8B52", "#EABF66", "#C8D87A"],
];

export function surpriseTheme(theme: ThemeConfig, random = Math.random): ThemeConfig {
  const palette = SURPRISE_PALETTES[Math.floor(random() * SURPRISE_PALETTES.length)];
  return markThemeCustom({
    ...theme,
    colorStops: [...palette],
    gradientDirection: Math.round(random() * 180),
    intensity: 62 + Math.round(random() * 28),
  });
}

export function themeStyle(theme: ThemeConfig, collectionAccent?: string): ThemeStyle {
  const surface = BASE_SURFACES[theme.base];
  const colors = theme.colorStops.length ? theme.colorStops.map((stop) => normalizeHex(stop)) : [FALLBACK_COLOR];
  const accent = normalizeHex(
    theme.useCollectionAccents && collectionAccent
      ? collectionAccent
      : theme.selection.kind === "base" ? FALLBACK_COLOR : colors[0],
  );
  const stops = colors.join(", ");
  const tintStrength = 0.035 + clamp(theme.intensity, 20, 100) / 100 * 0.2;
  const tintedSurface = (base: string, multiplier: number) => {
    const tintedStops = colors
      .map((color) => {
        const { r, g, b } = hexToRgb(color);
        return `rgba(${r}, ${g}, ${b}, ${(tintStrength * multiplier).toFixed(3)})`;
      })
      .join(", ");
    return `linear-gradient(${theme.gradientDirection}deg, ${tintedStops}), ${base}`;
  };
  const themedSurface = (base: string, multiplier: number) => (
    theme.selection.kind === "base" ? base : tintedSurface(base, multiplier)
  );
  return {
    "--bg-rail": themedSurface(surface.rail, 0.72),
    "--bg-sidebar": themedSurface(surface.sidebar, 0.82),
    "--bg-main": themedSurface(surface.main, 1),
    "--bg-panel": themedSurface(surface.panel, 0.9),
    "--bg-elevated": themedSurface(surface.elevated, 0.75),
    "--bg-hover": surface.hover,
    "--bg-selected": surface.selected,
    "--text-primary": surface.text,
    "--text-secondary": surface.secondary,
    "--text-muted": surface.muted,
    "--border": surface.border,
    "--accent": accent,
    "--accent-soft": `${accent}32`,
    "--highlight": "#E7AD67",
    "--theme-gradient": `linear-gradient(${theme.gradientDirection}deg, ${stops})`,
    "--theme-intensity": `${theme.intensity}%`,
  };
}
