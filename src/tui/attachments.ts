/**
 * Pulls image file paths out of a composer prompt so they ride to the engine as attachments.
 * Terminals insert dropped files as (possibly quoted or backslash-escaped) paths; each extracted
 * path is replaced with an inline "[image: name]" marker so the transcript records what was sent.
 */
import { statSync } from "node:fs"
import { basename } from "node:path"

export const SUPPORTED_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
])

/** Multi-megabyte images stall the stdio transport long before any provider limit applies. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

export type PathProbe = (path: string) => { exists: boolean; size: number }

export type ExtractedComposerInput = {
  text: string
  images: string[]
  warnings: string[]
}

const defaultProbe: PathProbe = (path) => {
  try {
    const stats = statSync(path)
    return { exists: stats.isFile(), size: stats.size }
  } catch {
    return { exists: false, size: 0 }
  }
}

// Quoted tokens (how terminals insert dropped paths containing spaces), then bare tokens
// where backslash-escaped characters (e.g. "\ ") do not end the token.
const tokenPattern = /'((?:[^'\\]|\\.)+)'|"((?:[^"\\]|\\.)+)"|((?:\\.|\S)+)/g

export function imageExtension(path: string): string | undefined {
  const dot = path.lastIndexOf(".")
  if (dot < 0) return undefined
  const extension = path.slice(dot).toLowerCase()
  return SUPPORTED_IMAGE_EXTENSIONS.has(extension) ? extension : undefined
}

export function extractImageAttachments(
  raw: string,
  probe: PathProbe = defaultProbe,
): ExtractedComposerInput {
  const images: string[] = []
  const warnings: string[] = []
  const text = raw.replace(tokenPattern, (match, single, double, bare) => {
    const candidate = String(single ?? double ?? bare ?? "").replace(/\\(.)/g, "$1")
    if (!imageExtension(candidate)) return match
    const { exists, size } = probe(candidate)
    if (!exists) return match
    if (size > MAX_IMAGE_BYTES) {
      const limit = Math.round(MAX_IMAGE_BYTES / 1024 / 1024)
      warnings.push(`${basename(candidate)} is over ${limit}MB — kept as text, not attached`)
      return match
    }
    images.push(candidate)
    return `[image: ${basename(candidate)}]`
  })
  return { text: text.trim(), images, warnings }
}
