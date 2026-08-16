import { describe, expect, test } from "bun:test"
import type { ReactElement } from "react"
import { brandThemes } from "../../src/tui/brand.ts"
import { PolicyBadge } from "../../src/tui/codex-session.tsx"
import { confirmationAccepted, fullAccessWarnings } from "../../src/tui/full-access-confirmation.tsx"

function collectText(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") {
    out.push(node)
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (node && typeof node === "object" && "props" in node) {
    collectText((node as ReactElement<{ children?: unknown }>).props.children, out)
  }
  return out
}

describe("safety indicator", () => {
  test("renders FULL ACCESS on the destructive background in both palettes", () => {
    for (const palette of [brandThemes.dark, brandThemes.light]) {
      const element = PolicyBadge({
        policy: { sandbox: "danger-full-access", approvalPolicy: "on-request" },
        palette,
      }) as ReactElement<{ fg?: string; bg?: string }>

      expect(element.props.bg).toBe(palette.destructive)
      expect(element.props.fg).toBe(palette.background)
      expect(collectText(element).join("")).toContain("FULL ACCESS")
    }
  })

  test("renders ordinary sandbox modes without alarm styling", () => {
    const palette = brandThemes.dark
    for (const sandbox of ["read-only", "workspace-write"] as const) {
      const element = PolicyBadge({
        policy: { sandbox, approvalPolicy: "on-request" },
        palette,
      }) as ReactElement<{ fg?: string; bg?: string }>

      expect(element.props.bg).toBeUndefined()
      expect(element.props.fg).toBe(palette.accent)
      expect(collectText(element).join("")).toContain(sandbox)
    }
  })

  test("only a deliberate yes confirms full access", () => {
    expect(confirmationAccepted("yes")).toBe(true)
    expect(confirmationAccepted("  YES  ")).toBe(true)
    expect(confirmationAccepted("y")).toBe(false)
    expect(confirmationAccepted("")).toBe(false)
    expect(confirmationAccepted("yes!")).toBe(false)
    expect(confirmationAccepted("no")).toBe(false)
  })

  test("the confirmation names the concrete consequences", () => {
    const combined = fullAccessWarnings.join(" ")
    expect(combined).toContain("WITHOUT a sandbox")
    expect(combined).toContain("delete")
    expect(combined).toContain("network")
  })
})
