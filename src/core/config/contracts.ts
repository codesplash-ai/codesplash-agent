import type { PermissionMode, SandboxMode } from "../config.ts"

export type ConfigScope =
  | "remote"
  | "plugin"
  | "defaults"
  | "user"
  | "project"
  | "profile"
  | "environment"
  | "cli"
  | "managed"
export type ConfigSource = {
  id: string
  scope: ConfigScope
  path?: string
  fingerprint: string
  disabledReason?: string
}
export type ManagedConstraints = {
  featureIds?: string[]
  sandboxModes?: SandboxMode[]
  permissionModes?: PermissionMode[]
  deny?: string[]
  allowedHosts?: string[]
  environment?: string[]
  /** Exact server ids and server/tool pairs; an empty ceiling disables all. */
  pluginIds?: string[]
  marketplaceIds?: string[]
  pluginPins?: string[]
  extensionIds?: string[]
  mcpServers?: string[]
  mcpTools?: string[]
  hookHandlers?: string[]
  hookEvents?: string[]
  hooksManagedOnly?: boolean
  required?: Record<string, unknown>
}
export type ConfigResolutionOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  profile?: string
  strict?: boolean
  workspaceTrusted?: boolean
  /** Owned session pin; refreshed only by explicit plugin reload. */
  /** Inert management can detach a damaged package without loading its contributions. */
  inspectPlugins?: boolean
  pluginSnapshot?: import("../../engines/codesplash/plugins/config.ts").PluginConfig
  dataDir?: string
}
export type ConfigResolution = {
  generation: string
  cwd?: string
  profile?: string
  sources: ConfigSource[]
  profiles: string[]
  provenance: Record<string, string[]>
  diagnostics: string[]
  constraints: ManagedConstraints
  /** Invocation context for a fresh cwd resolution; never serialized to user config. */
  request: {
    userPath: string
    overrides: readonly string[]
    options: ConfigResolutionOptions
  }
}
