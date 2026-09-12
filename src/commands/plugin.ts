import { dirname, join, resolve } from "node:path"
import { editConfigSource, isTable, readConfigSource } from "../core/config/source.ts"
import { configDirectory, configFilePath, dataDirectory, loadConfig } from "../core/config.ts"
import { PLUGIN_ID, validatePlugins } from "../engines/codesplash/plugins/config.ts"
import { readPluginManifest } from "../engines/codesplash/plugins/manifest.ts"
import { pluginComponentId } from "../engines/codesplash/plugins/resolve.ts"
import {
  describeScripts,
  marketplaceSource,
  pluginPermitted,
  readMarketplace,
  readVersionLock,
  stagePackage,
  verifySelection,
} from "../engines/codesplash/plugins/store.ts"
import { redactConfigValue } from "./config.ts"
import { UsageError } from "./usage-error.ts"

const USAGE = `Usage: codesplash plugin install SOURCE|list|show ID|enable ID|disable ID|remove ID|update ID [SOURCE]|validate SOURCE|rollback ID HASH|build ID --fingerprint HASH -- COMMAND [ARGS]
       codesplash plugin marketplace add SOURCE|list|show ID|update ID [SOURCE]|remove ID
Options: --scope user|project --path DIR --registry URL --allow-loopback --json
Installations are disabled. Enable, review native component fingerprints, and trust each executable component before activation. /plugins reload admits a reviewed generation at idle. Build executes reviewed code with host privileges; --fingerprint is mandatory.
`
export async function runPluginCommand(
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv
    cwd?: string
    output?: (text: string) => void
    signal?: AbortSignal
  } = {},
): Promise<number> {
  const env = options.env ?? process.env,
    output = options.output ?? ((text: string) => process.stdout.write(text))
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    output(USAGE)
    return 0
  }
  const positional: string[] = [],
    flags: Record<string, string> = {},
    argv: string[] = []
  let allowLoopback = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--") {
      argv.push(...args.slice(i + 1))
      break
    }
    if (arg === "--json") continue
    if (arg === "--allow-loopback") {
      allowLoopback = true
      continue
    }
    if (["--scope", "--path", "--registry", "--fingerprint"].includes(arg)) {
      if (!args[i + 1] || flags[arg]) throw new UsageError(USAGE)
      flags[arg] = args[++i]!
    } else if (arg.startsWith("-")) throw new UsageError(USAGE)
    else positional.push(arg)
  }
  const marketplace = positional[0] === "marketplace"
  if (marketplace) positional.shift()
  const [action = "list", subject, source, ...extra] = positional
  const scope = flags["--scope"] ?? "user",
    cwd = resolve(flags["--path"] ?? options.cwd ?? process.cwd()),
    kind = marketplace ? "marketplaces" : "entries"
  if (
    extra.length ||
    !["user", "project"].includes(scope) ||
    !(
      marketplace
        ? ["add", "list", "show", "update", "remove"]
        : [
            "install",
            "list",
            "show",
            "enable",
            "disable",
            "remove",
            "update",
            "validate",
            "rollback",
            "build",
          ]
    ).includes(action) ||
    (action === "list" ? !!subject : !subject) ||
    (source && !["update", "rollback"].includes(action)) ||
    (argv.length && action !== "build") ||
    (flags["--fingerprint"] && action !== "build")
  )
    throw new UsageError(USAGE)
  const path =
    scope === "user" ? configFilePath(configDirectory(env)) : join(cwd, ".codesplash", "config.toml")
  const original = readConfigSource(path),
    selections = validatePlugins(original.raw.plugins ?? {})
  const config = await loadConfig(configFilePath(configDirectory(env)), [], {
    cwd,
    env,
    inspectPlugins: true,
  })
  const emit = (value: unknown) => output(`${JSON.stringify(redactConfigValue(value, env), null, 2)}\n`)
  const selected = subject ? selections[kind][subject] : undefined
  const edit = (operation: (plugins: Record<string, unknown>) => void) =>
    editConfigSource(
      path,
      (raw) => {
        raw.plugins ??= {}
        if (!isTable(raw.plugins)) throw new Error("Invalid plugin configuration")
        operation(raw.plugins)
        validatePlugins(raw.plugins)
      },
      original.fingerprint,
    )
  if (action === "list") {
    emit({
      scope,
      selections: selections[kind],
      pending: selections.pending,
      diagnostics: config.resolution?.diagnostics,
    })
    return 0
  }
  if (
    ["show", "enable", "disable", "remove", "update", "rollback", "build"].includes(action) &&
    (!subject || !PLUGIN_ID.test(subject) || !selected)
  )
    throw new UsageError("Unknown plugin/marketplace in selected scope")
  if (["show", "enable", "disable", "remove"].includes(action)) {
    if (action === "show" || action === "enable") {
      pluginPermitted(config, subject!, selected!.integrity, marketplace)
      const lock = await verifySelection(selected!, marketplace ? "marketplace" : "plugin")
      if (marketplace)
        emit({ selection: selected, lock, manifest: readMarketplace(selected!.root), executesCode: false })
      else {
        const manifest = readPluginManifest(selected!.root)
        emit({
          selection: selected,
          lock,
          manifest,
          scripts: describeScripts(selected!.root),
          components: Object.fromEntries(
            (["extensions", "hooks", "mcp"] as const).map((key) => [
              key,
              Object.keys(manifest[key]).map((id) => ({
                name: id,
                id: pluginComponentId(
                  subject!,
                  key === "extensions" ? "extension" : key === "hooks" ? "hook" : "mcp",
                  id,
                ),
              })),
            ]),
          ),
          inactiveAgents: manifest.agents,
          trust:
            "Enable, then use native extensions/hooks/mcp show and fingerprint trust. Enabling does not execute code.",
        })
      }
    }
    if (action !== "show")
      edit((raw) => {
        if (!isTable(raw[kind])) throw new Error("Missing selections")
        if (action === "remove") delete raw[kind][subject!]
        else (raw[kind][subject!] as Record<string, unknown>).enabled = action === "enable"
      })
    if (action !== "show")
      emit({
        action,
        id: subject,
        retained:
          "Immutable versions, credentials and session state remain available to existing owners. Reload or open a new session to activate the selection.",
      })
    return 0
  }
  if (action === "rollback") {
    if (!source || !/^[a-f0-9]{64}$/.test(source))
      throw new UsageError("Rollback requires a retained integrity hash")
    const root = join(dirname(dirname(selected!.root)), source, "package")
    const lock = (await import("../core/session/files.ts")).json<
      import("../engines/codesplash/plugins/store.ts").PluginLock
    >(join(dirname(root), "lock.json"))
    const candidate = { root, integrity: source, source: lock.source, enabled: false }
    await verifySelection(candidate)
    if (lock.id !== subject) throw new Error("Rollback version belongs to a different plugin")
    pluginPermitted(config, subject!, source)
    edit((raw) => {
      ;(raw.entries as Record<string, unknown>)[subject!] = candidate
    })
    emit({ action, selection: candidate })
    return 0
  }
  let target = action === "update" ? (source ?? selected!.source) : subject!
  if (action === "install" && selections.pending?.[target]) target = selections.pending[target]!.source
  const reference = /^([a-z][a-z0-9_-]{0,31})@([a-z][a-z0-9_-]{0,31})$/.exec(target)
  if (!marketplace && reference) {
    const market = config.plugins?.marketplaces[reference[2]!]
    if (!market) throw new Error("Unknown marketplace")
    pluginPermitted(config, reference[2]!, market.integrity, true)
    target = await marketplaceSource(market, reference[1]!)
  }
  if (action === "build" && (!argv.length || !flags["--fingerprint"]))
    throw new UsageError("Build requires --fingerprint HASH -- COMMAND [ARGS]")
  const staged = await stagePackage(dataDirectory(env), target, marketplace ? "marketplace" : "plugin", {
    constraints: config.resolution?.constraints,
    registry:
      flags["--registry"] ??
      (action === "update" && selected
        ? readVersionLock(selected, marketplace ? "marketplace" : "plugin").registry
        : undefined),
    allowLoopback,
    signal: options.signal,
    ...(action === "build"
      ? {
          build: {
            selection: selected as import("../engines/codesplash/plugins/config.ts").PluginSelection,
            fingerprint: flags["--fingerprint"]!,
            command: argv,
          },
        }
      : {}),
  })
  if (
    (["update", "build"].includes(action) && staged.id !== subject) ||
    (reference && staged.id !== reference[1])
  )
    throw new Error("Plugin source identifier changed; previous selection retained")
  pluginPermitted(config, staged.id, staged.selection.integrity, marketplace)
  if (action !== "validate") {
    if (["install", "add"].includes(action) && selections[kind][staged.id])
      throw new Error("Already installed; use update")
    edit((raw) => {
      raw[kind] ??= {}
      const selection: Record<string, unknown> = { ...staged.selection }
      if (marketplace) delete selection.enabled
      ;(raw[kind] as Record<string, unknown>)[staged.id] = selection
    })
  }
  emit({
    action,
    ...staged,
    installed: action !== "validate",
    message:
      "No lifecycle scripts executed during installation. Executable components require separate fingerprint review. Enabled, verified agent definitions use native child admission.",
  })
  return 0
}
