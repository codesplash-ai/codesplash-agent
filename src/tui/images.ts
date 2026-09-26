import { writeSync } from "node:fs"
import { basename, resolve } from "node:path"
import { imageInfo } from "@opentui/core"
import { boundedLocalBytes } from "./themes.ts"

export function readPreviewImage(path: string, cwd: string): { name: string; bytes: Uint8Array } {
  const resolved = resolve(cwd, path)
  const bytes = boundedLocalBytes(resolved, 8 * 1024 * 1024)
  const info = imageInfo(bytes)
  if (info.width * info.height > 16_000_000) throw new Error("Image preview exceeds 16 megapixels")
  return { name: basename(resolved), bytes }
}
export function itermImageSequence(name: string, bytes: Uint8Array): string {
  if (bytes.length > 8 * 1024 * 1024) throw new Error("Image exceeds 8 MiB")
  return `\x1b]1337;File=name=${Buffer.from(name).toString("base64")};size=${bytes.length};width=80;height=20;preserveAspectRatio=1;inline=1:${Buffer.from(bytes).toString("base64")}\x07\n`
}
export function showItermImage(
  renderer: { suspend(): void; resume(): void },
  name: string,
  bytes: Uint8Array,
  write = (text: string) => {
    writeSync(process.stdout.fd, text)
  },
): void {
  const sequence = itermImageSequence(name, bytes)
  renderer.suspend()
  try {
    write(sequence)
  } finally {
    renderer.resume()
  }
}
