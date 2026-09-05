import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readTrustDecision, writeTrustDecision } from "../../src/core/index.ts"
import {
  applyTrustGateChoice,
  resolveWorkspaceTrust,
  type TrustGateChoice,
  trustGateChoiceForKey,
  trustGateExplanation,
} from "../../src/tui/trust-gate.tsx"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codesplash-agent-trust-gate-"))
  temporaryDirectories.push(directory)
  return directory
}

describe("trust gate keys", () => {
  test("T trusts, N defers, Esc backs out, everything else is ignored", () => {
    expect(trustGateChoiceForKey("t")).toBe("trust")
    expect(trustGateChoiceForKey("n")).toBe("not-now")
    expect(trustGateChoiceForKey("escape")).toBe("back")
    expect(trustGateChoiceForKey("y")).toBeUndefined()
    expect(trustGateChoiceForKey("return")).toBeUndefined()
  })

  test("the screen names exactly what trust gates", () => {
    const combined = trustGateExplanation.join(" ")
    expect(combined).toContain("AGENTS.md")
    expect(combined).toContain("CLAUDE.md")
    expect(combined).toContain(".codesplash/permissions.toml")
    expect(combined).toContain("persists nothing")
  })
})

describe("trust gate decisions", () => {
  test("trusting persists true and resolves trusted", async () => {
    const dataDir = await temporaryDirectory()
    const workspace = await temporaryDirectory()

    expect(await applyTrustGateChoice("trust", workspace, dataDir)).toBe(true)

    const stored = await readTrustDecision(workspace, dataDir)
    expect(stored?.trusted).toBe(true)
    // decidedAt is strict ISO-8601 (written by the trust store).
    expect(new Date(stored?.decidedAt ?? "").toISOString()).toBe(stored?.decidedAt ?? "")
  })

  test("not now opens untrusted and persists nothing — the gate asks again next time", async () => {
    const dataDir = await temporaryDirectory()
    const workspace = await temporaryDirectory()

    expect(await applyTrustGateChoice("not-now", workspace, dataDir)).toBe(false)
    expect(await readTrustDecision(workspace, dataDir)).toBeUndefined()
  })

  test("backing out resolves undefined and persists nothing", async () => {
    const dataDir = await temporaryDirectory()
    const workspace = await temporaryDirectory()

    expect(await applyTrustGateChoice("back", workspace, dataDir)).toBeUndefined()
    expect(await readTrustDecision(workspace, dataDir)).toBeUndefined()
  })
})

describe("workspace trust resolution before session open", () => {
  test("shows the gate only for undecided workspaces and applies its choice", async () => {
    const dataDir = await temporaryDirectory()
    const workspace = await temporaryDirectory()
    let gateShown = 0
    const gate = (choice: TrustGateChoice) => () => {
      gateShown += 1
      return Promise.resolve(choice)
    }

    expect(await resolveWorkspaceTrust(workspace, gate("not-now"), dataDir)).toBe(false)
    expect(gateShown).toBe(1)
    // Nothing persisted: the next open asks again.
    expect(await resolveWorkspaceTrust(workspace, gate("trust"), dataDir)).toBe(true)
    expect(gateShown).toBe(2)
  })

  test("a stored decision (either way) skips the gate entirely", async () => {
    const dataDir = await temporaryDirectory()
    const trusted = await temporaryDirectory()
    const distrusted = await temporaryDirectory()
    await writeTrustDecision(trusted, true, dataDir)
    // Only true is ever persisted this tranche, but a stored false must also be honored.
    await writeTrustDecision(distrusted, false, dataDir)
    const failGate = () => Promise.reject<TrustGateChoice>(new Error("gate must not be shown"))

    expect(await resolveWorkspaceTrust(trusted, failGate, dataDir)).toBe(true)
    expect(await resolveWorkspaceTrust(distrusted, failGate, dataDir)).toBe(false)
  })

  test("backing out of the gate bubbles up as undefined so the caller can return home", async () => {
    const dataDir = await temporaryDirectory()
    const workspace = await temporaryDirectory()

    expect(await resolveWorkspaceTrust(workspace, () => Promise.resolve("back"), dataDir)).toBeUndefined()
    expect(await readTrustDecision(workspace, dataDir)).toBeUndefined()
  })
})
