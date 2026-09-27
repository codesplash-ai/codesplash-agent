import { createHash } from "node:crypto"

export function extensionToolId(id: string, name: string, version?: string): string {
  return `ext_${id}_${createHash("sha256")
    .update(version === undefined ? name : `${name}@${toolVersion(version)}`)
    .digest("hex")
    .slice(0, 24)}`
}
export function extensionModelId(id: string, provider: string, model: string): string {
  return `ext_${id}_${provider}/${model}`
}

export function toolVersion(value: string): string {
  if (!/^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/.test(value))
    throw new Error("Tool version must be an exact major.minor.patch version")
  return value
}
