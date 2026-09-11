import { join } from "node:path"
import type { ConfigSource, ManagedConstraints } from "../../../core/config/contracts.ts"
import { stableValue } from "../../../core/config/source.ts"
import type { AgentConfig } from "../../../core/config.ts"
import { digest } from "../../../core/session/files.ts"
import type { PluginConfig } from "./config.ts"
import { readPluginManifest } from "./manifest.ts"
import { pluginPermitted, verifySelection } from "./store.ts"
export type PluginResourceRoot = {
  id: string
  root: string
  integrity: string
  source: string
  paths: string[]
}
export const pluginComponentId = (plugin: string, kind: string, id: string) =>
  `p_${digest(`${plugin}/${kind}/${id}`).slice(0, 28)}`
export async function pluginLayers(
  plugins: PluginConfig | undefined,
  constraints: ManagedConstraints,
): Promise<{
  sources: Array<{ source: ConfigSource; raw: Record<string, unknown> }>
  resources: PluginResourceRoot[]
}> {
  const sources: Array<{ source: ConfigSource; raw: Record<string, unknown> }> = [],
    resources: PluginResourceRoot[] = []
  for (const [id, selection] of Object.entries(plugins?.entries ?? {})) {
    if (!selection.enabled) continue
    pluginPermitted({ resolution: { constraints } } as AgentConfig, id, selection.integrity)
    const lock = await verifySelection(selection)
    if (lock.id !== id) throw new Error("Plugin identifier differs from its selected lock")
    const manifest = readPluginManifest(selection.root),
      root = selection.root
    const qualify = (component: Record<string, unknown>) => {
      const value = structuredClone(component)
      value.enabled = true
      if (typeof value.command === "string") {
        if (value.command.includes("/"))
          value.command = join(
            root,
            value.command.startsWith("${PLUGIN_ROOT}/") ? value.command.slice(15) : value.command,
          )
        value.args = ((value.args ?? []) as string[]).map((arg) =>
          arg.startsWith("${PLUGIN_ROOT}/") ? join(root, arg.slice(15)) : arg,
        )
        value.trustFiles = [root]
      }
      if (value.transport === "http" || value.transport === "sse") {
        delete value.args
        delete value.environment
        delete value.trustFiles
      }
      if (value.transport === "stdio") delete value.allowLoopback
      return value
    }
    const extensions = Object.fromEntries(
      Object.entries(manifest.extensions).map(([name, entry]) => [
        pluginComponentId(id, "extension", name),
        { ...entry, root, enabled: true },
      ]),
    )
    const hooks = Object.fromEntries(
      Object.entries(manifest.hooks).map(([name, entry]) => [
        pluginComponentId(id, "hook", name),
        qualify(entry),
      ]),
    )
    const mcp = Object.fromEntries(
      Object.entries(manifest.mcp).map(([name, entry]) => [
        pluginComponentId(id, "mcp", name),
        qualify(entry),
      ]),
    )
    const raw: Record<string, unknown> = {}
    if (Object.keys(extensions).length) raw.extensions = { entries: extensions }
    if (Object.keys(hooks).length) raw.hooks = { handlers: hooks }
    if (Object.keys(mcp).length) raw.mcp = { servers: mcp }
    sources.push({
      source: {
        id: `plugin:${id}`,
        scope: "plugin",
        path: root,
        fingerprint: digest(stableValue({ selection, manifest })),
      },
      raw,
    })
    resources.push({
      id,
      root,
      integrity: selection.integrity,
      source: selection.source,
      paths: [...manifest.skills, ...manifest.commands],
    })
  }
  return { sources, resources }
}
