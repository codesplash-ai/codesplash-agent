import { readFile } from "node:fs/promises"
import type { ToolContext, ToolOutcome } from "../contracts.ts"
import { ToolInputError } from "../contracts.ts"

export async function readMedia(
  path: string,
  context: ToolContext,
  offset = 1,
  limit = 10,
): Promise<ToolOutcome | undefined> {
  if (!/\.(pdf|png|jpe?g|gif|webp)$/i.test(path)) return
  const bytes = await readFile(path, { signal: context.signal })
  if (bytes.length > 8 * 1024 * 1024) throw new ToolInputError("Media exceeds 8 MiB")
  if (/\.pdf$/i.test(path)) {
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new ToolInputError("Invalid PDF signature")
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs")
    const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs")
    ;(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = worker
    const task = getDocument({
      data: new Uint8Array(bytes),
      verbosity: 0,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      useWasm: false,
      disableAutoFetch: true,
      disableStream: true,
      enableXfa: false,
      stopAtErrors: true,
    })
    const abort = () => {
      void task.destroy()
    }
    context.signal.addEventListener("abort", abort, { once: true })
    try {
      const pdf = await task.promise
      if (offset < 1 || offset > pdf.numPages) throw new ToolInputError("PDF page offset is out of range")
      const end = Math.min(pdf.numPages, offset + Math.min(limit, 10) - 1),
        parts: string[] = []
      for (let number = offset; number <= end; number++) {
        context.signal.throwIfAborted()
        const page = await pdf.getPage(number),
          content = await page.getTextContent()
        parts.push(
          `[page ${number}]\n${content.items.map((item) => ("str" in item ? item.str : "")).join(" ")}`,
        )
        if (parts.join("\n").length > 50000) break
      }
      const text = context.sanitizeOutput?.(parts.join("\n")) ?? parts.join("\n")
      return {
        text: `PDF pages ${offset}–${end} of ${pdf.numPages}; text extraction (scanned images require image rendering).\n${text.slice(0, 50000)}`,
        label: "Read PDF",
      }
    } finally {
      context.signal.removeEventListener("abort", abort)
      await task.destroy()
    }
  }
  const type = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? "image/jpeg"
      : ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())
        ? "image/gif"
        : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP"
          ? "image/webp"
          : undefined
  if (!type) throw new ToolInputError("Unsupported image signature")
  return {
    text: "Read image attachment",
    label: "Read image",
    images: [{ type: "image", mediaType: type, base64Data: bytes.toString("base64") }],
  }
}
