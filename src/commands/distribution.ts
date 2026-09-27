import { existsSync } from "node:fs"
import { join } from "node:path"
import { configDirectory } from "../core/config.ts"
import { readFleetSources, refreshFleet } from "../core/distribution/fleet.ts"
import { PackageUpdateManager } from "../core/distribution/package-update.ts"
import { detectInstallMethod, readUpdateSettings, UpdateManager } from "../core/distribution/update.ts"
import {
  featureAnnouncements,
  featurePreferences,
  featureRegistry,
  resolveFeatures,
  setFeature,
} from "../core/features.ts"
import { atomic, lease } from "../core/session/files.ts"
import { UsageError } from "./usage-error.ts"
export async function runDistributionCommand(command: string, args: string[]): Promise<number> {
  const root = configDirectory()
  let result: unknown
  if (command === "features") {
    const [action = "list", name, setting, ...rest] = args
    if (action === "list" && !name)
      result = {
        version: 1,
        features: Object.values(featureRegistry),
        enabled: resolveFeatures(),
        preferences: featurePreferences(),
      }
    else if (action === "announcements" && !name) result = featureAnnouncements()
    else if (
      action === "set" &&
      name &&
      ["on", "off", "default"].includes(setting ?? "") &&
      rest.length === 1 &&
      rest[0] === "--apply"
    ) {
      setFeature(name, setting === "default" ? undefined : setting === "on")
      result = { enabled: resolveFeatures() }
    } else if (
      (action === "dismiss" && name && setting === "--apply" && !rest.length) ||
      (action === "campaigns" && ["on", "off"].includes(name ?? "") && setting === "--apply" && !rest.length)
    ) {
      const release = lease(root, "features.lease")
      try {
        const state = featurePreferences(root)
        if (action === "campaigns") state.campaigns = name === "on"
        else {
          if (!/^[\w.-]{1,128}$/.test(name!)) throw new UsageError("Invalid announcement id")
          state.dismissed = [...new Set([...state.dismissed, name!])].slice(-128)
        }
        atomic(join(root, "features.json"), JSON.stringify(state))
      } finally {
        release()
      }
      result = { updated: true }
    } else if (action === "--help")
      result = {
        usage:
          "features list | announcements | set NAME on|off|default --apply | dismiss ID --apply | campaigns on|off --apply",
      }
    else throw new UsageError("Use features --help")
  } else if (command === "fleet") {
    if (!args.length || (args.length === 1 && args[0] === "status"))
      result = readFleetSources(root, undefined, false).map((source) => ({
        path: source.path,
        fingerprint: source.fingerprint,
        revision: source.payload.revision,
        expiresAt: source.payload.expiresAt,
        versions: source.payload.versions,
      }))
    else if (args[0] === "refresh" && args[1] && args[2] === "--apply" && args.length === 3)
      result = await refreshFleet(args[1])
    else if (args[0] === "--help") result = { usage: "fleet status | refresh TRUST_DESCRIPTOR --apply" }
    else throw new UsageError("Use fleet --help")
  } else {
    const parts = [...args]
    const index = parts.indexOf("--config")
    let path = join(root, "updates.json")
    if (index >= 0) {
      if (!parts[index + 1]) throw new UsageError("--config requires a settings file")
      path = parts[index + 1]!
      parts.splice(index, 2)
    }
    const [action = "status", flag, apply] = parts
    if (action === "--help")
      result = {
        usage:
          "update [status|check|apply --apply|rollback --apply|recover --finish|--rollback --apply] [--config FILE]",
        installMethod: detectInstallMethod(),
      }
    else if (action === "status" && !flag && !existsSync(path))
      result = {
        installMethod: detectInstallMethod(),
        configured: false,
        setup:
          "Create reviewed updates.json with pinned signing keys, manifestUrl, policy, dedicated root and configPath; package-manager installations retain their package manager",
      }
    else {
      const settings = readUpdateSettings(path)
      const installed = detectInstallMethod()
      if (
        ["apply", "rollback", "recover"].includes(action) &&
        ["npm", "homebrew", "scoop"].includes(installed) &&
        settings.manager?.kind !== installed
      )
        throw new UsageError(
          `This ${installed} installation requires a matching package-manager update configuration`,
        )
      const manager = settings.manager ? new PackageUpdateManager(settings) : new UpdateManager(settings)
      if (action === "status" && parts.length <= 1) result = manager.status()
      else if (action === "check" && parts.length === 1) {
        const candidate = await new UpdateManager(settings).inspect()
        result = {
          release: candidate.manifest.release,
          target: candidate.manifest.target,
          files: candidate.manifest.files.length,
          fingerprint: candidate.fingerprint,
        }
      } else if ((action === "apply" || action === "rollback") && flag === "--apply" && parts.length === 2)
        result = action === "apply" ? await manager.apply() : await manager.rollback()
      else if (
        action === "recover" &&
        ["--finish", "--rollback"].includes(flag ?? "") &&
        apply === "--apply" &&
        parts.length === 3
      )
        result = await manager.recover(flag === "--rollback")
      else throw new UsageError("Use update --help; mutations require --apply")
    }
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n")
  return 0
}
