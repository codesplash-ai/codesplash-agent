import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs"
import { join } from "node:path"
import { type BrandPalette, brandThemes } from "./brand.ts"

export function boundedLocalBytes(path: string, maximum: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > maximum)
      throw new Error(`Expected a regular file within ${maximum} bytes`)
    const bytes = Buffer.alloc(maximum + 1)
    let used = 0
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, used)
      if (!count) break
      used += count
    }
    if (used > maximum) throw new Error("File grew beyond its limit")
    return bytes.subarray(0, used)
  } finally {
    closeSync(fd)
  }
}
export function loadUserTheme(directory: string, name: string): BrandPalette {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error("Invalid theme name")
  const raw = JSON.parse(boundedLocalBytes(join(directory, "themes", `${name}.json`), 65536).toString("utf8"))
  if (
    !raw ||
    !["dark", "light"].includes(raw.extends) ||
    !raw.colors ||
    typeof raw.colors !== "object" ||
    Array.isArray(raw.colors)
  )
    throw new Error("Theme needs extends: dark/light and a colors object")
  const palette = { ...brandThemes[raw.extends as "dark" | "light"] }
  for (const [key, value] of Object.entries(raw.colors)) {
    if (!Object.hasOwn(palette, key) || typeof value !== "string" || !/^#[\da-fA-F]{6}$/.test(value))
      throw new Error(`Invalid theme color ${key}`)
    palette[key as keyof BrandPalette] = value
  }
  return palette
}
