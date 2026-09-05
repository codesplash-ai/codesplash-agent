import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { readTrustDecision, trustStorePath, writeTrustDecision } from "../../src/core/trust.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe("workspace trust store", () => {
  test("round-trips decisions per workspace and returns undefined for undecided folders", async () => {
    const dataDir = await temporaryDirectory()
    const trustedWorkspace = await temporaryDirectory()
    const distrustedWorkspace = await temporaryDirectory()

    expect(await readTrustDecision(trustedWorkspace, dataDir)).toBeUndefined()

    await writeTrustDecision(trustedWorkspace, true, dataDir)
    await writeTrustDecision(distrustedWorkspace, false, dataDir)

    const trusted = await readTrustDecision(trustedWorkspace, dataDir)
    expect(trusted?.trusted).toBe(true)
    // decidedAt is strict ISO-8601.
    expect(new Date(trusted?.decidedAt ?? "").toISOString()).toBe(trusted?.decidedAt ?? "")

    // The second write kept the first entry.
    expect((await readTrustDecision(distrustedWorkspace, dataDir))?.trusted).toBe(false)
    expect((await readTrustDecision(trustedWorkspace, dataDir))?.trusted).toBe(true)

    // Some other folder is still undecided.
    expect(await readTrustDecision(await temporaryDirectory(), dataDir)).toBeUndefined()
  })

  test("keys by realpath so a symlinked spelling shares the decision", async () => {
    const dataDir = await temporaryDirectory()
    const container = await temporaryDirectory()
    const workspace = join(container, "real")
    await mkdir(workspace)
    const link = join(container, "link")
    await symlink(workspace, link)

    await writeTrustDecision(link, true, dataDir)

    expect((await readTrustDecision(workspace, dataDir))?.trusted).toBe(true)
    expect((await readTrustDecision(link, dataDir))?.trusted).toBe(true)

    // The stored key is the physical path, not the symlinked spelling.
    const store = JSON.parse(await readFile(trustStorePath(dataDir), "utf8")) as {
      version: number
      folders: Record<string, { trusted: boolean; decidedAt: string }>
    }
    expect(store.version).toBe(1)
    expect(Object.keys(store.folders)).toEqual([await realpath(workspace)])
  })

  test("falls back to resolve() for paths realpath cannot canonicalize", async () => {
    const dataDir = await temporaryDirectory()
    const missing = join(await temporaryDirectory(), "not-created-yet")

    await writeTrustDecision(missing, true, dataDir)

    expect((await readTrustDecision(missing, dataDir))?.trusted).toBe(true)
    const store = JSON.parse(await readFile(trustStorePath(dataDir), "utf8")) as {
      folders: Record<string, unknown>
    }
    expect(Object.keys(store.folders)).toEqual([resolve(missing)])
  })

  test("tolerates a corrupt store: reads as empty, rewritten on the next write", async () => {
    const dataDir = await temporaryDirectory()
    const workspace = await temporaryDirectory()
    await Bun.write(trustStorePath(dataDir), "{ not json")

    // Never a crash — corrupt reads as undecided.
    expect(await readTrustDecision(workspace, dataDir)).toBeUndefined()

    await writeTrustDecision(workspace, true, dataDir)
    expect((await readTrustDecision(workspace, dataDir))?.trusted).toBe(true)

    // The rewritten store is valid JSON with the versioned shape.
    const store = JSON.parse(await readFile(trustStorePath(dataDir), "utf8")) as { version: number }
    expect(store.version).toBe(1)
  })

  test("drops malformed entries and wrong-version stores without losing the write path", async () => {
    const dataDir = await temporaryDirectory()
    const workspace = await temporaryDirectory()
    const canonical = await realpath(workspace)
    await Bun.write(
      trustStorePath(dataDir),
      JSON.stringify({
        version: 1,
        folders: {
          [canonical]: { trusted: "yes", decidedAt: 42 },
          "/other": { trusted: true, decidedAt: "2026-01-01T00:00:00.000Z" },
        },
      }),
    )

    // The malformed entry reads as undecided; the intact one survives.
    expect(await readTrustDecision(workspace, dataDir)).toBeUndefined()
    expect((await readTrustDecision("/other", dataDir))?.trusted).toBe(true)

    // A wrong-version store reads as entirely empty.
    await Bun.write(trustStorePath(dataDir), JSON.stringify({ version: 2, folders: {} }))
    expect(await readTrustDecision("/other", dataDir)).toBeUndefined()
  })

  test("writes the store file 0600 with no temp file left behind", async () => {
    const dataDir = await temporaryDirectory()
    const workspace = await temporaryDirectory()

    await writeTrustDecision(workspace, true, dataDir)

    const path = trustStorePath(dataDir)
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600")
    const leftovers = (await Array.fromAsync(new Bun.Glob("*.tmp").scan({ cwd: dataDir }))).sort()
    expect(leftovers).toEqual([])
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codesplash-agent-trust-"))
  temporaryDirectories.push(directory)
  return directory
}
