import { resolve } from "node:path"
import { bytes, digest } from "../../../core/session/files.ts"
import { type AttachmentReference, attachmentIdentity } from "../../../core/session/input-queue.ts"
import type { ImageBlock } from "../contracts.ts"
import type { ContextToolRunner } from "./contracts.ts"

export async function readAttachedImage(
  image: string,
  cwd: string,
  run: ContextToolRunner,
  signal: AbortSignal,
  references: readonly AttachmentReference[] = [],
): Promise<{ block: ImageBlock; source: string; hash: string }> {
  let value: Buffer, source: string, declared: string | undefined
  const inline = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(image)
  if (inline) {
    source = `ephemeral:${digest(image)}`
    declared = inline[1]
    if ((inline[2]?.length ?? 0) > 12 * 1024 * 1024) throw new Error("Image exceeds 8 MiB")
    value = Buffer.from(inline[2] ?? "", "base64")
  } else {
    if (/^(data:|https?:)/.test(image))
      throw new Error("Native image input requires a supported local image or base64 data URI")
    source = resolve(cwd, image)
    const expected =
      references.find((ref) => ref.source === source)?.fingerprint ?? attachmentIdentity(source)?.fingerprint
    const gate = await run("attachment_access", { path: source })
    if (gate.isError) throw new Error(gate.text)
    signal.throwIfAborted()
    if (!expected || attachmentIdentity(source)?.fingerprint !== expected)
      throw new Error("Image changed before its authorized read")
    value = bytes(source, 8 * 1024 * 1024)
    if (attachmentIdentity(source)?.fingerprint !== expected)
      throw new Error("Image changed during its authorized read")
  }
  signal.throwIfAborted()
  if (value.length === 0 || value.length > 8 * 1024 * 1024) throw new Error("Image must contain 1 byte–8 MiB")
  const type = value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : value[0] === 255 && value[1] === 216 && value[2] === 255
      ? "image/jpeg"
      : ["GIF87a", "GIF89a"].includes(value.subarray(0, 6).toString())
        ? "image/gif"
        : value.subarray(0, 4).toString() === "RIFF" && value.subarray(8, 12).toString() === "WEBP"
          ? "image/webp"
          : undefined
  if (!type || (declared && declared !== type))
    throw new Error("Unsupported image signature or MIME mismatch")
  return {
    block: { type: "image", mediaType: type, base64Data: value.toString("base64") },
    source,
    hash: digest(value),
  }
}
