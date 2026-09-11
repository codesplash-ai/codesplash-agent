import { join } from "node:path"
import { checkConfigBounds, isTable } from "../../../core/config/source.ts"
import { json } from "../../../core/session/files.ts"
import { type ExtensionEntry, validateExtensions } from "../extensions/config.ts"
import { type HookHandlerConfig, validateHookConfig } from "../hooks/config.ts"
import { type McpServerConfig, validateMcpConfig } from "../mcp/config.ts"
import { PLUGIN_ID } from "./config.ts"
import { packagePath } from "./files.ts"
export type PluginManifest = {
  schemaVersion: 1
  api: 1
  id: string
  version: string
  description: string
  skills: string[]
  commands: string[]
  agents: string[]
  extensions: Record<string, Omit<ExtensionEntry, "root">>
  hooks: Record<string, HookHandlerConfig>
  mcp: Record<string, McpServerConfig>
}
export function readPluginManifest(root: string): PluginManifest {
  return validateManifest(json(join(root, "codesplash-plugin.json"), 128 * 1024), root)
}
export function validateManifest(raw: unknown, root: string): PluginManifest {
  checkConfigBounds(raw)
  if (
    !isTable(raw) ||
    raw.schemaVersion !== 1 ||
    raw.api !== 1 ||
    typeof raw.id !== "string" ||
    !PLUGIN_ID.test(raw.id) ||
    typeof raw.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(raw.version)
  )
    throw new Error("Plugin requires schemaVersion/API 1, id and exact semantic version")
  if ("lsp" in raw)
    throw new Error("Plugin LSP components are unsupported; agent definitions are inactive until M7")
  if (
    Object.keys(raw).some(
      (key) =>
        ![
          "schemaVersion",
          "api",
          "id",
          "version",
          "description",
          "skills",
          "commands",
          "agents",
          "extensions",
          "hooks",
          "mcp",
        ].includes(key),
    )
  )
    throw new Error("Unknown plugin manifest field")
  if (raw.description !== undefined && (typeof raw.description !== "string" || raw.description.length > 4096))
    throw new Error("Invalid plugin description")
  const paths = (kind: "skills" | "commands" | "agents") => {
    const value = raw[kind] ?? []
    if (!Array.isArray(value) || value.length > 128) throw new Error("Invalid plugin component paths")
    const list = value.map(packagePath)
    if (
      new Set(list).size !== list.length ||
      list.some(
        (path) =>
          !(
            kind === "skills"
              ? /^skills\/[a-z0-9-]+\/SKILL\.md$/
              : kind === "commands"
                ? /^commands\/[a-z0-9-]+\.md$/
                : /^agents\/[a-z0-9-]+\.md$/
          ).test(path),
      )
    )
      throw new Error("Plugin resources must use fixed named component directories")
    return list
  }
  const ext = raw.extensions ?? {}
  if (!isTable(ext)) throw new Error("Invalid plugin extensions")
  const extensions = validateExtensions({
    entries: Object.fromEntries(
      Object.entries(ext).map(([id, value]) => {
        if (!isTable(value) || "root" in value || "enabled" in value)
          throw new Error("Plugin extension root is owned by the package")
        return [id, { ...value, root, enabled: true }]
      }),
    ),
  }).entries
  for (const section of [raw.hooks, raw.mcp])
    if (isTable(section))
      for (const value of Object.values(section))
        if (isTable(value) && "enabled" in value)
          throw new Error(
            "Plugin component activation belongs to the plugin selection; omit enabled from its manifest",
          )
  const hooks = validateHookConfig({ handlers: raw.hooks ?? {} }).handlers
  const mcp = validateMcpConfig({ servers: raw.mcp ?? {} }).servers
  for (const component of [...Object.values(hooks), ...Object.values(mcp)]) {
    if (component.command) {
      if (component.command.includes("/"))
        packagePath(
          component.command.startsWith("${PLUGIN_ROOT}/") ? component.command.slice(15) : component.command,
        )
      for (const path of component.trustFiles ?? []) packagePath(path)
      for (const arg of component.args ?? [])
        if (arg.startsWith("${PLUGIN_ROOT}/")) packagePath(arg.slice(15))
    }
  }
  return {
    schemaVersion: 1,
    api: 1,
    id: raw.id,
    version: raw.version,
    description: (raw.description as string) ?? "",
    skills: paths("skills"),
    commands: paths("commands"),
    agents: paths("agents"),
    extensions,
    hooks,
    mcp,
  }
}
