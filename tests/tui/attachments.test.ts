import { describe, expect, test } from "bun:test"
import { extractImageAttachments, MAX_IMAGE_BYTES, type PathProbe } from "../../src/tui/attachments.ts"

function probeFor(files: Record<string, number>): PathProbe {
  return (path) => {
    const size = files[path]
    return size === undefined ? { exists: false, size: 0 } : { exists: true, size }
  }
}

describe("extractImageAttachments", () => {
  test("extracts an existing image path and replaces it with an inline marker", () => {
    const probe = probeFor({ "/tmp/shot.png": 1024 })
    const result = extractImageAttachments("what is wrong here /tmp/shot.png please fix", probe)
    expect(result.images).toEqual(["/tmp/shot.png"])
    expect(result.text).toBe("what is wrong here [image: shot.png] please fix")
    expect(result.warnings).toEqual([])
  })

  test("handles quoted paths containing spaces, as terminals insert on drag-and-drop", () => {
    const probe = probeFor({ "/tmp/My Screens/shot 1.png": 2048 })
    const result = extractImageAttachments("look at '/tmp/My Screens/shot 1.png' closely", probe)
    expect(result.images).toEqual(["/tmp/My Screens/shot 1.png"])
    expect(result.text).toBe("look at [image: shot 1.png] closely")
  })

  test("handles backslash-escaped spaces in bare paths", () => {
    const probe = probeFor({ "/tmp/my shot.jpeg": 10 })
    const result = extractImageAttachments("/tmp/my\\ shot.jpeg", probe)
    expect(result.images).toEqual(["/tmp/my shot.jpeg"])
    expect(result.text).toBe("[image: my shot.jpeg]")
  })

  test("leaves image-looking paths that do not exist as plain text", () => {
    const result = extractImageAttachments("see docs/missing.png for details", probeFor({}))
    expect(result.images).toEqual([])
    expect(result.text).toBe("see docs/missing.png for details")
    expect(result.warnings).toEqual([])
  })

  test("warns about oversize images and keeps them as text", () => {
    const probe = probeFor({ "/tmp/huge.png": MAX_IMAGE_BYTES + 1 })
    const result = extractImageAttachments("/tmp/huge.png", probe)
    expect(result.images).toEqual([])
    expect(result.text).toBe("/tmp/huge.png")
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain("huge.png")
  })

  test("ignores non-image tokens entirely", () => {
    const probe = probeFor({ "/tmp/notes.txt": 5, "/tmp/app.ts": 5 })
    const result = extractImageAttachments("read /tmp/notes.txt and /tmp/app.ts", probe)
    expect(result.images).toEqual([])
    expect(result.text).toBe("read /tmp/notes.txt and /tmp/app.ts")
  })

  test("extracts multiple images in order and is case-insensitive on extensions", () => {
    const probe = probeFor({ "/a/one.PNG": 1, "/b/two.webp": 2 })
    const result = extractImageAttachments("/a/one.PNG then /b/two.webp", probe)
    expect(result.images).toEqual(["/a/one.PNG", "/b/two.webp"])
    expect(result.text).toBe("[image: one.PNG] then [image: two.webp]")
  })

  test("a prompt that is only an image still carries marker text", () => {
    const probe = probeFor({ "/tmp/only.gif": 7 })
    const result = extractImageAttachments("  /tmp/only.gif  ", probe)
    expect(result.images).toEqual(["/tmp/only.gif"])
    expect(result.text).toBe("[image: only.gif]")
  })
})
