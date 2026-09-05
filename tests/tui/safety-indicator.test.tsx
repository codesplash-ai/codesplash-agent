import { describe, expect, test } from "bun:test"
import type { ReactElement } from "react"
import { brandThemes } from "../../src/tui/brand.ts"
import { PermissionModeBadge, PolicyBadge } from "../../src/tui/codex-session.tsx"
import {
  bypassApprovalsConfirmationContent,
  bypassApprovalsWarnings,
  confirmationAccepted,
  fullAccessConfirmationContent,
  fullAccessWarnings,
} from "../../src/tui/full-access-confirmation.tsx"

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

describe("permission mode badge", () => {
  test("renders BYPASS in the same inverse alarm style as FULL ACCESS, in both palettes", () => {
    for (const palette of [brandThemes.dark, brandThemes.light]) {
      const element = PermissionModeBadge({ mode: "bypass", palette }) as ReactElement<{
        fg?: string
        bg?: string
      }>
      expect(element.props.bg).toBe(palette.destructive)
      expect(element.props.fg).toBe(palette.background)
      expect(collectText(element).join("")).toContain("BYPASS")
    }
  })

  test("renders PLAN and ACCEPT EDITS as accent text without alarm styling", () => {
    const palette = brandThemes.dark
    for (const [mode, label] of [
      ["plan", "PLAN"],
      ["accept-edits", "ACCEPT EDITS"],
    ] as const) {
      const element = PermissionModeBadge({ mode, palette }) as ReactElement<{ fg?: string; bg?: string }>
      expect(element.props.bg).toBeUndefined()
      expect(element.props.fg).toBe(palette.accent)
      expect(collectText(element).join("")).toContain(label)
    }
  })

  test("default mode renders no badge at all", () => {
    expect(PermissionModeBadge({ mode: "default", palette: brandThemes.dark })).toBeNull()
  })
})

describe("bypass approvals confirmation", () => {
  test("uses the same deliberate typed-yes gate as full access", () => {
    // Both dangerous flags share one typed-confirmation shell; "yes" is the only accepted input.
    expect(confirmationAccepted("yes")).toBe(true)
    expect(bypassApprovalsConfirmationContent.title).toBe("BYPASS APPROVALS REQUESTED")
    expect(bypassApprovalsConfirmationContent.heading).toContain("--bypass-approvals")
    expect(fullAccessConfirmationContent.warnings).toBe(fullAccessWarnings)
  })

  test("names what bypass does, what still asks, and that it is never persisted", () => {
    const combined = bypassApprovalsWarnings.join(" ")
    expect(combined).toContain("auto-approve")
    expect(combined).toContain("still stop and ask")
    expect(combined).toContain("never persisted")
    // The honest layering caveat: protected paths stay blocked even in bypass.
    expect(combined).toContain(".git")
  })
})
