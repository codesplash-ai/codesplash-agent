import { parse } from "shell-quote"
import type { HookEventName } from "../core/hooks.ts"
import { digest } from "../core/session/files.ts"
import { safeSessionText } from "../core/session/repository.ts"
import type { TomlTable } from "../core/toml.ts"
import { validateHookConfig } from "../engines/codesplash/hooks/config.ts"
import type { SettingsPreview } from "./import-settings.ts"

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const aliases: Record<string, HookEventName[]> = {
  SessionStart: ["session.start", "session.resume"],
  sessionStart: ["session.start", "session.resume"],
  SessionEnd: ["session.end"],
  sessionEnd: ["session.end"],
  UserPromptSubmit: ["input.admit"],
  beforeSubmitPrompt: ["input.admit"],
  PreToolUse: ["tool.before"],
  preToolUse: ["tool.before"],
  PostToolUse: ["tool.after"],
  postToolUse: ["tool.after"],
  PostToolUseFailure: ["tool.error"],
  postToolUseFailure: ["tool.error"],
  PermissionRequest: ["permission.request"],
  PreCompact: ["compaction.before"],
  preCompact: ["compaction.before"],
  PostCompact: ["compaction.after"],
  Stop: ["turn.stop"],
  stop: ["turn.stop"],
  beforeShellExecution: ["tool.before"],
  afterShellExecution: ["tool.after"],
  beforeReadFile: ["tool.before"],
  afterFileEdit: ["tool.after"],
  beforeMCPExecution: ["tool.before"],
  afterMCPExecution: ["tool.after"],
}
const tools: Record<string, string> = {
  Bash: "bash",
  Read: "read_file",
  Write: "write_file",
  Edit: "edit_file",
  Grep: "grep",
  Glob: "glob",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
}
/** Import declarations only. Foreign execution/output contracts are explicitly not activated. */
export function previewHookSettings(preview: SettingsPreview, raw: unknown, existing: unknown): void {
  const unsupported = (key: string, reason: string) =>
    preview.unsupported.push({ key: safeSessionText(key).slice(0, 128), reason })
  if (!object(raw)) {
    unsupported("hooks", "Expected a hook event table")
    return
  }
  const table = preview.vendor === "codex" && object(raw.events) ? raw.events : raw
  if (table !== raw)
    for (const key of Object.keys(raw))
      if (key !== "events") unsupported(`hooks.${key}`, "Foreign hook approvals/state are not imported")
  const existingHandlers =
    object(existing) && object(existing.hooks) && object(existing.hooks.handlers)
      ? existing.hooks.handlers
      : {}
  let count = Object.keys(existingHandlers).length
  for (const [name, value] of Object.entries(table)) {
    const events = aliases[name]
    if (!events || !Array.isArray(value) || value.length > 64) {
      unsupported(
        `hooks.${name}`,
        "Unsupported foreign event or declaration shape; adapt it to a supported native hook event",
      )
      continue
    }
    for (let groupIndex = 0; groupIndex < value.length; groupIndex++) {
      const group = value[groupIndex]
      if (!object(group)) {
        unsupported(`hooks.${name}.${groupIndex}`, "Invalid hook group")
        continue
      }
      const grouped = "hooks" in group
      if (
        grouped &&
        (!Array.isArray(group.hooks) || Object.keys(group).some((key) => !["hooks", "matcher"].includes(key)))
      ) {
        unsupported(`hooks.${name}.${groupIndex}`, "Unmapped hook group fields")
        continue
      }
      const entries = grouped ? (group.hooks as unknown[]) : [group]
      if (entries.length > 64) {
        unsupported(`hooks.${name}.${groupIndex}`, "Too many hook handlers")
        continue
      }
      for (let index = 0; index < entries.length; index++) {
        const sourceKey = `hooks.${name}.${groupIndex}.${index}`,
          entry = entries[index]
        const report = (reason: string) => unsupported(sourceKey, reason)
        if (
          !object(entry) ||
          Object.keys(entry).some(
            (key) =>
              ![
                "type",
                "command",
                "url",
                "timeout",
                "timeout_sec",
                "async",
                ...(grouped ? [] : ["matcher"]),
              ].includes(key),
          ) ||
          (entry.async !== undefined && entry.async !== false)
        ) {
          report("Unmapped handler, credential, environment, async or capability settings; handler omitted")
          continue
        }
        const kind = entry.type ?? (entry.command ? "command" : undefined)
        if (kind !== "command" && kind !== "http") {
          report(
            "Only literal command and HTTP declarations have mappings; prompt/agent handlers are unsupported",
          )
          continue
        }
        const handler: TomlTable = { kind, enabled: false, events, share: [], once: "never" }
        const matcher = group.matcher
        if (matcher !== undefined && matcher !== "" && matcher !== "*") {
          if (
            typeof matcher !== "string" ||
            !tools[matcher] ||
            !events.every((event) =>
              ["tool.before", "tool.after", "tool.error", "permission.request"].includes(event),
            )
          ) {
            report(
              "Only exact known tool matchers or the all-tools * matcher are mapped; regex/source matchers require review",
            )
            continue
          }
          handler.matchTools = [tools[matcher]]
        }
        if (name.includes("ShellExecution")) handler.matchTools = ["bash"]
        if (name === "beforeReadFile") handler.matchTools = ["read_file"]
        if (name === "afterFileEdit") handler.matchTools = ["write_file", "edit_file", "apply_patch"]
        if (name.includes("MCPExecution")) handler.matchSources = ["mcp:*"]
        try {
          if (kind === "command") {
            if (
              typeof entry.command !== "string" ||
              entry.command.length > 8192 ||
              /[;&|<>`$~*?{}()\n\r]/.test(entry.command) ||
              entry.url !== undefined
            )
              throw new Error("literal")
            const argv = parse(entry.command, () => {
              throw new Error("expansion")
            })
            if (
              !argv.length ||
              argv.some((arg) => typeof arg !== "string") ||
              /^[A-Za-z_][A-Za-z0-9_]*=/.test(String(argv[0]))
            )
              throw new Error("literal")
            handler.command = argv[0] as string
            handler.args = argv.slice(1) as string[]
          } else {
            if (entry.command !== undefined || typeof entry.url !== "string") throw new Error("HTTP")
            handler.url = entry.url
          }
          if (entry.timeout !== undefined && entry.timeout_sec !== undefined) throw new Error("timeout")
          const timeout = entry.timeout_sec ?? entry.timeout
          if (timeout !== undefined) {
            if (typeof timeout !== "number" || !Number.isFinite(timeout)) throw new Error("timeout")
            handler.timeoutMs = Math.ceil(timeout * 1000)
          }
          const id = `import_${digest(`${preview.vendor}\0${sourceKey}`).slice(0, 24)}`
          if (id in existingHandlers || count >= 64) {
            report("Hook id already exists or handler capacity is reached; review manually")
            continue
          }
          validateHookConfig({ handlers: { [id]: handler } })
          if (safeSessionText(JSON.stringify(handler)) !== JSON.stringify(handler))
            throw new Error("sensitive")
          count++
          preview.changes.push({
            sourceKey,
            target: `hooks.handlers.${id}`,
            value: handler,
            effect:
              "Disabled declaration only. Adapt to native version-1 input/output before enabling; foreign hookSpecificOutput, permission decisions, stop blocking, context rewrites and exit behavior are not translated. Sharing is metadata-only; writes/approval/rewrites/continuation require separate native configuration and fingerprint review.",
          })
        } catch {
          report(
            "Handler needs manual literal-argv, destination, timeout or sensitive-value review; no executable values copied",
          )
        }
      }
    }
  }
}
