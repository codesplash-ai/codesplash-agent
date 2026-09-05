import { describe, expect, test } from "bun:test"
import {
  buildPermissionRuleSections,
  deleteSelectedGrant,
  type PermissionRuleView,
  permissionSourceTag,
  permissionTrustLabel,
} from "../../src/tui/codex-session.tsx"

function rule(
  action: PermissionRuleView["action"],
  source: PermissionRuleView["source"],
  raw: string,
): PermissionRuleView {
  return { tool: raw.split("(")[0] ?? raw, action, source, raw }
}

const mergedRules: PermissionRuleView[] = [
  rule("allow", "cli", "bash(bun test *)"),
  rule("allow", "user", "bash(git status *)"),
  rule("allow", "grants", "bash(git diff *)"),
  rule("allow", "grants", "web_fetch(example.com)"),
  rule("ask", "project", "bash(git push *)"),
  rule("deny", "user", "read_file(**/*.secret)"),
  rule("deny", "builtin", "read_file(**/.env)"),
]

describe("permissions overlay rule sections", () => {
  test("groups the merged rules into allow/ask/deny with counts and source tags", () => {
    const sections = buildPermissionRuleSections(mergedRules, 0)
    expect(sections.map((section) => section.header)).toEqual(["Allow (4)", "Ask (1)", "Deny (2)"])
    expect(sections[0]?.rows.map((row) => row.text)).toEqual([
      "bash(bun test *)  [cli]",
      "bash(git status *)  [user]",
      "bash(git diff *)  [grants]",
      "web_fetch(example.com)  [grants]",
    ])
    expect(sections[1]?.rows[0]?.text).toBe("bash(git push *)  [project]")
  })

  test("tags the builtin tier as built-in", () => {
    expect(permissionSourceTag("builtin")).toBe("built-in")
    expect(permissionSourceTag("grants")).toBe("grants")
    const sections = buildPermissionRuleSections(mergedRules, 0)
    expect(sections[2]?.rows.map((row) => row.text)).toContain("read_file(**/.env)  [built-in]")
  })

  test("only remembered grants are selectable, indexed in section order", () => {
    const first = buildPermissionRuleSections(mergedRules, 0)
    const firstSelected = first.flatMap((section) => section.rows).filter((row) => row.selected)
    expect(firstSelected.map((row) => row.text)).toEqual(["bash(git diff *)  [grants]"])

    const second = buildPermissionRuleSections(mergedRules, 1)
    const secondSelected = second.flatMap((section) => section.rows).filter((row) => row.selected)
    expect(secondSelected.map((row) => row.text)).toEqual(["web_fetch(example.com)  [grants]"])

    // Non-grant rows are never selectable, whatever the index.
    for (const index of [0, 1, 5]) {
      const rows = buildPermissionRuleSections(mergedRules, index).flatMap((section) => section.rows)
      for (const row of rows.filter((candidate) => !candidate.isGrant)) {
        expect(row.selected).toBe(false)
      }
    }
  })

  test("an out-of-range selection selects nothing instead of crashing", () => {
    const rows = buildPermissionRuleSections(mergedRules, 99).flatMap((section) => section.rows)
    expect(rows.some((row) => row.selected)).toBe(false)
  })
})

describe("grant deletion", () => {
  test("deletes the selected grant, reloads the merged rules, and notes the new-session scope", async () => {
    const removed: string[] = []
    const refreshed = mergedRules.filter((candidate) => candidate.raw !== "bash(git diff *)")
    const ui = {
      loadRules: () => Promise.resolve(refreshed),
      removeGrant: (grant: string) => {
        removed.push(grant)
        return Promise.resolve()
      },
    }

    const next = await deleteSelectedGrant(ui, mergedRules, 0)
    expect(removed).toEqual(["bash(git diff *)"])
    expect(next.rules).toEqual(refreshed)
    expect(next.notice).toBe("Removed bash(git diff *) (applies to new sessions)")
    expect(next.selectedGrant).toBe(0)
  })

  test("clamps the selection when the last grant was deleted", async () => {
    const refreshed = mergedRules.filter((candidate) => candidate.raw !== "web_fetch(example.com)")
    const ui = {
      loadRules: () => Promise.resolve(refreshed),
      removeGrant: () => Promise.resolve(),
    }

    const next = await deleteSelectedGrant(ui, mergedRules, 1)
    expect(next.selectedGrant).toBe(0)
  })

  test("no-ops without a removable grant or without a grants file", async () => {
    const untouchable = {
      loadRules: () => Promise.reject(new Error("must not reload")),
      removeGrant: () => Promise.reject(new Error("must not remove")),
    }

    // Selection points past the grants: nothing happens.
    const outOfRange = await deleteSelectedGrant(untouchable, mergedRules, 7)
    expect(outOfRange).toEqual({ rules: mergedRules, selectedGrant: 7 })

    // No grants path configured (removeGrant absent): deletion is unavailable.
    const noStore = await deleteSelectedGrant({ loadRules: untouchable.loadRules }, mergedRules, 0)
    expect(noStore).toEqual({ rules: mergedRules, selectedGrant: 0 })
  })
})

describe("workspace trust line", () => {
  test("names exactly what an untrusted workspace loses", () => {
    expect(permissionTrustLabel(true)).toBe("trusted")
    expect(permissionTrustLabel(false)).toContain("project rule files")
    expect(permissionTrustLabel(false)).toContain(".codesplash/permissions.toml")
  })
})
