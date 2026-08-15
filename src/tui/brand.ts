import type { ThemeMode } from "@opentui/core"

export type BrandPalette = {
  background: string
  panel: string
  popover: string
  foreground: string
  muted: string
  accent: string
  action: string
  actionForeground: string
  border: string
  secondary: string
  destructive: string
}

/** Exact CodeSplash "Ocean & Heat" tokens from codesplash-website/docs/BRAND.md. */
export const brandThemes: Record<ThemeMode, BrandPalette> = {
  dark: {
    background: "#090E15",
    panel: "#121826",
    popover: "#0E1420",
    foreground: "#C8D4E4",
    muted: "#8B9AB1",
    accent: "#7AD7FF",
    action: "#FF7857",
    actionForeground: "#0C121D",
    border: "#222A3A",
    secondary: "#1D2435",
    destructive: "#F67483",
  },
  light: {
    background: "#F5F7FA",
    panel: "#FFFFFF",
    popover: "#FFFFFF",
    foreground: "#191C24",
    muted: "#576375",
    accent: "#0976A5",
    action: "#BF3918",
    actionForeground: "#FFFFFF",
    border: "#D3DAE3",
    secondary: "#E6EAF0",
    destructive: "#C52033",
  },
}

/** Three copies of the CodeSplash path using heavy terminal-native strokes. */
export const waveLogo = [
  "▄  ▄▀▀▄  ▄▀▀▄",
  " ▀▀    ▀▀    ",
  "▄  ▄▀▀▄  ▄▀▀▄",
  " ▀▀    ▀▀    ",
  "▄  ▄▀▀▄  ▄▀▀▄",
  " ▀▀    ▀▀    ",
].join("\n")

const wordmarkGlyphs: Record<string, readonly string[]> = {
  A: [" ██ ", "█  █", "████", "█  █", "█  █"],
  C: ["████", "█   ", "█   ", "█   ", "████"],
  D: ["███ ", "█  █", "█  █", "█  █", "███ "],
  E: ["████", "█   ", "███ ", "█   ", "████"],
  G: ["████", "█   ", "█ ██", "█  █", "████"],
  H: ["█  █", "█  █", "████", "█  █", "█  █"],
  I: ["████", " ██ ", " ██ ", " ██ ", "████"],
  L: ["█   ", "█   ", "█   ", "█   ", "████"],
  N: ["█  █", "██ █", "████", "█ ██", "█  █"],
  O: ["████", "█  █", "█  █", "█  █", "████"],
  P: ["████", "█  █", "████", "█   ", "█   "],
  S: ["████", "█   ", "████", "   █", "████"],
  T: ["████", " ██ ", " ██ ", " ██ ", " ██ "],
  " ": [" ", " ", " ", " ", " "],
}

/** Compact, readable five-row terminal wordmark segments with separated E bars. */
export const wordmarkCodeSplash = renderWordmark("CODESPLASH")
export const wordmarkAgent = renderWordmark("AGENT")

export type BrandLockupMode = "full" | "name" | "logo"

/** Select a lockup that fits inside the welcome screen's 94%-wide content area. */
export function brandLockupMode(terminalWidth: number): BrandLockupMode {
  if (terminalWidth >= 100) return "full"
  if (terminalWidth >= 72) return "name"
  return "logo"
}

function renderWordmark(value: string): string {
  return Array.from({ length: 5 }, (_, row) =>
    [...value].map((character) => wordmarkGlyphs[character]?.[row] ?? "").join(" "),
  ).join("\n")
}
