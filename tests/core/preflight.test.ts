import { describe, expect, test } from "bun:test"
import { inspectProject } from "../../src/core/preflight.ts"

describe("inspectProject", () => {
  test("validates the working directory and reads Git state", async () => {
    const result = await inspectProject(process.cwd())

    expect(result.cwd).toBe(process.cwd())
    expect(result.git.available).toBe(true)
    expect(result.git.repository).toBe(true)
    expect(result.git.changedFiles).toBeGreaterThanOrEqual(0)
  })

  test("rejects a missing working directory with an actionable error", async () => {
    await expect(inspectProject(`/tmp/codesplash-agent-missing-${crypto.randomUUID()}`)).rejects.toThrow(
      "Cannot open working directory",
    )
  })
})
