import { describe, expect, test } from "bun:test"
import {
  brandLockupMode,
  brandThemes,
  waveLogo,
  wordmarkAgent,
  wordmarkCodeSplash,
} from "../../src/tui/brand.ts"

describe("CodeSplash terminal brand", () => {
  test("uses the documented Ocean & Heat palettes", () => {
    expect(brandThemes.dark).toMatchObject({
      background: "#090E15",
      panel: "#121826",
      muted: "#8B9AB1",
      accent: "#7AD7FF",
      action: "#FF7857",
      border: "#222A3A",
    })
    expect(brandThemes.light).toMatchObject({
      background: "#F5F7FA",
      panel: "#FFFFFF",
      muted: "#576375",
      accent: "#0976A5",
      action: "#BF3918",
      border: "#D3DAE3",
    })
  })

  test("keeps three equal waves with two-cell flats", () => {
    const lines = waveLogo.split("\n")
    expect(lines).toHaveLength(6)
    expect(new Set(lines.map((line) => line.length))).toEqual(new Set([13]))
    expect(lines.filter((line) => line === "▄  ▄▀▀▄  ▄▀▀▄")).toHaveLength(3)
    expect(lines.filter((line) => line === " ▀▀    ▀▀    ")).toHaveLength(3)
  })

  test("renders the CodeSplash Agent wordmark with equal spacing", () => {
    const codeSplashLines = wordmarkCodeSplash.split("\n")
    const agentLines = wordmarkAgent.split("\n")
    expect(codeSplashLines).toHaveLength(5)
    expect(agentLines).toHaveLength(5)
    expect(new Set(codeSplashLines.map((line) => line.length))).toEqual(new Set([49]))
    expect(new Set(agentLines.map((line) => line.length))).toEqual(new Set([24]))
    expect(13 + 3 + (codeSplashLines[0]?.length ?? 0) + 3 + (agentLines[0]?.length ?? 0)).toBe(92)
  })

  test("simplifies the lockup as the terminal narrows", () => {
    expect(brandLockupMode(120)).toBe("full")
    expect(brandLockupMode(100)).toBe("full")
    expect(brandLockupMode(99)).toBe("name")
    expect(brandLockupMode(72)).toBe("name")
    expect(brandLockupMode(71)).toBe("logo")
  })
})
