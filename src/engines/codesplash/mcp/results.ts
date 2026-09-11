import { digest } from "../../../core/session/files.ts"
import type { ImageBlock, ToolOutcome } from "../contracts.ts"
import { readAttachedImage } from "../inputs/images.ts"
import { boundedJson, jsonObject, MCP_FRAME_BYTES } from "./bounds.ts"

/** Preserve typed content and provenance; only validated image bytes become model images. */
export async function materializeMcpResult(
  value: unknown,
  source: { server: string; generation: string; operation: string },
  sanitize: (text: string) => string,
  signal: AbortSignal,
): Promise<ToolOutcome & { images: ImageBlock[] }> {
  boundedJson(value)
  if (!jsonObject(value)) throw new Error("Invalid MCP result")
  const images: ImageBlock[] = []
  let decoded = 0
  const clean = (entry: unknown): unknown => {
    if (typeof entry === "string") return sanitize(entry)
    if (Array.isArray(entry)) return entry.map(clean)
    if (jsonObject(entry))
      return Object.fromEntries(
        Object.entries(entry).map(([key, child]) => {
          if (sanitize(key) !== key) throw new Error("MCP result contains a credential in a field name")
          return [key, clean(child)]
        }),
      )
    return entry
  }
  const binary = (data: unknown): Buffer => {
    if (
      typeof data !== "string" ||
      data.length > 12 * 1024 * 1024 ||
      data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    )
      throw new Error("Invalid MCP base64 content")
    const bytes = Buffer.from(data, "base64")
    if (bytes.toString("base64") !== data) throw new Error("Non-canonical MCP base64 content")
    decoded += bytes.length
    if (!bytes.length || decoded > 8 * 1024 * 1024) throw new Error("MCP decoded content exceeds 8 MiB")
    if (sanitize(bytes.toString("utf8")) !== bytes.toString("utf8"))
      throw new Error("MCP binary content contains a credential and cannot be included")
    return bytes
  }
  const content = async (raw: unknown): Promise<unknown> => {
    signal.throwIfAborted()
    if (!jsonObject(raw)) throw new Error("Invalid MCP content block")
    if (
      raw.type === "image" ||
      (raw.blob !== undefined && typeof raw.mimeType === "string" && raw.mimeType.startsWith("image/"))
    ) {
      const data = binary(raw.blob ?? raw.data)
      if (images.length >= 8 || typeof raw.mimeType !== "string")
        throw new Error("MCP image limit or MIME validation failed")
      const image = await readAttachedImage(
        `data:${raw.mimeType};base64,${data.toString("base64")}`,
        "",
        async () => {
          throw new Error("MCP images cannot read local paths")
        },
        signal,
      )
      images.push(image.block)
      return {
        type: "image",
        mimeType: image.block.mediaType,
        bytes: data.length,
        sha256: digest(data),
        attachedImage: images.length,
        ...(typeof raw.uri === "string" ? { uri: sanitize(raw.uri) } : {}),
      }
    }
    if (raw.type === "resource" && jsonObject(raw.resource))
      return { ...(clean(raw) as object), resource: await content(raw.resource) }
    if (raw.blob !== undefined || raw.type === "audio") {
      const data = binary(raw.blob ?? raw.data)
      // Typed non-image bytes remain retrievable from the ordinary bounded retained-output store.
      return {
        ...(clean(raw) as object),
        ...(raw.blob !== undefined ? { blob: data.toString("base64") } : { data: data.toString("base64") }),
        bytes: data.length,
        sha256: digest(data),
      }
    }
    return clean(raw)
  }
  const key = Array.isArray(value.content)
    ? "content"
    : Array.isArray(value.contents)
      ? "contents"
      : undefined
  if (!key) throw new Error("MCP result omitted its content array")
  const blocks: unknown[] = []
  for (const block of value[key] as unknown[]) blocks.push(await content(block))
  const retained: Record<string, unknown> = {
    source: clean(source),
    result: { ...(clean(value) as object), [key]: blocks },
  }
  return {
    text: boundedJson(retained, MCP_FRAME_BYTES),
    label: sanitize(`MCP ${source.server}: ${source.operation}`),
    isError: value.isError === true,
    images,
  }
}
