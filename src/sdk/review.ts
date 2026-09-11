import { realpath } from "node:fs/promises"
import { dataDirectory, loadConfig } from "../core/config.ts"
import { reviewExtension, trustExtension } from "../engines/codesplash/extensions/trust.ts"
import { reviewHook, trustHook } from "../engines/codesplash/hooks/trust.ts"
import { recordMcpTrust, reviewMcpServer } from "../engines/codesplash/mcp/trust.ts"
import type { IntegrationOptions } from "./types.ts"

export async function configuration(options: IntegrationOptions) {
  const cwd = await realpath(options.cwd ?? process.cwd())
  const dataDir = options.trustDataDirectory ?? dataDirectory()
  const config = await loadConfig(options.config?.path, options.config?.overrides, {
    cwd,
    profile: options.config?.profile,
    workspaceTrusted: options.workspaceTrusted ?? false,
    dataDir,
  })
  return { cwd, dataDir, config }
}
export async function review(options: IntegrationOptions, kind: "mcp" | "hook" | "extension", id: string) {
  const { cwd, config } = await configuration(options)
  if (kind === "mcp") return reviewMcpServer(config, id, cwd)
  if (kind === "hook") return reviewHook(config, id, cwd)
  if (kind === "extension") return reviewExtension(config, id, cwd)
  throw new Error("Unknown integration kind")
}
export async function trust(
  options: IntegrationOptions,
  kind: "mcp" | "hook" | "extension",
  id: string,
  fingerprint: string,
) {
  const { cwd, config, dataDir } = await configuration(options)
  if (kind === "mcp") return recordMcpTrust(dataDir, await reviewMcpServer(config, id, cwd), fingerprint)
  if (kind === "hook") return trustHook(dataDir, await reviewHook(config, id, cwd), fingerprint)
  if (kind === "extension")
    return trustExtension(dataDir, await reviewExtension(config, id, cwd), fingerprint)
  throw new Error("Unknown integration kind")
}
