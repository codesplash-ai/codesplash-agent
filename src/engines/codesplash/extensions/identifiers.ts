import { createHash } from "node:crypto"

export function extensionToolId(id: string, name: string): string {
  return `ext_${id}_${createHash("sha256").update(name).digest("hex").slice(0, 24)}`
}
export function extensionModelId(id: string, provider: string, model: string): string {
  return `ext_${id}_${provider}/${model}`
}
